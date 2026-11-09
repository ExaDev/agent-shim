/**
 * What a failed outgoing request says for itself: its message, or, when Node reports a name that resolved to several addresses as an `AggregateError` with an empty message, the messages of the attempts it holds; failing both, its code. Never empty, so a report built on it never ends on a bare colon.
 */
export function errorReason(error: NodeJS.ErrnoException): string {
  if (error.message !== "") {
    return error.message;
  }
  const attempts: unknown = Reflect.get(error, "errors");
  if (Array.isArray(attempts)) {
    const messages = attempts.map((attempt: unknown) => (attempt instanceof Error ? attempt.message : String(attempt))).filter((message) => message !== "");
    if (messages.length > 0) {
      return messages.join("; ");
    }
  }
  return error.code ?? "the request failed with no reason given";
}
