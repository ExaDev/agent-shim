import { isRateLimitHeader, type LimitClassification, type QuotaWindow, type UnifiedRateLimit } from "./schema";

/** The HTTP status of a refusal by rate limit or quota. */
const TOO_MANY_REQUESTS = 429;
/** The HTTP status OpenRouter answers when a key's credits are exhausted (its "Limits" documentation: https://openrouter.ai/docs/api-reference/limits). */
const PAYMENT_REQUIRED = 402;

const MS_PER_SECOND = 1000;

/** What a refused response's error body said, as far as classification needs: its machine-readable type and code, and its message, which is read here and never stored. */
export interface ErrorInfo {
  readonly type?: string;
  readonly code?: string;
  readonly message?: string;
}

/** Keeps a response's rate-limit headers (see `isRateLimitHeader`), names lowercased; undefined when there are none. */
export function rateLimitHeadersOf(headers: Readonly<Record<string, string>>): Record<string, string> | undefined {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (isRateLimitHeader(name)) {
      kept[name.toLowerCase()] = value;
    }
  }
  return Object.keys(kept).length === 0 ? undefined : kept;
}

/** An epoch-seconds header value as an ISO instant, or undefined when it is not a positive number. */
function epochSecondsToIso(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * MS_PER_SECOND).toISOString() : undefined;
}

/** A non-negative number header value, or undefined. */
function nonNegativeNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

const UNIFIED_PREFIX = "anthropic-ratelimit-unified-";

/** One unified window (`5h` or `7d`) from its utilisation, reset and status headers, or undefined when none is present. */
function unifiedWindow(headers: Readonly<Record<string, string>>, window: string): QuotaWindow | undefined {
  const utilization = nonNegativeNumber(headers[`${UNIFIED_PREFIX}${window}-utilization`]);
  const resetsAt = epochSecondsToIso(headers[`${UNIFIED_PREFIX}${window}-reset`]);
  const status = headers[`${UNIFIED_PREFIX}${window}-status`];
  if (utilization === undefined && resetsAt === undefined && status === undefined) {
    return undefined;
  }
  return { ...(utilization === undefined ? {} : { utilization }), ...(resetsAt === undefined ? {} : { resetsAt }), ...(status === undefined ? {} : { status }) };
}

/**
 * Parses Anthropic's unified subscription rate-limit headers, from `rateLimitHeadersOf`'s lowercased map. These were captured from a real `api.anthropic.com` response to an OAuth (subscription) session through the front door: `-status`, `-5h-status`, `-5h-utilization` (a fraction), `-5h-reset` (epoch seconds), the same three for `7d`, `-representative-claim`, `-reset`, `-overage-status`, `-overage-disabled-reason`, `-fallback` and `-fallback-percentage`. Undefined when the response carried none of them (an API-key or third-party provider response).
 */
export function parseUnifiedRateLimit(headers: Readonly<Record<string, string>>): UnifiedRateLimit | undefined {
  if (!Object.keys(headers).some((name) => name.startsWith(UNIFIED_PREFIX))) {
    return undefined;
  }
  const status = headers[`${UNIFIED_PREFIX}status`];
  const fiveHour = unifiedWindow(headers, "5h");
  const sevenDay = unifiedWindow(headers, "7d");
  const representativeClaim = headers[`${UNIFIED_PREFIX}representative-claim`];
  const resetAt = epochSecondsToIso(headers[`${UNIFIED_PREFIX}reset`]);
  const overageStatus = headers[`${UNIFIED_PREFIX}overage-status`];
  return {
    ...(status === undefined ? {} : { status }),
    ...(fiveHour === undefined ? {} : { fiveHour }),
    ...(sevenDay === undefined ? {} : { sevenDay }),
    ...(representativeClaim === undefined ? {} : { representativeClaim }),
    ...(resetAt === undefined ? {} : { resetAt }),
    ...(overageStatus === undefined ? {} : { overageStatus }),
  };
}

/** `retry-after` in seconds: either a number of seconds or an HTTP date (RFC 9110 section 10.2.3), measured from `nowMs`. */
function retryAfterSeconds(value: string | undefined, nowMs: number): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const seconds = nonNegativeNumber(value);
  if (seconds !== undefined) {
    return seconds;
  }
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, Math.ceil((date - nowMs) / MS_PER_SECOND));
}

/**
 * Error types and codes that mean the plan's quota is used up rather than a short rate limit:
 *
 * - `usage_limit_reached`: the Codex (ChatGPT plan) backend's refusal when a plan window is exhausted.
 * - `insufficient_quota`: OpenAI-compatible APIs' refusal when the account has no quota left.
 * - z.ai's documented codes (https://docs.z.ai/api-reference/api-code): 1308 and 1310 ("Usage limit reached ... Your limit will reset at ...", "Weekly/Monthly Limit Exhausted"), 1309 (the GLM Coding Plan package expired), 1316 to 1321 (the five-hour or seven-day window used up with no balance, or the monthly spend limit reached). z.ai's 1302 ("Rate limit reached for requests") and 1305 (overloaded) are short limits.
 */
const QUOTA_EXHAUSTED_ERRORS = new Set(["usage_limit_reached", "insufficient_quota", "1308", "1309", "1310", "1316", "1317", "1318", "1319", "1320", "1321"]);

/** Error messages that name an exhausted quota, for an upstream whose type and code say only "rate limit". Read for classification only, never stored. */
const QUOTA_EXHAUSTED_MESSAGE = /usage limit|quota (?:exceeded|exhausted)|limit exhausted|insufficient (?:balance|credits|quota)/i;

/** Whether a header-or-body token is safe to record as evidence: a short machine-readable word, never free text. */
const EVIDENCE_TOKEN = /^[\w.-]{1,64}$/;

/**
 * Classifies a refused response as a short rate limit or an exhausted quota, the distinction the credential fallback acts on (a short limit retries the same credential once its wait has passed, an exhausted quota moves to the next one). Only a 429 or a 402 is classified; anything else is undefined.
 *
 * An exhausted quota is any of: a 402 (OpenRouter's "insufficient credits"); Anthropic's unified status `rejected` with no extra usage to fall back on (`overage-status` absent or `rejected`), the rule Claude Code itself applies before it waits for the plan's reset; an error type or code in `QUOTA_EXHAUSTED_ERRORS`; or an error message naming a usage limit. Every other 429 is a short rate limit. `resetAt` comes from the unified reset header, `retryAfterSeconds` from `retry-after`.
 */
export function classifyLimit(params: {
  readonly status: number;
  /** The response's rate-limit headers, as `rateLimitHeadersOf` returns them. */
  readonly headers: Readonly<Record<string, string>>;
  readonly error: ErrorInfo | undefined;
  readonly nowMs: number;
}): LimitClassification | undefined {
  const { status, headers, error } = params;
  if (status !== TOO_MANY_REQUESTS && status !== PAYMENT_REQUIRED) {
    return undefined;
  }
  const evidence: string[] = [`status=${String(status)}`];
  const unified = parseUnifiedRateLimit(headers);
  const unifiedRejected = unified?.status === "rejected" && (unified.overageStatus === undefined || unified.overageStatus === "rejected");
  if (unified?.status !== undefined) {
    evidence.push(`${UNIFIED_PREFIX}status=${unified.status}`);
  }
  if (unified?.overageStatus !== undefined) {
    evidence.push(`${UNIFIED_PREFIX}overage-status=${unified.overageStatus}`);
  }
  for (const [name, value] of [
    ["error.type", error?.type],
    ["error.code", error?.code],
  ] as const) {
    if (value !== undefined && EVIDENCE_TOKEN.test(value)) {
      evidence.push(`${name}=${value}`);
    }
  }
  const errorExhausted = [error?.type, error?.code].some((value) => value !== undefined && QUOTA_EXHAUSTED_ERRORS.has(value));
  const messageExhausted = error?.message !== undefined && QUOTA_EXHAUSTED_MESSAGE.test(error.message);
  if (messageExhausted) {
    evidence.push("error.message=names a usage limit");
  }
  const exhausted = status === PAYMENT_REQUIRED || unifiedRejected || errorExhausted || messageExhausted;
  const retryAfter = retryAfterSeconds(headers["retry-after"], params.nowMs);
  return {
    kind: exhausted ? "quota-exhausted" : "rate-limited",
    ...(retryAfter === undefined ? {} : { retryAfterSeconds: retryAfter }),
    ...(unified?.resetAt === undefined ? {} : { resetAt: unified.resetAt }),
    ...(unified?.representativeClaim === undefined ? {} : { window: unified.representativeClaim }),
    evidence,
  };
}
