import type { ModelsConfig, ModelsLayer } from "./config/schema";

/** The prefix of a model ref that names a model of an account (an identity): `acct:<identity>/<model>`. */
const ACCOUNT_REF_PREFIX = "acct:";

/** A model ref `acct:<from>/<model>` rewritten to `acct:<to>/<model>`. Any other ref, including a provider model whose provider happens to be named like the identity, is returned as it was. */
function renameAccountRef(ref: string, from: string, to: string): string {
  const prefix = `${ACCOUNT_REF_PREFIX}${from}/`;
  return ref.startsWith(prefix) ? `${ACCOUNT_REF_PREFIX}${to}/${ref.slice(prefix.length)}` : ref;
}

/**
 * The `models` block with every model ref in it replaced by `rename(ref)`: virtual models' members, tier pointers, prices, the visibility lists, the same and distinct assertions, and the names pinned into families. Anything else is returned as it was. A cascade layer's `null` (a removal) is kept as it is.
 */
export function mapModelRefs(models: ModelsConfig, rename: (ref: string) => string): ModelsConfig;
export function mapModelRefs(models: ModelsLayer, rename: (ref: string) => string): ModelsLayer;
export function mapModelRefs(models: ModelsLayer, rename: (ref: string) => string): ModelsLayer {
  const renamed: ModelsLayer = { ...models };
  if (models.virtual !== undefined) {
    renamed.virtual = Object.fromEntries(Object.entries(models.virtual).map(([name, definition]) => [name, definition === null ? null : { ...definition, members: definition.members.map(rename) }]));
  }
  if (models.tiers !== undefined) {
    renamed.tiers = Object.fromEntries(Object.entries(models.tiers).map(([tier, ref]) => [tier, typeof ref === "string" ? rename(ref) : ref]));
  }
  if (models.prices !== undefined) {
    renamed.prices = Object.fromEntries(Object.entries(models.prices).map(([ref, price]) => [rename(ref), price]));
  }
  if (models.hide !== undefined) {
    renamed.hide = models.hide.map(rename);
  }
  if (models.show !== undefined) {
    renamed.show = models.show.map(rename);
  }
  if (models.same !== undefined) {
    renamed.same = models.same.map((group) => group.map(rename));
  }
  if (models.distinct !== undefined) {
    renamed.distinct = models.distinct.map(([left, right]) => [rename(left), rename(right)]);
  }
  if (models.families !== undefined) {
    renamed.families = Object.fromEntries(Object.entries(models.families).map(([key, settings]) => [key, settings?.names === undefined ? settings : { ...settings, names: settings.names.map(rename) }]));
  }
  return renamed;
}

/** The `models` block with every `acct:<from>/...` ref requalified as `acct:<to>/...`, or undefined when no ref in it names `from`. */
export function renameAccountModelRefs(models: ModelsConfig, from: string, to: string): ModelsConfig | undefined;
export function renameAccountModelRefs(models: ModelsLayer, from: string, to: string): ModelsLayer | undefined;
export function renameAccountModelRefs(models: ModelsLayer, from: string, to: string): ModelsLayer | undefined {
  const renamed = mapModelRefs(models, (ref) => renameAccountRef(ref, from, to));
  return JSON.stringify(renamed) === JSON.stringify(models) ? undefined : renamed;
}
