import type { RenderContext } from "../context";

/** The provider a launch selected, or the label the settings give in its place, with the provider account's email and plan when it has them; undefined for a launch with no provider and no label. */
export function providerSegment({ summary, settings }: RenderContext): string | undefined {
  const label = settings.provider.name === "" ? summary.provider : settings.provider.name;
  if (label === undefined) {
    return undefined;
  }
  const account = [summary.providerAccountEmail, summary.providerPlan].filter((part) => part !== undefined);
  return account.length > 0 ? `${label} · ${account.join(" · ")}` : label;
}
