import type { FamilySettings, ModelsConfig, SelectionModeName } from "../config/schema";
import { modelIdentity, relateModels, type IdentityAssertions } from "./identity";

/** The prefix a member or a picker row's model name carries to name a whole family. */
export const FAMILY_PREFIX = "family:";

/** Separates a family's key from one of its variants (`claude-opus-5-5+high`): a variant changes a model's behaviour without changing which model it is, so a member names the variant it means and a bare key means the variant-less targets. */
const VARIANT_SEPARATOR = "+";

/** The model name part of a target ref (`z/glm-5.3` gives `glm-5.3`): everything after the first slash, which a provider name never contains. */
function modelOf(ref: string): string {
  const slash = ref.indexOf("/");
  return slash === -1 ? ref : ref.slice(slash + 1);
}

/** The canonical family key of one raw model name: its family and version, then `+<variant>` when it carries one. Two names with equal keys are the same model. */
export function familyKeyOf(rawModel: string): string {
  const identity = modelIdentity(rawModel);
  return identity.variant === "" ? identity.familyAndVersion : `${identity.familyAndVersion}${VARIANT_SEPARATOR}${identity.variant}`;
}

/** A model family: every target the catalogue holds that is one model, whichever provider or account offers it. */
export interface Family {
  /** The canonical key (`glm-5-1`, `claude-opus-5-5+high`). */
  readonly key: string;
  /** The targets that are this model, in the order the catalogue listed them. */
  readonly refs: readonly string[];
  /** The family's own settings from the config, when it has any. */
  readonly settings: FamilySettings;
}

/** The user's identity assertions, as the config states them. */
function assertionsOf(models: ModelsConfig | undefined): IdentityAssertions {
  return { same: models?.same ?? [], distinct: models?.distinct ?? [] };
}

/** Whether two targets are one model: the user's assertions are about refs and take precedence (a `distinct` pair never is; a `same` group always is), and otherwise the model names decide, unless the user has pinned either target into a group it is not in, which turns the likeness into a proposal only. */
function sameModel(left: string, right: string, assertions: Readonly<IdentityAssertions>): boolean {
  if (assertions.distinct.some(([a, b]) => (a === left && b === right) || (a === right && b === left))) {
    return false;
  }
  const leftGroup = assertions.same.find((group) => group.includes(left));
  const rightGroup = assertions.same.find((group) => group.includes(right));
  if (leftGroup !== undefined && leftGroup === rightGroup) {
    return true;
  }
  if ((leftGroup !== undefined && !leftGroup.includes(right)) || (rightGroup !== undefined && !rightGroup.includes(left))) {
    return false;
  }
  return relateModels(modelOf(left), modelOf(right)) === "same";
}

/** Whether a `names` entry pins `ref` into a family: the entry is either the full ref or just the model name. */
function pinnedTo(settings: FamilySettings | undefined, ref: string): boolean {
  return settings?.names?.some((name) => name === ref || name === modelOf(ref)) === true;
}

/**
 * Groups `refs` into families. A target joins the family of the first target it is the same model as (the names say so, or the user asserted it, and never when the user asserted they are distinct); a `names` pin in the family settings overrides the names; and an account ref only appears in a family the user put it in, because nothing else says which models an account offers. Order is the catalogue's, so a family's refs keep the order they were listed in.
 */
export function buildFamilies(refs: readonly string[], models: ModelsConfig | undefined): readonly Family[] {
  const assertions = assertionsOf(models);
  const settingsByKey = models?.families ?? {};
  const groups: { key: string; refs: string[] }[] = [];
  for (const ref of refs) {
    const pinnedKey = Object.entries(settingsByKey).find(([, settings]) => pinnedTo(settings, ref))?.[0];
    const joined = groups.find((group) => (pinnedKey === undefined ? group.refs.some((first) => sameModel(first, ref, assertions)) : group.key === pinnedKey));
    if (joined !== undefined) {
      joined.refs.push(ref);
    } else {
      groups.push({ key: pinnedKey ?? familyKeyOf(modelOf(ref)), refs: [ref] });
    }
  }
  return groups.map((group) => ({ key: group.key, refs: group.refs, settings: settingsByKey[group.key] ?? {} }));
}

/** The family a `family:<key>` member or row names, or undefined when the catalogue holds none by that key. */
export function familyNamed(families: readonly Family[], member: string): Family | undefined {
  if (!member.startsWith(FAMILY_PREFIX)) {
    return undefined;
  }
  const key = member.slice(FAMILY_PREFIX.length);
  return families.find((family) => family.key === key);
}

/** What every target of a family can do, taken as supported unless the family's settings say otherwise: a family carries these once, so the request-needs filter reads the family. */
export function familyCapabilities(settings: FamilySettings): { readonly vision: boolean; readonly tools: boolean; readonly thinking: boolean } {
  return { vision: settings.vision ?? true, tools: settings.tools ?? true, thinking: settings.thinking ?? true };
}

/** How a row that selects the whole family chooses among its targets. */
export function familyMode(settings: FamilySettings): SelectionModeName {
  return settings.mode ?? "ordered";
}

/** The families offered by more than one target: a family of one is just a target, and its qualified row already is that. These are the ones a person routes across. */
export function sharedFamilies(families: readonly Family[]): readonly Family[] {
  return families.filter((family) => family.refs.length > 1);
}
