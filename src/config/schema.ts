import path from "node:path";

import { z } from "zod";

import { NUMERIC_DOTTED_VERSION_RE } from "../versionDiscovery";

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
 * Expands the `all` pseudo-category key, dropping `all` itself from the result. `all: true` opens every category meant to be shared across identities, which is every overridable category except `runtime`: `runtime` holds live per-process and per-machine state (daemon locks and auth status, PIDs, IDE and shell snapshots) that must never be pooled across running identities, so it opens only when named explicitly. `all: false` closes every overridable category, `runtime` included, so it also closes a `runtime` an earlier layer opened. An explicit named category always wins over the `all` expansion regardless of where it appears relative to `all` in the input: `{ all: true, runtime: true }` opens `runtime` too, and `{ all: true, history: false }` means "share everything except history", not "history is false, then immediately overwritten back to true".
 *
 * This is the one shared implementation `CategoryMapSchema`'s own transform, `launcher/cliOverride.ts`'s `--category`/`AGENT_SHIM_CATEGORY_OVERRIDE` handling, and `configProfiles.ts`'s `agent-shim profile set --category` all call, so `all` means the same thing regardless of which of those three input paths it arrived through.
 */
export function expandAllCategoryKey(pairs: Readonly<Record<string, boolean>>): Record<string, boolean> {
  const { all, ...rest } = pairs;
  if (all === undefined) {
    return { ...rest };
  }
  const expanded = Object.fromEntries(OVERRIDABLE_CATEGORIES.filter((category) => !all || category !== "runtime").map((category) => [category, all]));
  return { ...expanded, ...rest };
}

/**
 * The category toggle map as written by hand: the four overridable categories, plus `all` as shorthand for "every shareable category at once" (expanded by `expandAllCategoryKey` above). `secret` is omitted from the shape entirely, so `{ "categories": { "secret": true } }` is rejected at parse time rather than relying solely on the resolver's runtime floor check. The closed shape is also what lets the published JSON Schema offer real key-name autocomplete, which an open record type cannot.
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
 * A conditional guard on an entries value or a whole directory rule. Every field present within one `when` object must hold (AND logic). An empty object is vacuously true — `agent-shim check` warns about it, it is never an error.
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
  trackUsage: z.boolean().optional(),
  /** The exact Claude Code version to run, as it is named in Claude Code's versions directory (`2.1.220`). A pin that is not installed fails the launch; it never falls back to the highest version. */
  claudeVersion: z.string().regex(NUMERIC_DOTTED_VERSION_RE, "must be an exact dotted-numeric Claude Code version such as 2.1.220").optional(),
});
export type LaunchFlags = z.infer<typeof LaunchSchema>;

/**
 * Where a resolved credential lands in the child's environment. `bearer` exports it as `ANTHROPIC_AUTH_TOKEN` (what relays and aggregators expect, and the default), `apiKey` as `ANTHROPIC_API_KEY` (sent as `x-api-key`, what a regular Anthropic API key needs), and `oauthToken` as `CLAUDE_CODE_OAUTH_TOKEN` (a long-lived subscription token from `claude setup-token`). `oauthToken` authenticates a login, not an endpoint, so only an identity may use it; see `PROVIDER_CREDENTIAL_TARGETS`.
 */
export const CREDENTIAL_TARGETS = ["bearer", "apiKey", "oauthToken"] as const;
export type CredentialTarget = (typeof CREDENTIAL_TARGETS)[number];

/** The targets a provider's credential may use: every target except `oauthToken`, which only an identity can carry. */
export const PROVIDER_CREDENTIAL_TARGETS = ["bearer", "apiKey"] as const;

/** The environment variable each credential target exports the token as. These are also the variables no provider `env` block may set, since agent-shim sets and clears them itself. */
export const CREDENTIAL_TARGET_VARS = {
  bearer: "ANTHROPIC_AUTH_TOKEN",
  apiKey: "ANTHROPIC_API_KEY",
  oauthToken: "CLAUDE_CODE_OAUTH_TOKEN",
} as const satisfies Record<CredentialTarget, string>;
export type CredentialTargetVar = (typeof CREDENTIAL_TARGET_VARS)[CredentialTarget];

/** A command argv: a non-empty program name, then any arguments. Run directly, never through a shell. */
const ArgvSchema = z.tuple([z.string().min(1)], z.string());

/** The options every command-backed source (`command`, `op`, `keychain`) shares. */
const CommandSourceOptions = {
  /** True when running the command needs a person present (a desktop-unlocked secret store's approval prompt), so it is skipped when there is neither a terminal nor a desktop session. Defaults per source kind; see `isInteractiveSource`. */
  interactive: z.boolean().optional(),
  /** How long the command may run before it is killed and counted as failed. Defaults to `CREDENTIAL_COMMAND_TIMEOUT_MS`, or `CREDENTIAL_INTERACTIVE_TIMEOUT_MS` for an interactive source. */
  timeoutMs: z.int().positive().optional(),
};

/**
 * One place a credential can come from. Each kind is an object with exactly one kind-naming key, so the kinds are told apart by which key is present rather than by a separate tag, and `strictObject` rejects an object naming two.
 *
 * - `env`: the NAME of an environment variable in the launching shell, never its value.
 * - `file`: an absolute or `~`-rooted path to a file holding the token, which must not be readable or writable by group or others (mode 600 or stricter).
 * - `command`: an argv run at launch whose trimmed stdout is the token, so the credential exists only in the child.
 * - `op`: a 1Password secret reference, run as `op read <ref>`. A 1Password service account needs nothing here: `OP_SERVICE_ACCOUNT_TOKEN` in the launching environment is inherited by the command.
 * - `keychain`: a macOS Keychain generic password, run as `security find-generic-password -s <service> [-a <account>] -w`.
 * - `literal`: a fixed value written in the file itself. It is NOT a place for a secret: it exists for local proxies that accept any placeholder token (a codex-translation proxy, say) and so have no real credential to keep out of committed config. Anything with a real credential must use one of the other kinds.
 */
export const CredentialSourceSchema = z.union([
  z.strictObject({ env: z.string().min(1) }),
  z.strictObject({
    file: z
      .string()
      .min(1)
      .refine((filePath) => filePath.startsWith("~/") || path.isAbsolute(filePath), {
        message: "a credential file must be an absolute or ~-rooted path, since a launch can start in any directory",
      }),
  }),
  z.strictObject({ command: ArgvSchema, ...CommandSourceOptions }),
  z.strictObject({ op: z.string().startsWith("op://"), ...CommandSourceOptions }),
  z.strictObject({
    keychain: z.strictObject({ service: z.string().min(1), account: z.string().min(1).optional() }),
    ...CommandSourceOptions,
  }),
  z.strictObject({ literal: z.string().min(1) }),
]);
export type CredentialSource = z.infer<typeof CredentialSourceSchema>;

/** Where a cached credential is kept: the macOS login Keychain, or a mode-0600 file under the agent-shim home. */
export const CREDENTIAL_CACHE_STORES = ["keychain", "file"] as const;
export type CredentialCacheStore = (typeof CREDENTIAL_CACHE_STORES)[number];

/**
 * An optional cache on a credential block: the resolved token is kept for `ttl` (a whole number followed by `s`, `m`, `h` or `d`, for example `12h`) so a launch does not re-run a source that needs a person, such as a desktop-unlocked `op`. With no `ttl` the cached token never expires and is replaced only by `credential warm` or removed by `credential forget`. `store` defaults to the Keychain on macOS and a file elsewhere. A block with no `cache` stores nothing and fetches on every launch.
 */
export const CredentialCacheSchema = z.strictObject({
  ttl: z
    .string()
    .regex(/^[1-9]\d*[smhd]$/, { message: "ttl is a whole number followed by s, m, h or d, for example 12h" })
    .optional(),
  store: z.enum(CREDENTIAL_CACHE_STORES).optional(),
});
export type CredentialCache = z.infer<typeof CredentialCacheSchema>;

/**
 * The credential block providers and identities share: an ordered list of sources, tried in turn until one yields a non-empty token, and the target that token is exported as. `target` defaults to `bearer`.
 */
export const CredentialSchema = z.strictObject({
  sources: z.array(CredentialSourceSchema).min(1),
  target: z.enum(CREDENTIAL_TARGETS).optional(),
  cache: CredentialCacheSchema.optional(),
});
export type Credential = z.infer<typeof CredentialSchema>;

/** A provider's credential block: `CredentialSchema` with `target` narrowed to `PROVIDER_CREDENTIAL_TARGETS`. */
const ProviderCredentialSchema = CredentialSchema.extend({ target: z.enum(PROVIDER_CREDENTIAL_TARGETS).optional() });

/** The variables a provider's `env` block may not name, because the credential target sets one of them and agent-shim removes the others from the child's environment. */
const RESERVED_PROVIDER_ENV_KEYS: readonly string[] = Object.values(CREDENTIAL_TARGET_VARS);

/** A provider's extra environment entries: any variable except the credential variables, which the credential block owns. */
const ProviderEnvSchema = z
  .record(z.string().min(1), z.string())
  .refine((env) => !Object.keys(env).some((key) => RESERVED_PROVIDER_ENV_KEYS.includes(key)), {
    message: `env may not set ${RESERVED_PROVIDER_ENV_KEYS.join(", ")}: the credential block's target sets one and agent-shim removes the others`,
  });

/** The kinds of provider: `http` is an Anthropic Messages endpoint at a fixed `baseUrl` (the default when `kind` is absent), and `codex` is ChatGPT's Codex backend reached through agent-shim's own supervised translation daemon. */
export const PROVIDER_KINDS = ["http", "codex"] as const;

/**
 * The Claude model tiers the codex translator maps, in the order they are matched: the first tier whose name is a substring of the requested model (case-insensitive) decides the codex model. `fable` comes before `opus` because a fable model name is the most specific.
 */
export const CODEX_TIERS = ["fable", "opus", "sonnet", "haiku"] as const;
export type CodexTier = (typeof CODEX_TIERS)[number];

/** The reasoning efforts the codex backend accepts, plus `none`, which omits the reasoning block from the upstream request entirely. */
export const CODEX_EFFORTS = ["none", "low", "medium", "high"] as const;
export type CodexEffort = (typeof CODEX_EFFORTS)[number];

/**
 * Where a codex provider's upstream credential comes from. `codex-cli` replays the Codex CLI's own login (`~/.codex/auth.json`) against ChatGPT's Codex backend; `chatgpt-sign-in` uses the Sign in with ChatGPT grant that `agent-shim codex login` creates, spent against OpenAI's public Responses API.
 */
export const CODEX_LOGINS = ["codex-cli", "chatgpt-sign-in"] as const;
export type CodexLogin = (typeof CODEX_LOGINS)[number];

/** The login a codex provider uses when its `codex` block names none. */
export const CODEX_DEFAULT_LOGIN: CodexLogin = "codex-cli";

/** The codex model every tier maps to when neither its own tier entry nor `defaultModel` says otherwise. */
export const CODEX_DEFAULT_MODEL = "gpt-5.6-sol";

/** The shipped tier mapping: the flagship model for fable and opus, the mid-size one for sonnet, the small one for haiku. */
export const CODEX_DEFAULT_TIER_MODELS: Readonly<Record<CodexTier, string>> = Object.freeze({
  fable: "gpt-5.6-sol",
  opus: "gpt-5.6-sol",
  sonnet: "gpt-5.6-terra",
  haiku: "gpt-5.6-luna",
});

/** The shipped reasoning effort for a request that does not ask for one the backend accepts. */
export const CODEX_DEFAULT_EFFORT: CodexEffort = "low";

/**
 * How a codex provider translates Claude Code's requests. Every field is optional and defaults to the shipped mapping (`CODEX_DEFAULT_MODEL`, `CODEX_DEFAULT_TIER_MODELS`, `CODEX_DEFAULT_EFFORT`), so an absent block means the stock behaviour. A requested model that already names a codex model (`gpt-...`) passes through untouched whatever this says.
 */
export const CodexProviderConfigSchema = z.strictObject({
  /** The codex model a request maps to when no tier matches its model name. */
  defaultModel: z.string().min(1).optional(),
  /** Per-tier overrides of the shipped mapping, matched by substring of the requested model name in `CODEX_TIERS` order. */
  models: z
    .strictObject({
      fable: z.string().min(1).optional(),
      opus: z.string().min(1).optional(),
      sonnet: z.string().min(1).optional(),
      haiku: z.string().min(1).optional(),
    } satisfies Record<CodexTier, z.ZodType>)
    .optional(),
  /** The reasoning effort used when the request's own `output_config.effort` is not one the backend accepts. */
  effort: z.enum(CODEX_EFFORTS).optional(),
  /** Which login the upstream call is made with; see `CODEX_LOGINS`. */
  login: z.enum(CODEX_LOGINS).optional(),
});
export type CodexProviderConfig = z.infer<typeof CodexProviderConfigSchema>;

/**
 * A named API provider at `~/.agent-shim/providers/<name>.json`: which endpoint the child Claude Code talks to, where its token comes from, and any static extra environment entries the child needs to use that endpoint.
 *
 * Two kinds, told apart by `kind`. An `http` provider (the default, so `kind` may be omitted) names a fixed Anthropic-compatible `baseUrl`. A `codex` provider has no `baseUrl` at all: the launcher starts agent-shim's supervised codex translation daemon and points the child at the daemon's address, which only exists at launch time, and the provider's optional `codex` block configures the translation.
 *
 * `credential` is required for both kinds, since a provider launch has to give Claude Code a token to send. A provider file is ordinary committed config, so none of its sources holds a secret (a `literal` source is by definition a non-secret placeholder, which is exactly what a codex provider needs: the daemon authenticates upstream with the Codex CLI's own login and ignores the token Claude Code sends it). `env` may not name a credential variable (`ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`) at all: the credential target sets one and the launcher removes the other two, so a value there would either be overwritten or be a second credential hiding outside the block.
 */
const HttpProviderSchema = z.strictObject({
  $schema: z.string().optional(),
  kind: z.literal("http").optional(),
  displayName: z.string().min(1),
  baseUrl: z.url(),
  credential: ProviderCredentialSchema,
  env: ProviderEnvSchema.optional(),
});

/** A `codex` provider: see `ProviderSchema`. */
const CodexProviderSchema = z.strictObject({
  $schema: z.string().optional(),
  kind: z.literal("codex"),
  displayName: z.string().min(1),
  credential: ProviderCredentialSchema,
  env: ProviderEnvSchema.optional(),
  codex: CodexProviderConfigSchema.optional(),
});
export type CodexProvider = z.infer<typeof CodexProviderSchema>;

/** Either kind of provider; see `HttpProviderSchema` for the shared fields. */
export const ProviderSchema = z.discriminatedUnion("kind", [HttpProviderSchema, CodexProviderSchema]);
export type Provider = z.infer<typeof ProviderSchema>;

/** True when `provider` is a codex provider. `kind` is the tag, since a codex provider's own distinguishing block is optional. */
export function isCodexProvider(provider: Provider): provider is CodexProvider {
  return provider.kind === "codex";
}

/**
 * A named, reusable configuration profile at `~/.agent-shim/config-profiles/<name>.json`.
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

/** The prefix that turns a pool name into an identity selector. `:` is outside an identity name's character set, so a selector can never be mistaken for an identity. */
export const POOL_SELECTOR_PREFIX = "pool:";

const POOL_NAME_PATTERN = "[A-Za-z0-9][A-Za-z0-9._-]*";
const IDENTITY_NAME_PATTERN = "[A-Za-z0-9][A-Za-z0-9._@-]*";

/** A pool's own name: the identity alphabet minus `@`, since a pool is never an email address. */
export const PoolNameSchema = z.string().min(1).regex(new RegExp(`^${POOL_NAME_PATTERN}$`));

/** One `pool:`-prefixed pool name or bare identity name, the union every selector surface accepts. `:` is outside an identity name's character set, so the two can never collide. */
const SELECTOR_RE = new RegExp(`^(${POOL_SELECTOR_PREFIX}${POOL_NAME_PATTERN}|${IDENTITY_NAME_PATTERN})$`);

/** What a directory rule, a portable config or the active-identity file may name: a concrete identity, or `pool:<name>` to have agent-shim pick one member of a pool at launch. */
const IdentitySelectorSchema = z.string().min(1).regex(SELECTOR_RE);

/** A pool's member entry: a concrete identity, or `pool:<name>` to nest another pool as a member, evaluated with that pool's own policy at the position the entry occupies. The same union an identity selector accepts. */
export const PoolMemberSchema = z.string().min(1).regex(SELECTOR_RE);

/** The preference modes a pool may choose among its members with. */
export const POOL_PREFERENCES = ["score", "listed"] as const;

/** How a pool chooses the member a launch runs as: "score" by remaining quota, "listed" in the order the pool names its members. */
export const PoolPreferenceSchema = z.enum(POOL_PREFERENCES);
export type PoolPreference = z.infer<typeof PoolPreferenceSchema>;

/**
 * A named, explicit set of identities to choose among at launch. Never implicit: a pool lists its members, so an identity that bills a client is only ever picked when someone put it there.
 *
 * A member entry may name another pool (`pool:<name>`), which is ranked with its own preference and contributes its pick at the entry's position; see `PoolMemberSchema`. The graph must stay acyclic, which `pool add`/`pool set` enforce and `doctor` re-checks.
 *
 * `preference` decides how the member is chosen, and an absent field means "score". "score" ranks members by plan-size-weighted remaining quota per hour until reset, so the quota closest to expiring is spent first (use-it-or-lose-it). "listed" ranks members strictly in the order the pool lists them, skipping only a member that is currently refused, so a pool can pin one identity first and fall back to the others only while that one is refused.
 */
export const PoolSchema = z.strictObject({
  identities: z.array(PoolMemberSchema).min(1).refine((members) => new Set(members).size === members.length, { message: "pool members must be unique" }),
  preference: PoolPreferenceSchema.optional(),
});
export type Pool = z.infer<typeof PoolSchema>;

/** One directory rule in `~/.agent-shim/directory-rules.json`, scoped to an explicit absolute (or `~`-rooted) path. */
export const DirectoryRuleSchema = ConfigProfileSchema.omit({ description: true }).extend({
  path: z.string().min(1),
  configProfile: z.string().min(1).optional(),
  identity: IdentitySelectorSchema.optional(),
  when: WhenSchema.optional(),
});
export type DirectoryRule = z.infer<typeof DirectoryRuleSchema>;

/** The `~/.agent-shim/directory-rules.json` file. */
export const DirectoryRulesSchema = z.strictObject({
  $schema: z.string().optional(),
  rules: z.array(DirectoryRuleSchema),
});
export type DirectoryRules = z.infer<typeof DirectoryRulesSchema>;

/**
 * A committed `.agent-shim.json` (or its gitignored `.agent-shim.local.json` sibling). Structurally a directory rule without the `path` field: its scope is implicit — wherever the file lives, and everything below it — which is exactly what makes it portable across clone locations.
 */
export const PortableConfigSchema = ConfigProfileSchema.omit({ description: true }).extend({
  configProfile: z.string().min(1).optional(),
  identity: IdentitySelectorSchema.optional(),
  when: WhenSchema.optional(),
});
export type PortableConfig = z.infer<typeof PortableConfigSchema>;

/**
 * The user-global headroom daemon block: how agent-shim installs and supervises the local headroom proxy when a launch routes through it. Deliberately global-only: the daemon is one per machine (one per AGENT_SHIM_HOME), so a per-directory or per-profile setting would be a claim about the same singleton from several places at once.
 */
/** `cache` freezes earlier turns for provider prefix-cache hits; `token` may rewrite them for more compression. */
const HEADROOM_MODES = ["cache", "token"] as const;

/** `default` keeps headroom's retrieval markers and `headroom_retrieve` tool; `lossless` compacts tool output with no markers; `none` drops both the markers and the tool, so an original cannot be recovered. */
const HEADROOM_CCR_MODES = ["default", "lossless", "none"] as const;

/** The release channels headroom gates its experimental features behind. `beta` unlocks read maturation, `canary` the tool-result interceptors, and `dev` both. */
const HEADROOM_ROLLOUT_CHANNELS = ["beta", "canary", "dev"] as const;

/** Channels that unlock tool-result interceptors. */
const INTERCEPT_CHANNELS: readonly string[] = ["canary", "dev"];

/** Channels that unlock read maturation. */
const READ_MATURATION_CHANNELS: readonly string[] = ["beta", "dev"];

const HeadroomGlobalConfigObjectSchema = z.strictObject({
  /** Install spec handed to `uv tool install`. Defaults to HEADROOM_DEFAULT_SOURCE. */
  source: z.string().min(1).optional(),
  /** How long the daemon may sit with no registered sessions before the supervisor stops it. Defaults to HEADROOM_DEFAULT_IDLE_SHUTDOWN_MINUTES. */
  idleShutdownMinutes: z.number().int().positive().optional(),
  /** Optimisation mode, passed as `--mode`. Unset leaves headroom's own default (`cache`). */
  mode: z.enum(HEADROOM_MODES).optional(),
  /** Keep-ratio for prose and code compression, passed as `--target-ratio`: lower is more aggressive. Unset lets headroom decide. */
  targetRatio: z.number().gt(0).max(1).optional(),
  /** How compressed tool output stays recoverable. Unset leaves headroom's own default (`default`). */
  ccr: z.enum(HEADROOM_CCR_MODES).optional(),
  /** Headroom's experimental release channel, exported as `HEADROOM_ROLLOUT_CHANNEL`. Required by `interceptToolResults` and `readMaturation`, which are refused without a channel that unlocks them. */
  rolloutChannel: z.enum(HEADROOM_ROLLOUT_CHANNELS).optional(),
  /** Opt in to headroom's tool-result interceptors (`--intercept-tool-results`). Needs `rolloutChannel` canary or dev. */
  interceptToolResults: z.boolean().optional(),
  /** Opt in to headroom's experimental read maturation (`--read-maturation`). Needs `rolloutChannel` beta or dev. */
  readMaturation: z.boolean().optional(),
});

const HeadroomGlobalConfigSchema = HeadroomGlobalConfigObjectSchema.superRefine((config, context) => {
  if (config.interceptToolResults === true && !INTERCEPT_CHANNELS.includes(config.rolloutChannel ?? "")) {
    context.addIssue({ code: "custom", path: ["interceptToolResults"], message: "interceptToolResults needs rolloutChannel canary or dev" });
  }
  if (config.readMaturation === true && !READ_MATURATION_CHANNELS.includes(config.rolloutChannel ?? "")) {
    context.addIssue({ code: "custom", path: ["readMaturation"], message: "readMaturation needs rolloutChannel beta or dev" });
  }
});
export type HeadroomGlobalConfig = z.infer<typeof HeadroomGlobalConfigSchema>;

/**
 * The default `headroom.source` install spec: the ExaDev headroom repository, with the `proxy` extra that provides the `headroom proxy` entry point. Pinned to a full commit SHA on the fork's `main` that carries both the per-session savings work and `headroom proxy --uds` (the unix-socket listener the supervisor starts the daemon on), because a branch name can be rebased or deleted and would change or break every fresh install; bump it deliberately when the fork changes either. Kept here rather than in the supervisor because it is the schema's own documented default, referenced by `HeadroomGlobalConfigSchema`'s field docs.
 */
export const HEADROOM_DEFAULT_SOURCE = "headroom-ai[proxy] @ git+https://github.com/ExaDev/headroom@53525f479f2f48e8ef6b08cf729601feab7d2382";

/**
 * The default `headroom.idleShutdownMinutes`: long enough that back-to-back sessions keep the daemon warm through a coffee break, short enough that an abandoned daemon frees its memory the same working day rather than squatting until reboot.
 */
export const HEADROOM_DEFAULT_IDLE_SHUTDOWN_MINUTES = 15;

/**
 * The default `frontdoor.idleShutdownMinutes`, the same trade-off as headroom's: warm through a break, gone the same working day once abandoned.
 */
export const FRONTDOOR_DEFAULT_IDLE_SHUTDOWN_MINUTES = 15;

/** The user-global front-door daemon block. Global-only for the same reason as headroom's: there is one front door per AGENT_SHIM_HOME, serving every routed session. */
const FrontDoorGlobalConfigSchema = z.strictObject({
  /** How long the front door may sit with no registered sessions before it closes and exits. Defaults to FRONTDOOR_DEFAULT_IDLE_SHUTDOWN_MINUTES. */
  idleShutdownMinutes: z.number().int().positive().optional(),
});

/** The user-global `~/.agent-shim/config.json`. */
export const GlobalConfigSchema = z.strictObject({
  $schema: z.string().optional(),
  defaultConfigProfile: z.string().min(1).optional(),
  walkUpLimit: z.string().min(1).optional(),
  categories: CategoryMapSchema.optional(),
  entries: EntriesSchema.optional(),
  launch: LaunchSchema.optional(),
  headroom: HeadroomGlobalConfigSchema.optional(),
  frontdoor: FrontDoorGlobalConfigSchema.optional(),
  pools: z.record(PoolNameSchema, PoolSchema).optional(),
});
export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;

/**
 * An identity's own `identity.json`. `credential`, when present, authenticates the identity from a token instead of (or ahead of) its stored login: the launcher resolves it and exports it as its target (typically `oauthToken`, a `claude setup-token` token) in the child's environment only. Without it the identity uses the login stored in its own directory.
 */
export const IdentitySchema = z.strictObject({
  $schema: z.string().optional(),
  name: z
    .string()
    .min(1)
    // `@` is allowed in the body so an email address names its own identity directly (joseph.mearman@exadev.io), but the first character stays strictly alphanumeric: a leading `@` would collide with the `@name` selector syntax's first-`@` split and make an unconventional directory name under identities/.
    .regex(/^[A-Za-z0-9][A-Za-z0-9._@-]*$/),
  defaultConfigProfile: z.string().min(1).optional(),
  allowAmbientCredential: z.boolean().default(false),
  credential: CredentialSchema.optional(),
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

/** The gitignored `~/.agent-shim/categories.local.json` overlay: any subset of the classification lists, answering "what category is this new entry?" without editing the shipped default map. */
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
