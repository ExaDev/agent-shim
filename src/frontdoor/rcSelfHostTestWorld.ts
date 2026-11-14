import http from "node:http";

import { HTTP_STATUS } from "../codex/http";
import { serveRouted } from "./pipeline";
import { RC_SELF_HOST_KEEPALIVE_MS, createRcSelfHostSurface, type RcSelfHostCredentialRecord, type RcWebSearchBackend } from "./rcSelfHost";
import type { RcWebFetchOutcome, RcWebFetcher } from "./rcWebFetch";
import type { FrontDoorLaunch } from "./state";
import { followsLaunchFlag } from "../test-helpers";

/** The world the self-hosted surface's tests drive: the surface behind a real loopback HTTP server wired through `serveRouted`, its clock, and the requests and streams a test makes against it. */

/** Where the fake clock starts: any fixed epoch instant, far enough from zero that a computed ISO date never surprises. */
const CLOCK_START_MS = 1_000_000;

/** The width of a UUID's final hyphen-separated group, so minted test ids carry the shape the protocol validates. */
const UUID_TAIL_WIDTH = 12;

/** How long a frame poll waits between checks: loopback delivery is sub-millisecond, so this is generous rather than tuned. */
const POLL_WAIT_MS = 10;

/** How long a stream delivery is given to arrive before the assertions read the collected frames. */
export const DELIVERY_SETTLE_MS = 50;

/** The statuses the shared enum does not name, mirrored from the surface's own constants so the assertions read the status they mean. */
export const HTTP_CONFLICT = 409;
export const HTTP_SERVICE_UNAVAILABLE = 503;

/** How long past the keepalive cadence the keepalive case waits for the frame itself: half a cadence for the door's timer to run late, the frame to be written, and the client to receive and parse it, all on event loops a loaded suite is also using. */
export const KEEPALIVE_DELIVERY_SLACK_MS = RC_SELF_HOST_KEEPALIVE_MS / 2;

/** Headroom past the keepalive cadence for the timer's own tick, on the test timeout of the keepalive case: one whole extra cadence. */
export const KEEPALIVE_TEST_TIMEOUT_MS = RC_SELF_HOST_KEEPALIVE_MS * 2;

/** How many times a frame poll re-checks before giving up: at the poll wait's cadence this is seconds of budget, far past loopback delivery. */
const FRAME_POLL_ATTEMPTS = 200;

/** The presence answer's own refresh hint, the value the protocol's answer carries and the surface promises nothing by. */
export const PRESENCE_REFRESH_SECONDS = 60;

/** Events the worker stream receives in the mark_read case: the read event itself, then one receipt per named client, then the unnamed one. */
export const RECEIPT_FANOUT_EVENTS = 4;

/** How many announcements the presence test's log names a two-client count for: tui-2's arrival, web-1's repeat pulse, and web-1's re-announcement after the clear. */
export const ANNOUNCED_COUNT_LINES_TOTAL = 3;

/** The guard every parsed-answer narrowing goes through, per the codebase's `unknown` discipline. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A short fake bearer of the OAuth kind: kept short of the redaction filter's eight-character suffix on purpose (see the repo's secret-filter notes). */
export const MINTED_OAUTH_TOKEN = "sk-ant-oat1";
export const REFRESH_TOKEN = "selfhost-refresh";
/** The fixed record the surface authenticates against, standing in for a mint. */
export const RECORD: RcSelfHostCredentialRecord = { accessToken: MINTED_OAUTH_TOKEN, refreshToken: REFRESH_TOKEN, organizationUuid: "11111111-1111-4111-8111-111111111111", accountUuid: "22222222-2222-4222-8222-222222222222", identityId: "lab" };

/** A controllable clock, so retention and resume windows are reached without waiting. */
class FakeClock {
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
export const FETCHED_PAGE: Extract<RcWebFetchOutcome, { readonly kind: "fetched" }> = { kind: "fetched", url: "", destinationUrl: "", contentType: "text/html", text: "<html><body>the stand-in page</body></html>" };

/** Builds the surface behind a real loopback HTTP server wired through `serveRouted`, exactly the way the door serves a resolved route. Pass `null` for "no minted credential", and a fetch or search backend to control the web proxies' answers. */
export async function makeWorld(record: RcSelfHostCredentialRecord | null = RECORD, options: Readonly<{ webFetch?: RcWebFetcher; webSearch?: RcWebSearchBackend; launch?: FrontDoorLaunch; launchVersionOf?: (launch: Readonly<FrontDoorLaunch>) => string | undefined }> = {}): Promise<TestWorld> {
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
    ownsLaunch: () => true,
    ownsPeer: async () => await Promise.resolve(true),
    launchVersionOf: options.launchVersionOf ?? (() => undefined),
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
      { resolveRoute: async () => await Promise.resolve({ ok: true, route: surface.route } as const), canonicalProvider: (name) => name, headroomDecision: followsLaunchFlag, responseObservers: [], admit: () => ({ ok: true, headers: { ...request.headers }, ...(options.launch === undefined ? {} : { launch: options.launch }) }), now: clock.now, log: () => undefined },
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

/** One open SSE stream, collecting whatever arrives frame by frame. */
export class SseStream {
  readonly frames: string[] = [];
  // Assigned inside the promise executor, which TypeScript cannot see as definite and cannot prove non-readonly, hence the assertion.
  private server!: http.ClientRequest;
  private readonly opened: Promise<http.IncomingMessage>;
  constructor(port: number, path: string, headers: Readonly<Record<string, string>>) {
    this.opened = new Promise((resolve, reject) => {
      this.server = http.request({ host: "127.0.0.1", port, method: "GET", path, headers: { accept: "text/event-stream", ...headers } }, (response) => {
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          const parts = chunk.split("\n\n");
          for (const part of parts) {
            if (part !== "") {
              this.frames.push(part);
            }
          }
        });
        resolve(response);
      });
      this.server.once("error", reject);
      this.server.end();
    });
  }

  readonly response = async (): Promise<http.IncomingMessage> => await this.opened;

  /** Waits until at least `count` event frames (keepalive comments excluded) have arrived. */
  readonly waitForEvents = async (count: number): Promise<void> => {
    for (let attempt = 0; attempt < FRAME_POLL_ATTEMPTS; attempt += 1) {
      if (this.frames.filter((frame) => frame.startsWith("event:")).length >= count) {
        return;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, POLL_WAIT_MS);
      });
    }
    throw new Error(`only ${String(this.frames.length)} frames arrived, waiting for ${String(count)} events`);
  };

  readonly close = (): void => {
    this.server.destroy();
  };
}
