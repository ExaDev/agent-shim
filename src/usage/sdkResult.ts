import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

/**
 * The text of a turn that ended well, or a thrown error saying why it did not. The SDK reports a turn that ended on an API error (a refused proxy tunnel, a rate limit, a rejected credential) as subtype `success` with `is_error` set and the error text as `result`, so the subtype alone cannot tell a run that did its work from one that never reached the model.
 */
export function successfulResult(message: Readonly<SDKResultMessage>): string {
  if (message.subtype !== "success") {
    throw new Error(`the run ended as ${message.subtype}`);
  }
  if (message.is_error) {
    throw new Error(`the run ended on an error: ${message.result}`);
  }
  return message.result;
}
