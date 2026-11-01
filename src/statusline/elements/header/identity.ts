import type { RenderContext } from "../context";

/** The identity that launched the session, with its label beside the name when it has one, or undefined when the name would only repeat an account already named and there is no label to add. */
export function identitySegment({ summary }: RenderContext): string | undefined {
  if (summary.identity === undefined) {
    return undefined;
  }
  // A label is something the person wrote down to tell identities apart, so it is drawn whatever the session runs on. Without one, the identity names which login launched the session and is worth its own segment only beside a provider, where it is not the account already named; a plain anthropic session is its login account, so the identity name would repeat it.
  if (summary.identityLabel !== undefined) {
    return `${summary.identity} (${summary.identityLabel})`;
  }
  if (summary.provider !== undefined && summary.identity !== summary.providerAccountEmail && summary.identity !== summary.loginAccountEmail) {
    return summary.identity;
  }
  return undefined;
}
