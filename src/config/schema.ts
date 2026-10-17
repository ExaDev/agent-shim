import path from "node:path";

import { z } from "zod";
import { PredicateNodeSchema } from "trilean";

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
export const WhenConditionObjectSchema = z.strictObject({
  newerThan: DurationSchema.optional(),
  olderThan: DurationSchema.optional(),
  maxSizeBytes: z.int().positive().optional(),
  branch: z.string().min(1).optional(),
  env: z.record(z.string().min(1), z.string()).optional(),
});

/**
 * A `when` condition, in either form. The object form is the original sugar (every present field must hold); the predicate form is a trilean predicate tree, which expresses OR and NOT and reports a missing fact as indeterminate rather than failed. The two are one union, not a migration: every existing configuration keeps parsing, and `evaluateWhen` gives the object form the same semantics it always had by mapping it onto the equivalent predicates.
 */
export const WhenSchema = z.union([WhenConditionObjectSchema, PredicateNodeSchema]);
export type WhenConditionObject = z.output<typeof WhenConditionObjectSchema>;
export type WhenCondition = z.output<typeof WhenSchema>;

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
  /** How long the launcher waits after its own output before it starts claude, so that output can be read before Claude Code takes over the terminal (`5s`, `500ms`). Applies only when a terminal is watching. */
  delay: z.string().regex(DURATION_RE, "must be a duration such as 5s or 500ms").optional(),
  /** Whether the launcher waits for a key press after its own output before it starts claude. Takes the place of `delay` when both are set. Applies only when a terminal is watching. */
  pause: z.boolean().optional(),
  /** Whether a provider session routes provider-qualified model names (`z/glm-5.3`, `auto`) through the `models` block to the provider that serves them, instead of sending every request to the launch provider. */
  routeByName: z.boolean().optional(),
  /** Whether the launcher's report, for a launch that picks from a pool, lists every member the pick ranked with why each stands where it does, and not only the member it picked. */
  explain: z.boolean().optional(),
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

const EnvCredentialSourceSchema = z.strictObject({ env: z.string().min(1) });
const FileCredentialSourceSchema = z.strictObject({
  file: z
    .string()
    .min(1)
    .refine((filePath) => filePath.startsWith("~/") || path.isAbsolute(filePath), {
      message: "a credential file must be an absolute or ~-rooted path, since a launch can start in any directory",
    }),
});
const CommandCredentialSourceSchema = z.strictObject({ command: ArgvSchema, ...CommandSourceOptions });
const OpCredentialSourceSchema = z.strictObject({ op: z.string().startsWith("op://"), ...CommandSourceOptions });
const KeychainCredentialSourceSchema = z.strictObject({
  keychain: z.strictObject({ service: z.string().min(1), account: z.string().min(1).optional() }),
  ...CommandSourceOptions,
});
const LiteralCredentialSourceSchema = z.strictObject({ literal: z.string().min(1) });

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
  EnvCredentialSourceSchema,
  FileCredentialSourceSchema,
  CommandCredentialSourceSchema,
  OpCredentialSourceSchema,
  KeychainCredentialSourceSchema,
  LiteralCredentialSourceSchema,
]);

/**
 * `CredentialSourceSchema` without the `command` kind, the sources a caller that is not at the machine's own command line may set: a `command` source runs an argv as the user at every launch, so accepting one from a network caller would be remote code execution for whoever holds the credential that authenticates it. Every other kind only reads a named place (a variable, a file, a 1Password reference, a Keychain item) or carries a placeholder.
 */
export const RemoteCredentialSourceSchema = z.union([
  EnvCredentialSourceSchema,
  FileCredentialSourceSchema,
  OpCredentialSourceSchema,
  KeychainCredentialSourceSchema,
  LiteralCredentialSourceSchema,
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
export const PROVIDER_KINDS = ["http", "codex", "antigravity", "router"] as const;

/**
 * The operational modes for an Antigravity provider: `cloud` makes direct HTTPS calls to Google Gemini API or Vertex AI; `local` communicates with an Agent Client Protocol (ACP) server or local daemon.
 */
export const ANTIGRAVITY_MODES = ["cloud", "local"] as const;
export type AntigravityMode = (typeof ANTIGRAVITY_MODES)[number];

/** The Claude model tiers a provider maps onto its own models, highest first. */
export const CLAUDE_TIERS = ["fable", "opus", "sonnet", "haiku"] as const;
export type ClaudeTier = (typeof CLAUDE_TIERS)[number];


export const ANTIGRAVITY_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"] as const;
export type AntigravityEffort = (typeof ANTIGRAVITY_EFFORTS)[number];

export const ANTIGRAVITY_DEFAULT_MODE: AntigravityMode = "cloud";
export const ANTIGRAVITY_DEFAULT_MODEL = "gemini-3.8-flash-high";
/**
 * Each tier's shipped candidates in preference order, over the families the backend serves (the third-party Claude models, Gemini 4 Argon and Gemini Flash), whose quota windows are separate, so a request whose first choice is spent is served from a family that still has quota. Fable leads with Gemini 4 Argon, the backend's own default agent model and first in its recommended order; opus and sonnet lead with the Claude model of their name; haiku leads with Gemini Flash, which has no Claude counterpart. Every candidate holds a context window of a million tokens: the backend's open GPT-OSS model holds a ninth of that, too little for a Claude Code conversation to fall back to. Every name is one the backend lists as served.
 */
export const ANTIGRAVITY_DEFAULT_TIER_MODELS: Readonly<Record<ClaudeTier, readonly string[]>> = Object.freeze({
  fable: ["gemini-4-argon-high", "claude-opus-5-5-high", "gemini-3.8-flash-high"],
  opus: ["claude-opus-5-5-high", "gemini-4-argon-high", "gemini-3.8-flash-high"],
  sonnet: ["claude-sonnet-5-5-medium", "gemini-4-argon-medium", "gemini-3.8-flash-medium"],
  haiku: ["gemini-3.8-flash-low", "gemini-4-argon-low", "claude-sonnet-5-5-low"],
});
export const ANTIGRAVITY_DEFAULT_EFFORT: AntigravityEffort = "low";

/** One backend model, or an ordered list of candidates a request is routed across by available quota. */
const AntigravityModelTargetSchema = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);

/**
 * How an Antigravity provider translates Claude Code's requests and connects to its backend.
 */
export const AntigravityProviderConfigSchema = z.strictObject({
  /** Operational mode: direct cloud endpoint or local ACP daemon. Defaults to `cloud`. */
  mode: z.enum(ANTIGRAVITY_MODES).optional(),
  /** The model a request maps to when no tier matches its model name. */
  defaultModel: z.string().min(1).optional(),
  /** Model name mapping. A key naming a tier (`fable`, `opus`, `sonnet`, `haiku`) overrides that tier's shipped model and is matched by substring of the requested name in `CLAUDE_TIERS` order; any other key is an alias, matched against the whole requested name case-insensitively, so `/model <alias>` selects its backend model. An alias outranks every other rule, including the pass-through of backend names. A value is one model or an ordered list of candidates: the request goes to the first whose quota windows are not spent, and when every candidate is spent, to the one whose binding window lifts soonest. */
  models: z.record(z.string().min(1), AntigravityModelTargetSchema).optional(),
  /** When every candidate of the tier a request names has no quota left, serve it from the next tier down, and onward through the lower tiers, instead of failing with the quota limit. Applies to a name that selects a tier (`/model fable`), not to an alias or a backend model name. Defaults to false. */
  degradeDownTiers: z.boolean().optional(),
  /** The reasoning effort used when the request's own effort is not one the backend accepts. */
  effort: z.enum(ANTIGRAVITY_EFFORTS).optional(),
  /** Cloud-specific settings (for `mode: "cloud"`). */
  cloud: z
    .strictObject({
      /** Google Gemini API or custom gateway endpoint. Defaults to `https://generativelanguage.googleapis.com`. */
      endpoint: z.url().optional(),
      /** Google Cloud Project ID (when using Vertex AI). */
      projectId: z.string().min(1).optional(),
      /** Google Cloud location/region (when using Vertex AI). */
      location: z.string().min(1).optional(),
    })
    .optional(),
  /** Local-specific settings (for `mode: "local"`). */
  local: z
    .strictObject({
      /** Command and arguments to spawn the ACP server process. */
      command: z.array(z.string().min(1)).min(1).optional(),
      /** Path to an existing Unix domain socket to connect to instead of spawning a process. */
      socketPath: z.string().min(1).optional(),
    })
    .optional(),
});
export type AntigravityProviderConfig = z.infer<typeof AntigravityProviderConfigSchema>;

/**
 * The Claude model tiers the codex translator maps, in the order they are matched: the first tier whose name is a substring of the requested model (case-insensitive) decides the codex model. `fable` comes before `opus` because a fable model name is the most specific.
 */

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
export const CODEX_DEFAULT_TIER_MODELS: Readonly<Record<ClaudeTier, string>> = Object.freeze({
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
  /** Per-tier overrides of the shipped mapping, matched by substring of the requested model name in `CLAUDE_TIERS` order. */
  models: z
    .strictObject({
      fable: z.string().min(1).optional(),
      opus: z.string().min(1).optional(),
      sonnet: z.string().min(1).optional(),
      haiku: z.string().min(1).optional(),
    } satisfies Record<ClaudeTier, z.ZodType>)
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
/** One per-request route of an `http` provider's `routes` list: the condition a request is matched against, and the provider a match sends it to. The first entry whose condition is definitely true wins; an undecided condition (a request the door could not read, or a fact this embedding does not provide) falls through to the next entry, so a routing table never lands an unreadable request on a cheaper provider by accident. */
const ProviderRouteSchema = z.strictObject({
  /** The condition, the same `when` union a configuration cascade entry takes: the object form or a trilean predicate tree over the request facts the door resolves (`request.model` and kin). */
  when: WhenSchema,
  /** The provider a matching request is sent to, by the name a provider file carries. */
  provider: z.string().min(1),
  /** The model name to rewrite the request to before it reaches the target, for a provider that expects another form (OpenRouter's `anthropic/claude-...` for instance). A route that rewrites reads the whole body, the one copy the rewrite needs. */
  model: z.string().min(1).optional(),
});

/**
 * A model a provider serves that `/model` should list beside the ones its tier settings name. `tier` is the Claude tier whose client-side handling (prompt profile, effort defaults) the row borrows, since Claude Code knows no handling for a model it has not heard of. `label` defaults to the model name and `description` to a generic line.
 */
export const PickerModelSchema = z.strictObject({
  model: z.string().min(1),
  tier: z.enum(CLAUDE_TIERS),
  label: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
});
export type PickerModel = z.infer<typeof PickerModelSchema>;

/** The `pickerModels` list every provider kind accepts. A model named twice would make two rows that select the same thing, so the list is refused. */
const PickerModelsSchema = z.array(PickerModelSchema).refine((models) => new Set(models.map((entry) => entry.model)).size === models.length, { message: "pickerModels names a model more than once" });

/**
 * Opt-in listing of the models an `http` provider's own catalogue endpoint reports in `/model`. The door refreshes the catalogue in the background and a launch lists what it last fetched. `tier` is the Claude tier whose handling every listed model borrows, since the catalogue says nothing about it. `include` and `exclude` are glob patterns over model ids (`exclude` wins), because a large catalogue would bury the picker. `url` replaces the endpoint, which otherwise is the provider's `/v1/models` under its base URL, then under its host.
 */
export const ProviderCatalogueSchema = z.strictObject({
  tier: z.enum(CLAUDE_TIERS),
  include: z.array(z.string().min(1)).min(1).optional(),
  exclude: z.array(z.string().min(1)).min(1).optional(),
  url: z.url().optional(),
});
export type ProviderCatalogue = z.infer<typeof ProviderCatalogueSchema>;

const HttpProviderSchema = z.strictObject({
  $schema: z.string().optional(),
  kind: z.literal("http").optional(),
  displayName: z.string().min(1),
  baseUrl: z.url(),
  credential: ProviderCredentialSchema,
  env: ProviderEnvSchema.optional(),
  /** Extra models `/model` lists beside the ones the tier settings name. */
  pickerModels: PickerModelsSchema.optional(),
  /** The provider's own model catalogue, listed in `/model` when set. */
  catalogue: ProviderCatalogueSchema.optional(),
  /** Per-request routing: when present, each request this provider would serve is matched against the list in order, and the first definite match is sent to that entry's provider instead (itself resolved exactly as a directly dialled request would be). Unmatched requests stay on this provider. */
  routes: z.array(ProviderRouteSchema).optional(),
});
export type HttpProvider = z.infer<typeof HttpProviderSchema>;

/** A `codex` provider: see `ProviderSchema`. */
const CodexProviderSchema = z.strictObject({
  $schema: z.string().optional(),
  kind: z.literal("codex"),
  displayName: z.string().min(1),
  credential: ProviderCredentialSchema,
  env: ProviderEnvSchema.optional(),
  /** Extra models `/model` lists beside the ones the tier settings name. */
  pickerModels: PickerModelsSchema.optional(),
  codex: CodexProviderConfigSchema.optional(),
});
export type CodexProvider = z.infer<typeof CodexProviderSchema>;

/** A `router` provider: no endpoint and no credential of its own. A session launched on it has each request's model name resolved through the `models` block to a target provider, whose own kind handling and credential serve the request. */
const RouterProviderSchema = z.strictObject({
  $schema: z.string().optional(),
  kind: z.literal("router"),
  displayName: z.string().min(1),
});
export type RouterProvider = z.infer<typeof RouterProviderSchema>;

/** An `antigravity` provider: see `ProviderSchema`. */
const AntigravityProviderSchema = z.strictObject({
  $schema: z.string().optional(),
  kind: z.literal("antigravity"),
  displayName: z.string().min(1),
  credential: ProviderCredentialSchema,
  env: ProviderEnvSchema.optional(),
  /** Extra models `/model` lists beside the ones the tier settings name. */
  pickerModels: PickerModelsSchema.optional(),
  antigravity: AntigravityProviderConfigSchema.optional(),
});
export type AntigravityProvider = z.infer<typeof AntigravityProviderSchema>;

/** All kinds of provider; see `HttpProviderSchema` for the shared fields. */
export const ProviderSchema = z.discriminatedUnion("kind", [HttpProviderSchema, CodexProviderSchema, AntigravityProviderSchema, RouterProviderSchema]);
export type Provider = z.infer<typeof ProviderSchema>;

/** True when `provider` is an http provider. */
export function isHttpProvider(provider: Provider): provider is HttpProvider {
  return provider.kind === undefined || provider.kind === "http";
}

/** True when `provider` is a codex provider. `kind` is the tag, since a codex provider's own distinguishing block is optional. */
export function isCodexProvider(provider: Provider): provider is CodexProvider {
  return provider.kind === "codex";
}

/** True when `provider` is an antigravity provider. */
export function isRouterProvider(provider: Provider): provider is RouterProvider {
  return provider.kind === "router";
}

export function isAntigravityProvider(provider: Provider): provider is AntigravityProvider {
  return provider.kind === "antigravity";
}

/**
 * A named, reusable configuration profile at `~/.agent-shim/config-profiles/<name>.json`.
 *
 * `extends` is a flat array of other profiles' *names*, deliberately not a self-referential `z.lazy()` schema: nothing in this shape points back at a profile object, so each file validates in isolation and the extends graph is walked at resolve time. That also means Zod cannot detect a circular `extends` definition — the walker in `src/resolve/extends.ts` carries its own cycle guard.
 */
export const SELECTION_MODES = ["ordered", "most-allowance", "soonest-reset", "spread", "adaptive", "lowest-latency", "highest-success", "cheapest"] as const;
export type SelectionModeName = (typeof SELECTION_MODES)[number];

/** A virtual model: a named choice over members (provider models, account models, other virtual models, or whole model families), taken by its mode. */
const VirtualModelSchema = z.strictObject({
  /** How the virtual model chooses its member for a request. */
  mode: z.enum(SELECTION_MODES),
  /** The members to choose among, in preference order where the mode reads order. Each names a target (`z/glm-5.3`), an account model (`acct:work/opus`), another virtual model, or a family (`family:<canonical>`). */
  members: z.array(z.string().min(1)).min(1),
});
export type VirtualModel = z.infer<typeof VirtualModelSchema>;

/** Per-model prices, in USD per million tokens, for the `cheapest` mode. */
const ModelPricesSchema = z.strictObject({
  input: z.number().positive(),
  output: z.number().positive(),
});

/**
 * One family's own settings, keyed by the family's canonical key (`glm-5-1`, or `claude-opus-5-5+high` for one variant of a family). `names` pins refs or bare model names into the family where the normaliser cannot know they belong; `mode` is how a picker row that selects the whole family chooses among its targets (`ordered` when absent); the capability flags and `context` are shared by every target of the family, so `adaptive` reads the family rather than a hand-tagged target. A capability left out is taken as supported.
 */
const FamilySettingsSchema = z.strictObject({
  names: z.array(z.string().min(1)).optional(),
  mode: z.enum(SELECTION_MODES).optional(),
  context: z.number().int().positive().optional(),
  vision: z.boolean().optional(),
  tools: z.boolean().optional(),
  thinking: z.boolean().optional(),
});
export type FamilySettings = z.infer<typeof FamilySettingsSchema>;

/** The global `models` block: the virtual models, the tier pointers, the prices and the visibility filter. */
export const ModelsConfigSchema = z.strictObject({
  /** Virtual models, by name. */
  virtual: z.record(z.string().min(1), VirtualModelSchema).optional(),
  /** Which model ref each Claude tier (`fable`, `opus`, `sonnet`, `haiku`) points at: a concrete target, an account model, a virtual model, or a family. */
  tiers: z.strictObject({
    fable: z.string().min(1).optional(),
    opus: z.string().min(1).optional(),
    sonnet: z.string().min(1).optional(),
    haiku: z.string().min(1).optional(),
  }).optional(),
  /** Prices per model ref, for the `cheapest` mode. */
  prices: z.record(z.string().min(1), ModelPricesSchema).optional(),
  /** Model refs hidden from the picker and from routing, whatever else names them. */
  hide: z.array(z.string().min(1)).optional(),
  /** When set, the only model refs visible; everything else is hidden. */
  show: z.array(z.string().min(1)).optional(),
  /** Assertions that each group of refs is one model under several names, overriding what the names alone say. */
  same: z.array(z.array(z.string().min(1)).min(2)).optional(),
  /** Assertions that each pair of refs is two models however alike their names look. */
  distinct: z.array(z.tuple([z.string().min(1), z.string().min(1)])).optional(),
  /** Per-family settings and the names the normaliser cannot know, by family key. */
  families: z.record(z.string().min(1), FamilySettingsSchema).optional(),
});
export type ModelsConfig = z.infer<typeof ModelsConfigSchema>;

/**
 * The `models` block as a cascade layer writes it: identical to the global block except that any definition may be `null`, which removes what the shallower layers set rather than replacing it. A profile, directory rule or committed `.agent-shim.json` carries this form.
 */
const ModelsLayerSchema = z.strictObject({
  virtual: z.record(z.string().min(1), z.union([VirtualModelSchema, z.null()])).optional(),
  tiers: z
    .strictObject({
      fable: z.union([z.string().min(1), z.null()]).optional(),
      opus: z.union([z.string().min(1), z.null()]).optional(),
      sonnet: z.union([z.string().min(1), z.null()]).optional(),
      haiku: z.union([z.string().min(1), z.null()]).optional(),
    })
    .optional(),
  prices: z.record(z.string().min(1), z.union([ModelPricesSchema, z.null()])).optional(),
  hide: z.array(z.string().min(1)).optional(),
  show: z.array(z.string().min(1)).optional(),
  same: z.array(z.array(z.string().min(1)).min(2)).optional(),
  distinct: z.array(z.tuple([z.string().min(1), z.string().min(1)])).optional(),
  families: z.record(z.string().min(1), z.union([FamilySettingsSchema, z.null()])).optional(),
});
export type ModelsLayer = z.infer<typeof ModelsLayerSchema>;

export const ConfigProfileSchema = z.strictObject({
  $schema: z.string().optional(),
  description: z.string().optional(),
  extends: z.array(z.string().min(1)).optional(),
  categories: CategoryMapSchema.optional(),
  entries: EntriesSchema.optional(),
  launch: LaunchSchema.optional(),
  models: ModelsLayerSchema.optional(),
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

/** A pool's member entry: a concrete identity, or `pool:<name>` to nest another pool as a member, evaluated with that pool's own policy at the position the entry occupies. The same union an identity selector accepts, in the plain string form; the object form carries a `when` condition beside the same identity, the policy guard #258's ranking evaluates over the facts the ranker holds. */
const PoolMemberSchema = z.union([z.string().min(1).regex(SELECTOR_RE), z.strictObject({ identity: z.string().min(1).regex(SELECTOR_RE), when: WhenSchema })]);

/** The identity a member entry names, whichever form the entry takes. */
export function poolMemberIdentity(member: z.output<typeof PoolMemberSchema>): string {
  return typeof member === "string" ? member : member.identity;
}

/** The preference modes a pool may choose among its members with. */
export const POOL_PREFERENCES = ["score", "listed"] as const;

/** How a pool chooses the member a launch runs as: "score" by remaining quota, "listed" in the order the pool names its members. */
const PoolPreferenceSchema = z.enum(POOL_PREFERENCES);
export type PoolPreference = z.infer<typeof PoolPreferenceSchema>;

const WHOLE_PERCENT_MAX = 100;

/** The share of a quota window, in whole percent, at which a pool compacts its sessions' context: 1 to 100. */
export const CompactAtUtilisationSchema = z.number().int().min(1).max(WHOLE_PERCENT_MAX);

/**
 * A named, explicit set of identities to choose among at launch. Never implicit: a pool lists its members, so an identity that bills a client is only ever picked when someone put it there.
 *
 * A member entry may name another pool (`pool:<name>`), which is ranked with its own preference and contributes its pick at the entry's position; see `PoolMemberSchema`. The graph must stay acyclic, which `pool add`/`pool set` enforce and `doctor` re-checks.
 *
 * `compactBeforeLimit` makes the supervised sessions compact their context while their member can still afford it, at `compactAtUtilisation` percent of a window or, when that is absent, when compacting every session on the member would cost more than its five-hour window has left.
 *
 * `resumeOnLimit` makes an interactive launch from the pool supervised: when its identity runs out of quota, the launcher stops the session and resumes the same conversation under the next ranked member, on the same terminal. Absent means false.
 *
 * `preference` decides how the member is chosen, and an absent field means "score". "score" ranks members by plan-size-weighted remaining quota per hour until reset, so the quota closest to expiring is spent first (use-it-or-lose-it). "listed" ranks members strictly in the order the pool lists them, skipping only a member that is currently refused, so a pool can pin one identity first and fall back to the others only while that one is refused.
 */
export const PoolSchema = z.strictObject({
  identities: z.array(PoolMemberSchema)
    .min(1)
    .refine((members) => new Set(members.map(poolMemberIdentity)).size === members.length, { message: "pool members must be unique" }),
  preference: PoolPreferenceSchema.optional(),
  /** Whether an interactive launch from this pool keeps going when its identity runs out of quota: the launcher moves the session to the next member and resumes the conversation there. Absent means false. */
  resumeOnLimit: z.boolean().optional(),
  /** Whether a supervised session's context is compacted before its identity's quota is spent, so the resume on the next member writes a small context instead of a large one. Needs `resumeOnLimit`. Absent means false. */
  compactBeforeLimit: z.boolean().optional(),
  /** The share of a quota window, in whole percent, at which sessions are compacted. Absent means the launcher decides from what compacting every session on the member would cost against what its five-hour window has left. Needs `compactBeforeLimit`. */
  compactAtUtilisation: CompactAtUtilisationSchema.optional(),
})
  .refine((pool) => pool.compactBeforeLimit !== true || pool.resumeOnLimit === true, { message: "compactBeforeLimit needs resumeOnLimit, since a session that is not moved has no cold cache to avoid", path: ["compactBeforeLimit"] })
  .refine((pool) => pool.compactAtUtilisation === undefined || pool.compactBeforeLimit === true, { message: "compactAtUtilisation needs compactBeforeLimit", path: ["compactAtUtilisation"] });
export type Pool = z.infer<typeof PoolSchema>;

/** The weekdays an anchor can name, Monday first, as the lowercase three-letter names `--anchor` takes. */
export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** Whether `name` is an IANA time zone the runtime knows. */
function isTimeZone(name: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/**
 * A wall-clock time on some weekdays at which an identity should have a five-hour window open: the front door opens one at each anchor when none is. `timeZone` is an IANA name; absent, the machine's own zone at the time the anchor is evaluated.
 */
export const AnchorSchema = z.strictObject({
  days: z
    .array(z.enum(WEEKDAYS))
    .min(1)
    .refine((days) => new Set(days).size === days.length, "an anchor names each weekday at most once"),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "a 24-hour time such as 06:00"),
  timeZone: z.string().refine(isTimeZone, "an IANA time zone such as Europe/London").optional(),
});
export type Anchor = z.infer<typeof AnchorSchema>;

/** The quota windows a job can be timed against. */
export const JOB_WINDOWS = ["fiveHour", "sevenDay"] as const;
export type JobWindow = (typeof JOB_WINDOWS)[number];

/**
 * When a job runs: at wall-clock times (the same anchors an identity has), or once per instance of a quota window, when the window has `lead` or less left before it resets. The second is for spending quota that would otherwise expire.
 */
const JobTriggerSchema = z.union([z.strictObject({ at: z.array(AnchorSchema).min(1) }), z.strictObject({ beforeReset: z.enum(JOB_WINDOWS), lead: z.string().regex(DURATION_RE) })]);

/** What a job runs as: one identity, or whichever member of a pool the ranking picks when the job fires. */
const JobTargetSchema = z.union([z.strictObject({ identity: IdentitySelectorSchema }), z.strictObject({ pool: PoolNameSchema })]);

/**
 * A prompt run unattended through the Agent SDK as an identity, in a directory, when its trigger fires. `timeout` bounds one run. The run has the permissions its settings and `allowedTools` grant and no more: an unattended run cannot answer a permission prompt, so a tool it was not allowed is refused rather than waited on.
 */
const JobSchema = z.strictObject({
  target: JobTargetSchema,
  trigger: JobTriggerSchema,
  prompt: z.string().min(1),
  /** The absolute directory the run works in. */
  cwd: z.string().min(1),
  timeout: z.string().regex(DURATION_RE),
  model: z.string().min(1).optional(),
  allowedTools: z.array(z.string().min(1)).min(1).optional(),
});
export type Job = z.infer<typeof JobSchema>;

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
 * The default `headroom.source` install spec: the ExaDev headroom repository, with the `proxy` extra that provides the `headroom proxy` entry point. Pinned to a full commit SHA on the fork's `main`, because a branch name can be rebased or deleted and would change or break every fresh install. The pinned commit must carry every capability the supervisor starts the daemon with: the per-session savings work, `headroom proxy --uds` (the unix-socket listener) and `headroom proxy --allowed-base-urls-file` (the allowlist file the daemon re-reads on change); bump it deliberately when the fork changes any of them, and never to a commit that lacks one. Kept here rather than in the supervisor because it is the schema's own documented default, referenced by `HeadroomGlobalConfigSchema`'s field docs.
 */
export const HEADROOM_DEFAULT_SOURCE = "headroom-ai[proxy] @ git+https://github.com/ExaDev/headroom@2dfa958e47814533751cdd0c5362d8f352ec5b75";

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

/**
 * The launch-time update modes. `off` never touches the network at launch; `notify` checks for a newer release on a cooldown and prints one line naming it and the command to apply it; `auto` additionally applies the update in the background.
 */
export const UPDATE_MODES = ["off", "notify", "auto"] as const;
export type UpdateMode = (typeof UPDATE_MODES)[number];

/** The user-global update block: how the launcher treats a newer release of itself. Global-only for the same reason as headroom's block: one binary is installed per machine, so a per-directory or per-profile setting would be several claims about the same installation. */
const UpdateGlobalConfigSchema = z.strictObject({
  /** What a launch does about a newer release of agent-shim itself; see `UPDATE_MODES`. Absent means `off`. */
  mode: z.enum(UPDATE_MODES).optional(),
});

/** The user-global `~/.agent-shim/config.json`. */
/** The selection modes a virtual model can choose its member by; the engine in `src/selection/engine.ts` implements each one. */


export const GlobalConfigSchema = z.strictObject({
  $schema: z.string().optional(),
  defaultConfigProfile: z.string().min(1).optional(),
  walkUpLimit: z.string().min(1).optional(),
  categories: CategoryMapSchema.optional(),
  entries: EntriesSchema.optional(),
  launch: LaunchSchema.optional(),
  headroom: HeadroomGlobalConfigSchema.optional(),
  frontdoor: FrontDoorGlobalConfigSchema.optional(),
  update: UpdateGlobalConfigSchema.optional(),
  pools: z.record(PoolNameSchema, PoolSchema).optional(),
  models: ModelsConfigSchema.optional(),
  jobs: z.record(PoolNameSchema, JobSchema).optional(),
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
  /** When this identity's five-hour window should be open: the front door opens one at each anchor if none is. Absent, nothing is opened on a schedule. */
  anchors: z.array(AnchorSchema).min(1).optional(),
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
