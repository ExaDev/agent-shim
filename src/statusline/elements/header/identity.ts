import type { RenderContext } from "../context";

/** The identity that launched the session, or undefined when it would only repeat an account already named. */
export function identitySegment({ summary }: RenderContext): string | undefined {
  // The identity names which login launched the session, worth its own segment only beside a provider, where it is not the account already named; a plain anthropic session is its login account, so the identity name would repeat it.
  if (summary.identity !== undefined && summary.provider !== undefined && summary.identity !== summary.providerAccountEmail && summary.identity !== summary.loginAccountEmail) {
    return summary.identity;
  }
  return undefined;
}
