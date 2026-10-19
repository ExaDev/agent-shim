import type { RenderContext } from "../context";

/** The provider a launch selected, with its account's email and plan when it has them, or undefined for a launch with no provider. */
export function providerSegment({ summary }: RenderContext): string | undefined {
  if (summary.provider === undefined) {
    return undefined;
  }
  const account = [summary.providerAccountEmail, summary.providerPlan].filter((part) => part !== undefined);
  return account.length > 0 ? `${summary.provider} · ${account.join(" · ")}` : summary.provider;
}
