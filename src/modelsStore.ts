import { applyPatch } from "./config/store";
import { GlobalConfigSchema, type FamilySettings, type ModelsConfig, type VirtualModel } from "./config/schema";
import { readGlobalConfig } from "./configProfilesStore";
import type { LayoutPaths } from "./paths";

/** The `models` block defined in `~/.agent-shim/config.json`, or undefined when none is. */
export function readModels(paths: LayoutPaths): ModelsConfig | undefined {
  return readGlobalConfig(paths)?.models;
}

/** Writes the whole `models` block back: `applyPatch` replaces top-level keys wholesale, and an emptied block removes the key itself. */
function writeModels(paths: LayoutPaths, models: ModelsConfig | undefined): void {
  const emptied = models !== undefined && Object.keys(models).length === 0 ? undefined : models;
  applyPatch(paths.globalConfigFile, GlobalConfigSchema, { models: emptied }, { defaults: {} });
}

/** Drops the block's empty sub-objects, so removing the last of something leaves no `{}` behind. */
function stripEmpty(models: ModelsConfig): ModelsConfig {
  const kept: ModelsConfig = {};
  if (models.virtual !== undefined && Object.keys(models.virtual).length > 0) {
    kept.virtual = models.virtual;
  }
  if (models.tiers !== undefined && Object.keys(models.tiers).length > 0) {
    kept.tiers = models.tiers;
  }
  if (models.prices !== undefined && Object.keys(models.prices).length > 0) {
    kept.prices = models.prices;
  }
  if (models.hide !== undefined && models.hide.length > 0) {
    kept.hide = models.hide;
  }
  if (models.show !== undefined && models.show.length > 0) {
    kept.show = models.show;
  }
  if (models.same !== undefined && models.same.length > 0) {
    kept.same = models.same;
  }
  if (models.distinct !== undefined && models.distinct.length > 0) {
    kept.distinct = models.distinct;
  }
  if (models.families !== undefined && Object.keys(models.families).length > 0) {
    kept.families = models.families;
  }
  return kept;
}

/** Raised when a virtual model named for change does not exist. */
export class VirtualModelNotFoundError extends Error {
  constructor(name: string) {
    super(`No virtual model named "${name}".`);
    this.name = "VirtualModelNotFoundError";
  }
}

/** Whether `ref` names a virtual model, an account model (`acct:<identity>/<model>`), a family (`family:<canonical>`), or a provider model (`<provider>/<model>`), in the config given. Pure string shapes plus the virtual names; whether a provider or identity exists is the command's concern. */
export function memberKindOf(ref: string, models: ModelsConfig | undefined): "virtual" | "account" | "family" | "provider" {
  if (ref.startsWith("acct:")) {
    return "account";
  }
  if (ref.startsWith("family:")) {
    return "family";
  }
  return models?.virtual !== undefined && ref in models.virtual ? "virtual" : "provider";
}

/**
 * The members a virtual model's member list expands to, following nested virtual models: every concrete and family member the choice is finally taken over. Throws on a cycle, naming the chain, and on a nested virtual model that does not exist.
 */
export function expandMembers(name: string, models: ModelsConfig | undefined): readonly string[] {
  const virtual = models?.virtual ?? {};
  const expanded: string[] = [];
  const walk = (current: string, chain: readonly string[]): void => {
    const nested = virtual[current];
    if (nested !== undefined) {
      if (chain.includes(current)) {
        throw new Error(`virtual model cycle: ${[...chain, current].join(" -> ")}`);
      }
      for (const member of nested.members) {
        walk(member, [...chain, current]);
      }
      return;
    }
    if (!expanded.includes(current)) {
      expanded.push(current);
    }
  };
  const top = virtual[name];
  if (top === undefined) {
    throw new VirtualModelNotFoundError(name);
  }
  for (const member of top.members) {
    walk(member, [name]);
  }
  return expanded;
}

/** Sets one virtual model, creating or replacing it, with the block written back. */
export function setVirtualModel(paths: LayoutPaths, name: string, model: VirtualModel): void {
  const current = readModels(paths) ?? {};
  writeModels(paths, { ...current, virtual: { ...(current.virtual ?? {}), [name]: model } });
}

/** Removes one virtual model; throws `VirtualModelNotFoundError` when none is defined. */
export function removeVirtualModel(paths: LayoutPaths, name: string): void {
  const current = readModels(paths);
  if (current?.virtual?.[name] === undefined) {
    throw new VirtualModelNotFoundError(name);
  }
  const virtual = Object.fromEntries(Object.entries(current.virtual ?? {}).filter(([existing]) => existing !== name));
  writeModels(paths, stripEmpty({ ...current, virtual: Object.keys(virtual).length === 0 ? undefined : virtual }));
}

/** Sets one model ref's prices, or removes them, with the block written back. */
export function setPrice(paths: LayoutPaths, ref: string, prices: { input: number; output: number } | undefined): void {
  const current = readModels(paths) ?? {};
  const priced = Object.fromEntries(Object.entries(current.prices ?? {}).filter(([existing]) => existing !== ref));
  const next = prices === undefined ? priced : { ...priced, [ref]: prices };
  writeModels(paths, stripEmpty({ ...current, prices: Object.keys(next).length === 0 ? undefined : next }));
}

/** Sets one tier pointer, with the block written back. */
export function setTier(paths: LayoutPaths, tier: "fable" | "opus" | "sonnet" | "haiku", ref: string | undefined): void {
  const current = readModels(paths) ?? {};
  const tiers: Record<string, string> = {};
  const merged: Record<string, string | undefined> = { ...(current.tiers ?? {}), [tier]: ref };
  for (const [key, value] of Object.entries(merged)) {
    if (value !== undefined) {
      tiers[key] = value;
    }
  }
  writeModels(paths, stripEmpty({ ...current, tiers: Object.keys(tiers).length === 0 ? undefined : tiers }));
}


/** Asserts that every ref in `refs` is one model under several names, joining any existing group that shares a ref so the assertion stays one transitive group. */
export function addSameGroup(paths: LayoutPaths, refs: readonly string[]): void {
  const current = readModels(paths) ?? {};
  const overlapping = (current.same ?? []).filter((group) => group.some((ref) => refs.includes(ref)));
  const rest = (current.same ?? []).filter((group) => !overlapping.includes(group));
  const joined = [...new Set([...overlapping.flat(), ...refs])];
  writeModels(paths, stripEmpty({ ...current, same: [...rest, joined] }));
}

/** Asserts that two refs are two models however alike their names look; a repeat of an existing pair changes nothing. */
export function addDistinctPair(paths: LayoutPaths, left: string, right: string): void {
  const current = readModels(paths) ?? {};
  const known = (current.distinct ?? []).some(([a, b]) => (a === left && b === right) || (a === right && b === left));
  if (!known) {
    writeModels(paths, stripEmpty({ ...current, distinct: [...(current.distinct ?? []), [left, right]] }));
  }
}

/** Removes every identity assertion that names `ref`, in either list; returns how many it removed. */
export function removeAssertionsNaming(paths: LayoutPaths, ref: string): number {
  const current = readModels(paths);
  if (current === undefined) {
    return 0;
  }
  const same = (current.same ?? []).filter((group) => !group.includes(ref));
  const distinct = (current.distinct ?? []).filter(([left, right]) => left !== ref && right !== ref);
  const removed = (current.same ?? []).length - same.length + ((current.distinct ?? []).length - distinct.length);
  if (removed > 0) {
    writeModels(paths, stripEmpty({ ...current, same: same.length === 0 ? undefined : same, distinct: distinct.length === 0 ? undefined : distinct }));
  }
  return removed;
}

/** Sets one family's settings, creating or replacing them, or removes them with `undefined`. */
export function setFamily(paths: LayoutPaths, key: string, settings: FamilySettings | undefined): void {
  const current = readModels(paths) ?? {};
  const others = Object.fromEntries(Object.entries(current.families ?? {}).filter(([existing]) => existing !== key));
  const next = settings === undefined ? others : { ...others, [key]: settings };
  writeModels(paths, stripEmpty({ ...current, families: Object.keys(next).length === 0 ? undefined : next }));
}
