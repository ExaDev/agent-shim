/**
 * The thought signatures the backend attaches to its function calls, remembered by the tool_use id the relay minted for them, so the next request's translation can echo each signature back onto the function call it signed. Nothing else survives the round trip through Claude Code (unknown tool_use fields and foreign thinking blocks are both dropped when the request is built), while the id is preserved verbatim because the tool result references it.
 *
 * The store lives for the door process's lifetime: a door restart mid-conversation loses the signatures of calls made before it, and a resumed session can carry calls no signature was ever remembered for (another model made them). Bounded because a long agent session makes many calls: past the cap the oldest ids fall away. Either way the translation sends `UNVERIFIED_THOUGHT_SIGNATURE` for a call it has no signature for, because the whole history is resent on every request and the backend rejects the request over any one unsigned call, which would otherwise leave the conversation failing for good.
 */

/** The backend's documented value for a function call whose signature is unavailable (a conversation trace that came from another model): it skips the signature validation for that call instead of failing the request. Confirmed against the live endpoint, which answers an unsigned call with INVALID_ARGUMENT and accepts this value. */
export const UNVERIFIED_THOUGHT_SIGNATURE = "skip_thought_signature_validator";

const MAX_REMEMBERED = 1024;

const signatures = new Map<string, string>();

export function rememberToolCallSignature(toolUseId: string, signature: string): void {
  signatures.set(toolUseId, signature);
  if (signatures.size > MAX_REMEMBERED) {
    const oldest = signatures.keys().next();
    if (oldest.done !== true) {
      signatures.delete(oldest.value);
    }
  }
}

export function toolCallSignatureOf(toolUseId: string): string | undefined {
  return signatures.get(toolUseId);
}
