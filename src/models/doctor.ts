import type { ModelsConfig } from "../config/schema";
import { expandMembers, memberKindOf } from "../modelsStore";
import { FAMILY_PREFIX, buildFamilies, familyKeyOf } from "./families";
import { relateModels } from "./identity";

/** What the models doctor check needs from its surroundings. */
export interface ModelsDoctorInput {
  readonly models: ModelsConfig;
  /** The defined provider names. */
  readonly providers: readonly string[];
  /** The defined identity names, for account members. */
  readonly identities: readonly string[];
  /** Every target the defined providers offer, as `<provider>/<model>` refs. When given, a `family:` member is checked against the families they form; omit to skip that check. */
  readonly targets?: readonly string[];
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
  const modelOfRef = (ref: string): string => ref.slice(ref.indexOf("/") + 1);
  for (const group of models.same ?? []) {
    for (let outer = 0; outer < group.length; outer += 1) {
      for (let inner = outer + 1; inner < group.length; inner += 1) {
        const left = group[outer] ?? "";
        const right = group[inner] ?? "";
        if (!left.startsWith("acct:") && !right.startsWith("acct:") && relateModels(modelOfRef(left), modelOfRef(right)) === "distinct") {
          findings.push({ severity: "warn", message: `"${left}" and "${right}" are asserted to be one model, but their names say they are different models; check the assertion is not a typo.` });
        }
        if ((models.distinct ?? []).some(([a, b]) => (a === left && b === right) || (a === right && b === left))) {
          findings.push({ severity: "fail", message: `"${left}" and "${right}" are asserted to be both one model and two models.` });
        }
      }
    }
  }
  for (const [name, model] of Object.entries(models.virtual ?? {})) {
    const concrete = model.members.filter((member) => memberKindOf(member, models) === "provider" && member.includes("/"));
    const looksAlike = concrete.flatMap((left, index) => concrete.slice(index + 1).filter((right) => relateModels(modelOfRef(left), modelOfRef(right)) === "same").map((right) => [left, right] as const));
    for (const [left, right] of looksAlike) {
      findings.push({ severity: "warn", message: `Virtual model "${name}" lists "${left}" and "${right}", which look like one model; a member ${FAMILY_PREFIX}${familyKeyOf(modelOfRef(left))} names every target of it.` });
    }
  }
  if (input.targets !== undefined) {
    const families = buildFamilies(input.targets, models);
    for (const [name, model] of Object.entries(models.virtual ?? {})) {
      for (const member of model.members.filter((entry) => entry.startsWith(FAMILY_PREFIX))) {
        if (!families.some((family) => `${FAMILY_PREFIX}${family.key}` === member)) {
          findings.push({ severity: "warn", message: `Virtual model "${name}" names ${member}, but no target the providers offer belongs to that family.` });
        }
      }
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
