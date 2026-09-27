import { z } from "zod";

/**
 * Every category a `~/.claude` entry can be classified into. `secret` is deliberately part of this list — it is a real classification the resolver acts on — but it is NOT part of `CategoryMapSchema`'s shape, because no configuration layer may ever toggle it. See OVERRIDABLE_CATEGORIES.
 */
export const CATEGORY_NAMES = ["secret", "runtime", "history", "knowledge", "settings"] as const;
export type CategoryName = (typeof CATEGORY_NAMES)[number];

/** The four categories a configuration layer is allowed to toggle. `secret` is absent by design. */
export const OVERRIDABLE_CATEGORIES = ["runtime", "history", "knowledge", "settings"] as const;
export type OverridableCategory = (typeof OVERRIDABLE_CATEGORIES)[number];

/** True when `name` is one of the four categories a configuration layer may toggle. */
export function isOverridableCategory(name: string): name is OverridableCategory {
  return OVERRIDABLE_CATEGORIES.some((category) => category === name);
}

/** True when `name` is any of the five classification categories, including `secret`. */
export function isCategoryName(name: string): name is CategoryName {
  return CATEGORY_NAMES.some((category) => category === name);
}

/**
 * The category toggle map's resolved shape — always exactly the four overridable categories, never the `all` pseudo-key `CategoryMapSchema` also accepts on input. Derived directly from `OverridableCategory` rather than `z.infer`red from a schema, since `CategoryMapSchema` itself carries a `.transform()` (whose inferred type follows the transform's *output*, so it can't be used to define its own output type without circularity) and a schema built solely to be `typeof`'d, never actually parsed with, would be dead weight at runtime for no benefit over a plain mapped type.
 */
export type CategoryMap = Partial<Record<OverridableCategory, boolean>>;

/**
 * Expands the `all` pseudo-category key into every overridable category set to that same value, dropping `all` itself from the result. An explicit named category always wins over the `all` expansion regardless of where it appears relative to `all` in the input — `{ all: true, runtime: false }` means "share everything except runtime", not "runtime is false, then immediately overwritten back to true by all's own expansion". Built from `OVERRIDABLE_CATEGORIES` rather than the four names spelled out again, so a future addition to that list is covered by `all` with no change needed here.
 *
 * This is the one shared implementation `CategoryMapSchema`'s own transform, `launcher/cliOverride.ts`'s `--category`/`CLAUDE_USE_CATEGORY_OVERRIDE` handling, and `configProfiles.ts`'s `claude-use profile set --category` all call — so `all` means the same thing regardless of which of those three input paths it arrived through.
 */
export function expandAllCategoryKey(pairs: Readonly<Record<string, boolean>>): Record<string, boolean> {
  const { all, ...rest } = pairs;
  if (all === undefined) {
    return { ...rest };
  }
  const expanded = Object.fromEntries(OVERRIDABLE_CATEGORIES.map((category) => [category, all]));
  return { ...expanded, ...rest };
}

/**
 * The category toggle map as written by hand: the four overridable categories, plus `all` as shorthand for "every overridable category at once" (expanded by `expandAllCategoryKey` above). `secret` is omitted from the shape entirely, so `{ "categories": { "secret": true } }` is rejected at parse time rather than relying solely on the resolver's runtime floor check. The closed shape is also what lets the published JSON Schema offer real key-name autocomplete, which an open record type cannot.
 */
export const CategoryMapSchema = z
  .strictObject({
    all: z.boolean().optional(),
    runtime: z.boolean().optional(),
    history: z.boolean().optional(),
    knowledge: z.boolean().optional(),
    settings: z.boolean().optional(),
  })
  .transform((input): CategoryMap => expandAllCategoryKey(input));

/** A duration literal: a positive integer count followed by a unit. Used by `newerThan`/`olderThan`. */
export const DURATION_RE = /^(?:0|[1-9][0-9]*)(?:ms|s|m|h|d|w)$/;
const DurationSchema = z.string().regex(DURATION_RE);

/**
 * A conditional guard on an entries value or a whole directory rule. Every field present within one `when` object must hold (AND logic). An empty object is vacuously true — `claude-use check` warns about it, it is never an error.
 */
export const WhenSchema = z.strictObject({
  newerThan: DurationSchema.optional(),
  olderThan: DurationSchema.optional(),
  maxSizeBytes: z.int().positive().optional(),
  branch: z.string().min(1).optional(),
  env: z.record(z.string().min(1), z.string()).optional(),
});
export type WhenCondition = z.infer<typeof WhenSchema>;

/** An entries value: a flat boolean, or a boolean guarded by a `when` condition. */
export const EntryValueSchema = z.union([
  z.boolean(),
  z.strictObject({ value: z.boolean(), when: WhenSchema }),
]);
export type EntryValue = z.infer<typeof EntryValueSchema>;

/**
 * Every entries key is `<category>/<real-relative-path>`, always — never a bare path. The prefix is what makes a key unambiguous when two categories happen to share a top-level name, and it is what lets the resolver cross-check a key's *declared* category against the *real* classification of the path it names, catching an entry that tries to launder a secret path through a `runtime/...` key.
 */
export const ENTRY_KEY_RE = /^(?:secret|runtime|history|knowledge|settings)\/(?!\/)\S(?:.*\S)?$/;
export const EntriesSchema = z.record(z.string().regex(ENTRY_KEY_RE), EntryValueSchema);
export type Entries = z.infer<typeof EntriesSchema>;

/** Launch flags, resolved through the same cascade as categories and entries. */
const LaunchSchema = z.strictObject({
  skipPermissions: z.boolean().optional(),
  remoteControl: z.boolean().optional(),
  provider: z.string().min(1).optional(),
  headroom: z.boolean().optional(),
});
export type LaunchFlags = z.infer<typeof LaunchSchema>;

/**
 * A named API provider at `~/.claude-use/providers/<name>.json`: which base URL the child Claude Code talks to, which environment variable holds its token, and any static extra environment entries the child needs to use that endpoint.
 *
 * `tokenEnv` is deliberately the NAME of an environment variable (e.g. `Z_API_TOKEN`), never a token value: a provider file is ordinary committed config, and the credential itself must stay in the environment or a secret store where it belongs.
 */
export const ProviderSchema = z.strictObject({
  $schema: z.string().optional(),
  displayName: z.string().min(1),
  baseUrl: z.url(),
  tokenEnv: z.string().min(1),
  env: z.record(z.string().min(1), z.string()).optional(),
});
export type Provider = z.infer<typeof ProviderSchema>;

/**
 * A named, reusable configuration profile at `~/.claude-use/config-profiles/<name>.json`.
 *
 * `extends` is a flat array of other profiles' *names*, deliberately not a self-referential `z.lazy()` schema: nothing in this shape points back at a profile object, so each file validates in isolation and the extends graph is walked at resolve time. That also means Zod cannot detect a circular `extends` definition — the walker in `src/resolve/extends.ts` carries its own cycle guard.
 */
export const ConfigProfileSchema = z.strictObject({
  $schema: z.string().optional(),
  description: z.string().optional(),
  extends: z.array(z.string().min(1)).optional(),
  categories: CategoryMapSchema.optional(),
  entries: EntriesSchema.optional(),
  launch: LaunchSchema.optional(),
});
export type ConfigProfile = z.infer<typeof ConfigProfileSchema>;

/** One directory rule in `~/.claude-use/directory-rules.json`, scoped to an explicit absolute (or `~`-rooted) path. */
export const DirectoryRuleSchema = ConfigProfileSchema.omit({ description: true }).extend({
  path: z.string().min(1),
  configProfile: z.string().min(1).optional(),
  identity: z.string().min(1).optional(),
  when: WhenSchema.optional(),
});
export type DirectoryRule = z.infer<typeof DirectoryRuleSchema>;

/** The `~/.claude-use/directory-rules.json` file. */
export const DirectoryRulesSchema = z.strictObject({
  $schema: z.string().optional(),
  rules: z.array(DirectoryRuleSchema),
});
export type DirectoryRules = z.infer<typeof DirectoryRulesSchema>;

/**
 * A committed `.claude-use.json` (or its gitignored `.claude-use.local.json` sibling). Structurally a directory rule without the `path` field: its scope is implicit — wherever the file lives, and everything below it — which is exactly what makes it portable across clone locations.
 */
export const PortableConfigSchema = ConfigProfileSchema.omit({ description: true }).extend({
  configProfile: z.string().min(1).optional(),
  identity: z.string().min(1).optional(),
  when: WhenSchema.optional(),
});
export type PortableConfig = z.infer<typeof PortableConfigSchema>;

/**
 * The user-global headroom daemon block: how claude-use installs and supervises the local headroom proxy when a launch routes through it. Deliberately global-only: the daemon is one per machine (one per CLAUDE_USE_HOME), so a per-directory or per-profile setting would be a claim about the same singleton from several places at once.
 */
const HeadroomGlobalConfigSchema = z.strictObject({
  /** Install spec handed to `uv tool install`. Defaults to HEADROOM_DEFAULT_SOURCE. */
  source: z.string().min(1).optional(),
  /** How long the daemon may sit with no registered sessions before the supervisor stops it. Defaults to HEADROOM_DEFAULT_IDLE_SHUTDOWN_MINUTES. */
  idleShutdownMinutes: z.number().int().positive().optional(),
});

/**
 * The default `headroom.source` install spec: the ExaDev headroom repository, with the `proxy` extra that provides the `headroom proxy` entry point. Kept here rather than in the supervisor because it is the schema's own documented default, referenced by `HeadroomGlobalConfigSchema`'s field docs.
 */
export const HEADROOM_DEFAULT_SOURCE = "headroom-ai[proxy] @ git+https://github.com/ExaDev/headroom";

/**
 * The default `headroom.idleShutdownMinutes`: long enough that back-to-back sessions keep the daemon warm through a coffee break, short enough that an abandoned daemon frees its memory the same working day rather than squatting until reboot.
 */
export const HEADROOM_DEFAULT_IDLE_SHUTDOWN_MINUTES = 15;

/** The user-global `~/.claude-use/config.json`. */
export const GlobalConfigSchema = z.strictObject({
  $schema: z.string().optional(),
  defaultConfigProfile: z.string().min(1).optional(),
  walkUpLimit: z.string().min(1).optional(),
  categories: CategoryMapSchema.optional(),
  entries: EntriesSchema.optional(),
  launch: LaunchSchema.optional(),
  headroom: HeadroomGlobalConfigSchema.optional(),
});
export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;

/** An identity's own `identity.json`. */
export const IdentitySchema = z.strictObject({
  $schema: z.string().optional(),
  name: z
    .string()
    .min(1)
    // `@` is allowed in the body so an email address names its own identity directly (joseph.mearman@exadev.io), but the first character stays strictly alphanumeric: a leading `@` would collide with the `@name` selector syntax's first-`@` split and make an unconventional directory name under identities/.
    .regex(/^[A-Za-z0-9][A-Za-z0-9._@-]*$/),
  defaultConfigProfile: z.string().min(1).optional(),
  allowAmbientCredential: z.boolean().default(false),
});
export type Identity = z.infer<typeof IdentitySchema>;

/**
 * The OTHER "categories" concept, and a different shape from CategoryMapSchema entirely: this maps each category name to the list of literal names and globs whose top-level `~/.claude` entries belong to it. CategoryMapSchema says *whether* a category is shared; this says *which entries are in* a category. Do not conflate them.
 */
export const CategoryClassificationSchema = z.strictObject({
  $schema: z.string().optional(),
  secret: z.array(z.string().min(1)),
  runtime: z.array(z.string().min(1)),
  history: z.array(z.string().min(1)),
  knowledge: z.array(z.string().min(1)),
  settings: z.array(z.string().min(1)),
});
export type CategoryClassification = z.infer<typeof CategoryClassificationSchema>;

/** The gitignored `~/.claude-use/categories.local.json` overlay: any subset of the classification lists, answering "what category is this new entry?" without editing the shipped default map. */
export const CategoryClassificationOverlaySchema = z.strictObject({
  $schema: z.string().optional(),
  secret: z.array(z.string().min(1)).optional(),
  runtime: z.array(z.string().min(1)).optional(),
  history: z.array(z.string().min(1)).optional(),
  knowledge: z.array(z.string().min(1)).optional(),
  settings: z.array(z.string().min(1)).optional(),
});
export type CategoryClassificationOverlay = z.infer<typeof CategoryClassificationOverlaySchema>;

/**
 * Whether a category is shared when no configuration layer says otherwise. This is the final fallback beneath every layer of the cascade, matching the README's category table: every identity shares the same `knowledge`, `settings`, and `history` out of the box — only `runtime` (live per-process/machine state that cannot be meaningfully shared) stays closed by default, and `secret` can never be shared at all. Identities differ in credentials, not in the data they see.
 */
export const SHIPPED_CATEGORY_DEFAULTS: Readonly<Record<CategoryName, boolean>> = Object.freeze({
  secret: false,
  runtime: false,
  history: true,
  knowledge: true,
  settings: true,
});
