import * as zlib from "node:zlib";

import type { ResponseBodyObserver, ResponseObserver, RoutedResponseEvent } from "../frontdoor/pipeline";
import { parseProviderPath } from "../frontdoor/route";
import { classifyLimit, rateLimitHeadersOf } from "./rateLimit";
import { createJsonScanner, createSseScanner, type BodyScanner, type ScanResult } from "./scan";
import { USAGE_SCHEMA_VERSION, type UsageRecord } from "./schema";

/** The provider name an OAuth session's requests are recorded under: they go to Claude Code's own API. */
export const ANTHROPIC_PROVIDER = "anthropic";

/** The routes the pipeline answers itself, before any upstream is involved: a refused capability or an unroutable target says nothing about anyone's usage or quota. */
const DOOR_ANSWERED_ROUTES = new Set(["(unauthorized)", "(unrouted)"]);

/** Everything the usage middleware depends on, injected so it runs against fakes in tests. */
export interface UsageMiddlewareDeps {
  /** Persists one finished request's record. It may throw; the middleware catches and logs, so a store failure never reaches a request. */
  readonly record: (record: UsageRecord) => void;
  /** Runs work after the current turn of the event loop, so recording never sits between a route's `end` and whatever the route does next (production: `setImmediate`). */
  readonly defer: (task: () => void) => void;
  readonly now: () => number;
  readonly log: (line: string) => void;
}

/** The scanner a response's content type calls for, or undefined for a body that carries no usage (an empty answer, plain text, an HTML error page). */
function scannerFor(headers: Readonly<Record<string, string>>): BodyScanner | undefined {
  const contentType = headerValue(headers, "content-type")?.toLowerCase() ?? "";
  if (contentType.startsWith("text/event-stream")) {
    return createSseScanner();
  }
  if (contentType.startsWith("application/json")) {
    return createJsonScanner();
  }
  return undefined;
}

/** One header's value whatever case its name arrived in: routes pass the upstream's lowercased names, but a route's own answer may not. */
function headerValue(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) {
      return value;
    }
  }
  return undefined;
}

/** A decompressor for a content coding, or null for an identity body, or undefined for a coding this middleware cannot read (the body is then not scanned, but the request is still recorded). */
function decoderFor(encoding: string | undefined): zlib.Gunzip | zlib.Inflate | zlib.BrotliDecompress | null | undefined {
  switch (encoding?.trim().toLowerCase()) {
    case undefined:
    case "":
    case "identity":
      return null;
    case "gzip":
    case "x-gzip":
      return zlib.createGunzip();
    case "deflate":
      return zlib.createInflate();
    case "br":
      return zlib.createBrotliDecompress();
    default:
      return undefined;
  }
}

/** Where a request went: the provider its path names, or Claude Code's own API for a bare `/v1/` path, and the API path the upstream saw. */
function destinationOf(path: string): { readonly provider: string; readonly endpoint: string } {
  const scoped = parseProviderPath(path);
  return scoped === undefined ? { provider: ANTHROPIC_PROVIDER, endpoint: path } : { provider: scoped.provider, endpoint: scoped.rest };
}

/** Builds one finished request's record from its head, what the body scan found, and how it ended. */
function buildRecord(event: RoutedResponseEvent, context: { readonly headAt: number; readonly endedAt: number; readonly outcome: "completed" | "aborted"; readonly scan: ScanResult | undefined }): UsageRecord {
  const { scan } = context;
  const { provider, endpoint } = destinationOf(event.path);
  const rateLimitHeaders = rateLimitHeadersOf(event.headers);
  const limit = classifyLimit({ status: event.status, headers: rateLimitHeaders ?? {}, error: scan?.error, nowMs: context.endedAt });
  const requestId = headerValue(event.headers, "request-id");
  const { identity, sessionId, projectId } = event.session;
  return {
    schemaVersion: USAGE_SCHEMA_VERSION,
    at: new Date(event.receivedAt).toISOString(),
    ...(identity === undefined ? {} : { identity }),
    provider,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(projectId === undefined ? {} : { project: projectId }),
    route: event.route,
    method: event.method,
    endpoint,
    ...(scan?.model === undefined ? {} : { model: scan.model }),
    status: event.status,
    latencyMs: Math.max(0, Math.round(context.headAt - event.receivedAt)),
    durationMs: Math.max(0, Math.round(context.endedAt - event.receivedAt)),
    outcome: context.outcome,
    ...(scan?.usage === undefined ? {} : { usage: scan.usage }),
    ...(rateLimitHeaders === undefined ? {} : { rateLimitHeaders }),
    ...(limit === undefined ? {} : { limit }),
    ...(requestId === undefined ? {} : { requestId }),
  };
}

/**
 * The usage-tracking response middleware: registered at the front door's hook point, it records one metadata-only `UsageRecord` per routed response once its body has finished. The head gives the status, latency and rate-limit headers; the body, scanned incrementally as the client receives it (decompressing a copy when the upstream compressed it), gives the model and token usage. The response the client receives is never touched: the middleware sees each chunk only after the socket has it, keeps no body, and does its recording on a deferred turn. Every failure (a scanner, a decompressor, the store) is caught and logged, never thrown into the request.
 */
export function createUsageMiddleware(deps: UsageMiddlewareDeps): ResponseObserver {
  return (event) => {
    if (DOOR_ANSWERED_ROUTES.has(event.route)) {
      return undefined;
    }
    const headAt = deps.now();
    const scanner = scannerFor(event.headers);
    const decoder = scanner === undefined ? null : decoderFor(headerValue(event.headers, "content-encoding"));
    /** Whether the scan can still be trusted: a scanner or decompressor failure leaves the record without usage rather than with a wrong one. */
    let scanning = scanner !== undefined && decoder !== undefined;
    const text = new TextDecoder();

    const feed = (bytes: Uint8Array, final: boolean): void => {
      if (!scanning || scanner === undefined) {
        return;
      }
      try {
        scanner.push(text.decode(bytes, { stream: !final }));
      } catch (error) {
        scanning = false;
        deps.log(`usage: body scan failed for ${event.route}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };

    const finish = (outcome: "completed" | "aborted"): void => {
      const endedAt = deps.now();
      deps.defer(() => {
        try {
          deps.record(buildRecord(event, { headAt, endedAt, outcome, scan: scanning && scanner !== undefined ? scanner.result() : undefined }));
        } catch (error) {
          deps.log(`usage: could not record ${event.method} ${event.path} (${String(event.status)}): ${error instanceof Error ? error.message : String(error)}`);
        }
      });
    };

    if (decoder === null || decoder === undefined) {
      return {
        chunk: (bytes) => {
          feed(bytes, false);
        },
        end: (outcome) => {
          feed(new Uint8Array(), true);
          finish(outcome);
        },
      } satisfies ResponseBodyObserver;
    }

    // A compressed body is scanned from a decompressed copy: the original bytes go to the client untouched, and the copy is fed to the decompressor after the socket already has them.
    let ended: "completed" | "aborted" | undefined;
    let settled = false;
    const settle = (): void => {
      if (settled || ended === undefined) {
        return;
      }
      settled = true;
      feed(new Uint8Array(), true);
      finish(ended);
    };
    decoder.on("data", (bytes: Buffer) => {
      feed(bytes, false);
    });
    decoder.on("error", (error: Error) => {
      scanning = false;
      deps.log(`usage: could not decompress the body of ${event.route}: ${error.message}`);
      // A corrupt stream never emits end, so the record is finished from the body's own end instead.
      settle();
    });
    decoder.on("end", settle);
    return {
      chunk: (bytes) => {
        if (scanning) {
          decoder.write(bytes);
        }
      },
      end: (outcome) => {
        ended = outcome;
        if (!scanning || outcome === "aborted") {
          // A body cut short leaves the decompressor waiting for bytes that will never come; what was scanned so far is what the record gets.
          decoder.destroy();
          settle();
          return;
        }
        decoder.end();
      },
    } satisfies ResponseBodyObserver;
  };
}
