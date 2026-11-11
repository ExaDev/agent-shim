const MESSAGES_BODY_LIMIT_MIB = 128;
const BYTES_PER_KIB = 1024;
const BYTES_PER_MIB = BYTES_PER_KIB * BYTES_PER_KIB;

/**
 * The most bytes of a Messages request body the door reads whole to edit it or to resolve it: the first-party Claude API's documented maximum request size for the Messages endpoint (https://platform.claude.com/docs/en/api/overview, "Request size limits": Messages and Token Counting, 128 MB; the page does not say whether MB is 10^6 or 2^20 bytes, so the larger reading is used and the bound is a memory guard, not a validation). A body past it is refused with a 413 rather than held in memory. A backend with a smaller limit refuses what it cannot take itself.
 */
export const MESSAGES_BODY_LIMIT_BYTES = MESSAGES_BODY_LIMIT_MIB * BYTES_PER_MIB;

/** What the 413 for a Messages request body past `limitBytes` says, the same at every site that refuses one (the editing wrapper and the resolver's two scans): the provider when it is known, the limit in bytes and mebibytes, and what to do about it. */
export function bodyTooLargeMessage(limitBytes: number, provider?: string): string {
  const mebibytes = Number((limitBytes / BYTES_PER_MIB).toFixed(2));
  return `${provider === undefined ? "" : `provider "${provider}": `}the request body is larger than the limit for a Messages request, ${String(limitBytes)} bytes (${String(mebibytes)} MiB); send a smaller body`;
}

/** The Messages endpoints whose bodies carry a model at their top level: the request, and the token count of one. */
const MESSAGES_PATH = /\/v1\/messages(?:\/count_tokens)?$/;

/**
 * Whether a request is a POST to a Messages endpoint: the requests whose body the door reads whole to resolve or edit its model, and so the ones the Messages limit applies to. Any other request (a file upload, a batch) has no top-level model to rewrite and is not read for that purpose: it is forwarded as it arrives, however large its documented limit allows it to be.
 */
export function isMessagesRequest(method: string, pathname: string): boolean {
  return method === "POST" && MESSAGES_PATH.test(pathname);
}

/**
 * Whether a path is a Messages API inference call by the session's reckoning: `/v1/messages` or any sub-resource of it (`count_tokens` and the batch endpoints among them). The paths a session's model choice governs, and so the ones whose main-loop route is recorded and followed. This is deliberately wider than `isMessagesRequest`, which asks whether a body carries a top-level model the door reads whole: a batch is an inference call that a session's route governs, yet its body has no top-level model to resolve or rewrite and is forwarded as it arrives.
 */
export function isMessagesInferencePath(pathname: string): boolean {
  return pathname === "/v1/messages" || pathname.startsWith("/v1/messages/");
}
