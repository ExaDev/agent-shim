import * as zlib from "node:zlib";

import { classifyLimit, rateLimitHeadersOf } from "./rateLimit";
import { createJsonScanner } from "./scan";

const MS_PER_SECOND = 1000;

/** The prefix of Anthropic's unified subscription rate-limit headers. */
const UNIFIED_PREFIX = "anthropic-ratelimit-unified-";

/** The status a refusing upstream answers a spent quota with. */
const TOO_MANY_REQUESTS = 429;

/** The subscription windows a refusal can name, as the real API's `representative-claim` names them, with the infix its per-window headers carry. */
const WINDOW_INFIX = { five_hour: "5h", seven_day: "7d" } as const;

/** A subscription window the real API's refusal can name as the one that binds. */
export type RefusedWindow = keyof typeof WINDOW_INFIX;

/**
 * The headers by which the real API tells its client which window ended the session and when it lifts: the binding window (`representative-claim`), the instant it lifts (`reset`, epoch seconds), `retry-after` as the seconds until then (at least 1) and `x-should-retry: false`, since retrying before the reset cannot succeed. A client that reads them says which limit was reached and when it ends, and stops retrying, where a bare refusal reads as a throttle to retry.
 */
export function exhaustionHeaders(params: { readonly window: RefusedWindow; readonly resetSec: number; readonly nowSec: number }): Record<string, string> {
  return {
    [`${UNIFIED_PREFIX}representative-claim`]: params.window,
    [`${UNIFIED_PREFIX}reset`]: String(params.resetSec),
    "retry-after": String(Math.max(1, params.resetSec - params.nowSec)),
    "x-should-retry": "false",
  };
}

/** The error body a quota refusal's scan reads, or undefined when the body is not decodable here: gzip, deflate and brotli are decoded, anything else is read only when it is not encoded at all. */
function decodedText(body: Uint8Array, encoding: string | undefined): string | undefined {
  try {
    switch (encoding?.trim().toLowerCase()) {
      case undefined:
      case "":
      case "identity":
        return new TextDecoder().decode(body);
      case "gzip":
      case "x-gzip":
        return new TextDecoder().decode(zlib.gunzipSync(body));
      case "deflate":
        return new TextDecoder().decode(zlib.inflateSync(body));
      case "br":
        return new TextDecoder().decode(zlib.brotliDecompressSync(body));
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

/** The window a refusal's message names: a five-hour limit, or a weekly (seven-day) one. Undefined for a message naming neither, such as a monthly limit, which the real API has no window for. */
function windowOfMessage(message: string): RefusedWindow | undefined {
  if (/\b(?:5|five)[\s-]?hours?\b/i.test(message)) {
    return "five_hour";
  }
  if (/\bweek(?:ly)?\b|\b(?:7|seven)[\s-]?days?\b/i.test(message)) {
    return "seven_day";
  }
  return undefined;
}

/** The offset of the clock a z.ai refusal's message tells its reset in: the backend's wall clock is UTC+8 (Asia/Shanghai, which has no daylight saving), not UTC and not the caller's zone. */
const MESSAGE_CLOCK_OFFSET = "+08:00";

/** The instant a refusal's message says the limit resets ("... Your limit will reset at 2026-10-22 23:57:10"), in epoch seconds, read on the backend's clock; undefined when the message gives none. */
function resetOfMessage(message: string): number | undefined {
  const found = /reset at (\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/i.exec(message);
  if (found === null) {
    return undefined;
  }
  const instant = Date.parse(`${found[1] ?? ""}T${found[2] ?? ""}${MESSAGE_CLOCK_OFFSET}`);
  return Number.isNaN(instant) ? undefined : Math.floor(instant / MS_PER_SECOND);
}

/**
 * The headers that turn an http provider's refusal for a spent quota into the form the real API answers one in, or undefined when the response is not such a refusal or does not say enough to translate it.
 *
 * A 429 whose upstream sent none of the unified headers (an upstream that sent them says so itself and is left alone), classified as an exhausted quota (`classifyLimit`: the error's code or type, its message, a bare `rejected`), and whose message names the window it ended (a five-hour or a weekly limit) gets the binding window, its status, its utilisation and its reset, `retry-after` and `x-should-retry: false` (`exhaustionHeaders`). The reset is the response's own `retry-after`, which carries no zone; only a response with none reads it from the message's "will reset at" text, which is wall time on the backend's UTC+8 clock. Where neither is given, or the message names no window, the response is left as the upstream sent it.
 *
 * `body` is the response body as received and `contentEncoding` its `content-encoding`; an error body is small, so the caller holds it whole to ask.
 */
export function quotaRefusalHeaders(params: {
  readonly status: number;
  /** The response's headers, names lowercased. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  readonly nowMs: number;
}): Record<string, string> | undefined {
  const { status, headers, body, nowMs } = params;
  if (status !== TOO_MANY_REQUESTS || Object.keys(headers).some((name) => name.startsWith(UNIFIED_PREFIX))) {
    return undefined;
  }
  const text = decodedText(body, headers["content-encoding"]);
  if (text === undefined) {
    return undefined;
  }
  const scanner = createJsonScanner();
  scanner.push(text);
  const { error } = scanner.result();
  const limit = classifyLimit({ status, headers: rateLimitHeadersOf(headers) ?? {}, error, nowMs });
  const window = error?.message === undefined ? undefined : windowOfMessage(error.message);
  if (limit?.kind !== "quota-exhausted" || error?.message === undefined || window === undefined) {
    return undefined;
  }
  const nowSec = Math.floor(nowMs / MS_PER_SECOND);
  const resetSec = limit.retryAfterSeconds === undefined ? resetOfMessage(error.message) : nowSec + Math.ceil(limit.retryAfterSeconds);
  if (resetSec === undefined) {
    return undefined;
  }
  const infix = WINDOW_INFIX[window];
  return {
    [`${UNIFIED_PREFIX}status`]: "rejected",
    [`${UNIFIED_PREFIX}${infix}-status`]: "rejected",
    [`${UNIFIED_PREFIX}${infix}-utilization`]: "1",
    [`${UNIFIED_PREFIX}${infix}-reset`]: String(resetSec),
    ...exhaustionHeaders({ window, resetSec, nowSec }),
  };
}
