import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";

import { successfulResult } from "./sdkResult";

/** A result message of the given outcome, with only the fields the check reads. */
function result(fields: { readonly subtype: string; readonly is_error?: boolean; readonly result?: string }): SDKResultMessage {
  // The check reads subtype, is_error and result only; the rest of the SDK's shape is not what it decides on.
  return fields as unknown as SDKResultMessage;
}

describe("successfulResult", () => {
  it("returns the text of a turn that ended well", () => {
    expect(successfulResult(result({ subtype: "success", is_error: false, result: "ok" }))).toBe("ok");
  });

  it("throws for a success-subtype turn that ended on an API error, carrying the error text", () => {
    expect(() => successfulResult(result({ subtype: "success", is_error: true, result: "Couldn't connect through your proxy" }))).toThrow(/ended on an error: Couldn't connect through your proxy/);
  });

  it("throws naming the subtype for a turn that stopped early", () => {
    expect(() => successfulResult(result({ subtype: "error_max_turns" }))).toThrow(/ended as error_max_turns/);
  });
});
