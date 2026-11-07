import http from "node:http";

import { HTTP_STATUS } from "../codex/http";
import { followsLaunchFlag } from "../test-helpers";
import { serveRouted } from "./pipeline";
import { createRcSelfHostSurface, type RcSelfHostCredentialRecord, type RcWebSearchBackend } from "./rcSelfHost";
import type { RcWebFetchOutcome, RcWebFetcher } from "./rcWebFetch";

/**
 * The world the self-hosted Remote Control surface's tests run in: the surface behind a real loopback HTTP server wired through the same `serveRouted` the door hands routes to, a controllable clock, and the helpers that call it and create a session on it.
 */

/** Where the fake clock starts: any fixed epoch instant, far enough from zero that a computed ISO date never surprises. */
export const CLOCK_START_MS = 1_000_000;

/** The width of a UUID's final hyphen-separated group, so minted test ids carry the shape the protocol validates. */
const UUID_TAIL_WIDTH = 12;

/** A short fake bearer of the OAuth kind: kept short of the redaction filter's eight-character suffix on purpose (see the repo's secret-filter notes). */
export const MINTED_OAUTH_TOKEN = "sk-ant-oat1";
export const REFRESH_TOKEN = "selfhost-refresh";
/** The fixed record the surface authenticates against, standing in for a mint. */
export const RECORD: RcSelfHostCredentialRecord = { accessToken: MINTED_OAUTH_TOKEN, refreshToken: REFRESH_TOKEN, organizationUuid: "11111111-1111-4111-8111-111111111111", accountUuid: "22222222-2222-4222-8222-222222222222" };

/** A controllable clock, so retention and resume windows are reached without waiting. */
export class FakeClock {
  private nowMs = CLOCK_START_MS;
  readonly now = (): number => this.nowMs;
  advance(ms: number): void {
    this.nowMs += ms;
  }
}

export interface TestWorld {
  readonly clock: FakeClock;
  readonly surface: ReturnType<typeof createRcSelfHostSurface>;
  readonly server: http.Server;
  readonly port: number;
  /** The URLs the injected fetch was asked for, in arrival order. */
  readonly fetchedUrls: string[];
  /** The surface's own log lines, in arrival order, so a test can assert what the surface recorded. */
  readonly logLines: readonly string[];
  readonly close: () => Promise<void>;
}

/** The fixed outcome the injected fetch answers with unless a test overrides it: a stand-in fetched page. */
export const FETCHED_PAGE = { kind: "fetched", url: "", destinationUrl: "", contentType: "text/html", text: "<html><body>the stand-in page</body></html>" } satisfies RcWebFetchOutcome;

/** Builds the surface behind a real loopback HTTP server wired through `serveRouted`, exactly the way the door serves a resolved route. Pass `null` for "no minted credential", and a fetch or search backend to control the web proxies' answers. */
export async function makeWorld(record: RcSelfHostCredentialRecord | null = RECORD, options: Readonly<{ webFetch?: RcWebFetcher; webSearch?: RcWebSearchBackend }> = {}): Promise<TestWorld> {
  const held: RcSelfHostCredentialRecord | undefined = record ?? undefined;
  const clock = new FakeClock();
  const fetchedUrls: string[] = [];
  const logLines: string[] = [];
  const webFetch: RcWebFetcher = options.webFetch ?? (async (url) => {
    fetchedUrls.push(url);
    return await Promise.resolve({ ...FETCHED_PAGE, url, destinationUrl: url });
  });
  const surface = createRcSelfHostSurface({
    now: clock.now,
    newUuid: (() => {
      let next = 0;
      return () => {
        next += 1;
        return `00000000-0000-4000-8000-${String(next).padStart(UUID_TAIL_WIDTH, "0")}`;
      };
    })(),
    randomToken: () => "random-token-material",
    credentialRecord: () => held,
    webFetch,
    log: (line) => {
      logLines.push(line);
    },
    ...(options.webSearch === undefined ? {} : { webSearch: options.webSearch }),
  });
  const server = http.createServer((request, response) => {
    const abort = new AbortController();
    response.on("close", () => {
      if (!response.writableFinished) {
        abort.abort();
      }
    });
    void serveRouted(
      { method: request.method ?? "GET", url: request.url ?? "/", headers: request.headers, body: request, signal: abort.signal, response },
      { resolveRoute: async () => await Promise.resolve({ ok: true, route: surface.route } as const), canonicalProvider: (name) => name, headroomDecision: followsLaunchFlag, responseObservers: [], admit: () => ({ ok: true, headers: { ...request.headers } }), now: clock.now, log: () => undefined },
    ).catch(() => {
      if (!response.headersSent) {
        response.writeHead(HTTP_STATUS.internalServerError);
        response.end();
      }
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(undefined);
    });
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("expected a bound server");
  }
  return {
    clock,
    surface,
    server,
    port: address.port,
    fetchedUrls,
    logLines,
    close: async () => {
      surface.close();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve(undefined);
        });
        server.closeAllConnections();
      });
    },
  };
}

/** One plain JSON answer from the surface. */
export async function call(port: number, method: string, path: string, body?: unknown, headers: Readonly<Record<string, string>> = {}): Promise<{ readonly status: number; readonly body: string; readonly headers: http.IncomingHttpHeaders }> {
  const text = body === undefined ? undefined : JSON.stringify(body);
  return await new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: { ...(text === undefined ? {} : { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) }), ...headers },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });
        response.on("end", () => {
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), headers: response.headers });
        });
      },
    );
    request.once("error", reject);
    request.end(text ?? "");
  });
}
