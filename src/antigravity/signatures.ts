/**
 * The thought signatures the backend attaches to its function calls, remembered by the tool_use id the relay minted for them, so the next request's translation can echo each signature back onto the function call it signed. Nothing else survives the round trip through Claude Code (unknown tool_use fields and foreign thinking blocks are both dropped when the request is built), while the id is preserved verbatim because the tool result references it.
 *
 * The store lives for the door process's lifetime: a door restart mid-conversation loses the signatures of calls made before it, which the backend answers with the same INVALID_ARGUMENT until the conversation moves past those turns. Bounded because a long agent session makes many calls: past the cap the oldest ids fall away, and a turn old enough to be evicted is a turn whose result the conversation has long since consumed.
 */

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
