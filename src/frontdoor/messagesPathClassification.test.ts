import { describe, expect, it } from "vitest";

import { isMessagesInferencePath, isMessagesRequest } from "./messagesBodyLimit";

/**
 * The two predicates answer different questions and are pinned side by side: `isMessagesRequest` (a POST whose body carries a top-level model the door reads whole) and `isMessagesInferencePath` (an inference call by the session's reckoning, whose route a session's model choice governs). Each row is a pathname as the door sees it after the URL is parsed, so a query is not part of it and a provider scope is.
 */
const TABLE: readonly (readonly [label: string, path: string, method: string, request: boolean, inference: boolean])[] = [
  ["messages", "/v1/messages", "POST", true, true],
  ["messages by GET", "/v1/messages", "GET", false, true],
  ["count_tokens", "/v1/messages/count_tokens", "POST", true, true],
  ["batches", "/v1/messages/batches", "POST", false, true],
  ["a batch result", "/v1/messages/batches/msgbatch_1/results", "POST", false, true],
  ["files", "/v1/files", "POST", false, false],
  ["models", "/v1/models", "GET", false, false],
  ["messages with a trailing slash", "/v1/messages/", "POST", false, true],
  ["a path that only starts like messages", "/v1/messagesx", "POST", false, false],
  ["messages under a provider's scope", "/providers/spark/v1/messages", "POST", true, false],
  ["count_tokens under a provider's scope", "/providers/spark/v1/messages/count_tokens", "POST", true, false],
  ["batches under a provider's scope", "/providers/spark/v1/messages/batches", "POST", false, false],
];

describe("which paths are Messages requests and which are inference calls", () => {
  it.each(TABLE)("%s: %s by %s", (_label, path, method, request, inference) => {
    expect(isMessagesRequest(method, path)).toBe(request);
    expect(isMessagesInferencePath(path)).toBe(inference);
  });

  it("treats a query as no part of the pathname the door classifies", () => {
    const pathname = new URL("/v1/messages?beta=true", "http://127.0.0.1").pathname;
    expect(isMessagesRequest("POST", pathname)).toBe(true);
    expect(isMessagesInferencePath(pathname)).toBe(true);
  });
});
