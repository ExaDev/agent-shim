import type { ModelsConfig } from "../config/schema";
import { expandMembers, memberKindOf } from "../modelsStore";

/** What the models doctor check needs from its surroundings. */
export interface ModelsDoctorInput {
  readonly models: ModelsConfig;
  /** The defined provider names. */
  readonly providers: readonly string[];
  /** The defined identity names, for account members. */
  readonly identities: readonly string[];
}

/** One finding of the models check. */
export interface ModelsFinding {
  readonly severity: "fail" | "warn";
  readonly message: string;
}

/**
 * Checks the `models` block's own consistency: every tier pointer and every virtual member names something that exists (a provider, a virtual model, an identity for an account member), no virtual model cycles, every `cheapest` member priced, and nothing both hidden and shown. Pure over the inputs, so `doctor` reports what it found and the checks are testable alone.
 */
export function modelsFindings(input: Readonly<ModelsDoctorInput>): readonly ModelsFinding[] {
  const findings: ModelsFinding[] = [];
  const { models } = input;
  const providers = new Set(input.providers);
  const identities = new Set(input.identities);
  const virtualNames = new Set(Object.keys(models.virtual ?? {}));
  for (const [name, model] of Object.entries(models.virtual ?? {})) {
    for (const member of model.members) {
      const kind = memberKindOf(member, models);
      if (kind === "provider" && !member.includes("/")) {
        findings.push({ severity: "fail", message: `Virtual model "${name}" names member "${member}", which is neither a defined virtual model nor a provider model (a provider model is <provider>/<model>).` });
      } else if (kind === "provider" && !providers.has(member.split("/")[0] ?? "")) {
        findings.push({ severity: "fail", message: `Virtual model "${name}" names member "${member}", but no provider "${member.split("/")[0] ?? ""}" is defined.` });
      }
      if (kind === "virtual" && !virtualNames.has(member)) {
        findings.push({ severity: "fail", message: `Virtual model "${name}" names member "${member}", but no virtual model "${member}" is defined.` });
      }
      if (kind === "account") {
        const identity = member.slice("acct:".length).split("/")[0] ?? "";
        if (!identities.has(identity)) {
          findings.push({ severity: "fail", message: `Virtual model "${name}" names member "${member}", but no identity "${identity}" is defined.` });
        }
      }
    }
    try {
      expandMembers(name, models);
    } catch (error) {
      findings.push({ severity: "fail", message: `Virtual model "${name}" cannot be expanded: ${error instanceof Error ? error.message : String(error)}` });
    }
    if (model.mode === "cheapest") {
      const expanded = expandMembers(name, models);
      const unpriced = expanded.filter((member) => models.prices?.[member] === undefined && memberKindOf(member, models) !== "virtual");
      if (unpriced.length > 0) {
        findings.push({ severity: "warn", message: `Virtual model "${name}" chooses by price, but no prices are set for: ${unpriced.join(", ")}.` });
      }
    }
  }
  for (const [tier, ref] of Object.entries(models.tiers ?? {})) {
    const kind = memberKindOf(ref, models);
    const known = kind === "virtual" ? virtualNames.has(ref) : kind === "provider" ? providers.has(ref.split("/")[0] ?? "") : true;
    if (!known) {
      findings.push({ severity: "fail", message: `Tier ${tier} points at "${ref}", which names nothing defined.` });
    }
  }
  const hidden = new Set(models.hide ?? []);
  const shown = new Set(models.show ?? []);
  for (const ref of hidden) {
    if (shown.has(ref)) {
      findings.push({ severity: "fail", message: `Model ref "${ref}" is both hidden and in the show-only list.` });
    }
  }
  return findings;
}
