import { describe, expect, it } from "vitest";

import { MESSAGES_BODY_LIMIT_BYTES, bodyTooLargeMessage } from "./messagesBodyLimit";

const KIB = 1024;
const MIB = KIB * KIB;
const LIMIT_BYTES = 134_217_728;
const DOCUMENTED_MIB = 128;

describe("the Messages body limit", () => {
  it("is 128 MiB (134217728 bytes), the larger reading of the 128 MB the API documents", () => {
    expect(MESSAGES_BODY_LIMIT_BYTES).toBe(DOCUMENTED_MIB * MIB);
    expect(MESSAGES_BODY_LIMIT_BYTES).toBe(LIMIT_BYTES);
  });

  it("is refused in one text that names the provider when known, the limit in bytes and MiB, and what to do", () => {
    expect(bodyTooLargeMessage(MESSAGES_BODY_LIMIT_BYTES, "spark")).toBe('provider "spark": the request body is larger than the limit for a Messages request, 134217728 bytes (128 MiB); send a smaller body');
    expect(bodyTooLargeMessage(MESSAGES_BODY_LIMIT_BYTES)).toBe("the request body is larger than the limit for a Messages request, 134217728 bytes (128 MiB); send a smaller body");
  });
});
