import { z } from "zod";

import {
  CodexProviderConfigSchema,
  ConfigProfileSchema,
  CREDENTIAL_TARGETS,
  CredentialCacheSchema,
  DirectoryRuleSchema,
  PoolSchema,
  POOL_PREFERENCES,
  PROVIDER_CREDENTIAL_TARGETS,
  PROVIDER_KINDS,
  RemoteCredentialSourceSchema,
} from "../config/schema";

/**
 * The Zod schemas of the door's configuration-management procedures: the inputs `config.identity.*`, `config.profile.*`, `config.pool.*`, `config.provider.*` and `config.rule.*` accept and the stored objects they answer with, one shape each so the API's contract and the stores it writes through validate against the same definitions.
 *
 * Three rules shape the inputs. A credential source of the `command` kind is not accepted (`RemoteCredentialSourceSchema`), because it runs a program as the user at every launch. A provider's `env` block is not accepted, because an entry such as `NODE_OPTIONS` or `PATH` changes what code a launch runs. And a removal states `confirm: true`, the API's form of the CLI's `--yes`.
 */

/** The confirmation a removal carries, the API's form of `--yes`: a removal that omits it or states `false` is refused rather than defaulted, so deleting is always something the caller said. */
const RemovalConfirmationSchema = z.boolean();

/** A credential block as a write supplies it: the ordered sources (set as a whole, since their order is their meaning), where the token goes, and the cache. `false` for `cache` removes it; an object enables it with the `ttl` and `store` it names, merged over any existing block. */
const CredentialWriteSchema = <Target extends readonly [string, ...string[]]>(targets: Target) =>
  z.strictObject({
    sources: z.array(RemoteCredentialSourceSchema).min(1).optional(),
    target: z.enum(targets).optional(),
    cache: z.union([z.literal(false), CredentialCacheSchema]).optional(),
  });

/** A credential block as every response reports it: the effective target, each source's kind and its identifying detail, in order, and the cache setting. Never a value: a `literal` source reports only its kind. */
export const CredentialSummarySchema = z.strictObject({
  target: z.enum(CREDENTIAL_TARGETS),
  sources: z.array(
    z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("env"), variable: z.string() }),
      z.strictObject({ kind: z.literal("file"), path: z.string() }),
      z.strictObject({ kind: z.literal("command"), program: z.string() }),
      z.strictObject({ kind: z.literal("op"), reference: z.string() }),
      z.strictObject({ kind: z.literal("keychain"), service: z.string(), account: z.string().optional() }),
      z.strictObject({ kind: z.literal("literal") }),
    ]),
  ),
  cache: CredentialCacheSchema.optional(),
});

/** The shape every management procedure answers with: what it did, to which noun and name, and the stored object after the change (absent for a removal and a selection). The `--json` output of the CLI's mutating verbs, so a consumer reads one result shape from either surface. */
const mutationOutput = <Kind extends string, Action extends "created" | "updated" | "removed" | "selected", Value extends z.ZodType | undefined>(kind: Kind, action: Action, value: Value) =>
  z.strictObject({
    action: z.literal(action),
    kind: z.literal(kind),
    name: z.string(),
    ...(value === undefined ? {} : { value }),
  });

/** One identity as a write reports it. The stored credential block is reported as its summary, never its sources' values. */
const IdentityValueSchema = z.strictObject({
  name: z.string(),
  defaultConfigProfile: z.string().optional(),
  allowAmbientCredential: z.boolean(),
  credential: CredentialSummarySchema.optional(),
});

/** One configuration profile as a write reports it: the file's own content, less its editor-only `$schema` pointer. */
const ProfileValueSchema = ConfigProfileSchema.omit({ $schema: true });

/** One provider as a write reports it: its name, kind and display name, the endpoint it fronts, its credential block summarised, and its extra environment entries. */
const ProviderValueSchema = z.strictObject({
  name: z.string(),
  kind: z.enum(PROVIDER_KINDS),
  displayName: z.string(),
  baseUrl: z.string().optional(),
  codex: CodexProviderConfigSchema.optional(),
  credential: CredentialSummarySchema,
  env: z.record(z.string(), z.string()).optional(),
});

/** The input of the procedures that act on one named identity, profile or pool and take nothing else (`add` for an identity, `use` for each). The stores' own naming rules refuse a malformed name with the rule it broke. */
export const ConfigNameInputSchema = z.strictObject({ name: z.string().min(1) });

export const ConfigIdentityAddOutputSchema = mutationOutput("identity", "created", IdentityValueSchema);

/** `defaultConfigProfile: false` clears it; `credential: false` removes the credential block, returning the identity to its stored login. At least one field must be present. */
export const ConfigIdentitySetInputSchema = z.strictObject({
  name: z.string().min(1),
  defaultConfigProfile: z.union([z.string().min(1), z.literal(false)]).optional(),
  allowAmbientCredential: z.boolean().optional(),
  credential: z.union([z.literal(false), CredentialWriteSchema(CREDENTIAL_TARGETS)]).optional(),
});
export const ConfigIdentitySetOutputSchema = mutationOutput("identity", "updated", IdentityValueSchema);

export const ConfigIdentityRemoveInputSchema = z.strictObject({ name: z.string().min(1), confirm: RemovalConfirmationSchema });
export const ConfigIdentityRemoveOutputSchema = mutationOutput("identity", "removed", undefined);

export const ConfigIdentityUseOutputSchema = mutationOutput("identity", "selected", undefined);

export const ConfigProfileAddInputSchema = z.strictObject({
  name: z.string().min(1),
  extends: z.array(z.string().min(1)).optional(),
  description: z.string().optional(),
});
export const ConfigProfileAddOutputSchema = mutationOutput("profile", "created", ProfileValueSchema);

/** `category` and `entry` merge toggles into the profile's own maps; `extends` replaces the list (`false` clears it); `description` replaces the text (`false` clears it); `launch` merges the launch settings, each `provider` and `claudeVersion` clearable with `false`. At least one field must be present. */
export const ConfigProfileSetInputSchema = z.strictObject({
  name: z.string().min(1),
  category: z.record(z.string(), z.boolean()).optional(),
  entry: z.record(z.string(), z.boolean()).optional(),
  extends: z.union([z.array(z.string().min(1)), z.literal(false)]).optional(),
  description: z.union([z.string(), z.literal(false)]).optional(),
  launch: z
    .strictObject({
      skipPermissions: z.boolean().optional(),
      remoteControl: z.boolean().optional(),
      headroom: z.boolean().optional(),
      trackUsage: z.boolean().optional(),
      provider: z.union([z.string().min(1), z.literal(false)]).optional(),
      claudeVersion: z.union([z.string().min(1), z.literal(false)]).optional(),
    })
    .optional(),
});
export const ConfigProfileSetOutputSchema = mutationOutput("profile", "updated", ProfileValueSchema);

export const ConfigProfileRemoveInputSchema = z.strictObject({ name: z.string().min(1), confirm: RemovalConfirmationSchema });
export const ConfigProfileRemoveOutputSchema = mutationOutput("profile", "removed", undefined);

export const ConfigProfileUseOutputSchema = mutationOutput("profile", "selected", undefined);

/** A pool's members are identity names or `pool:<name>` selectors; an existing member's condition is kept by `set` when the list is not restated. */
const PoolMembersInputSchema = z.array(z.string().min(1)).min(1);

export const ConfigPoolAddInputSchema = z.strictObject({
  name: z.string().min(1),
  identities: PoolMembersInputSchema,
  preference: z.enum(POOL_PREFERENCES).optional(),
});
export const ConfigPoolAddOutputSchema = mutationOutput("pool", "created", PoolSchema);

/** `identities` replaces the full member list; `preference: false` clears it back to the default, score. At least one field must be present. */
export const ConfigPoolSetInputSchema = z.strictObject({
  name: z.string().min(1),
  identities: PoolMembersInputSchema.optional(),
  preference: z.union([z.enum(POOL_PREFERENCES), z.literal(false)]).optional(),
});
export const ConfigPoolSetOutputSchema = mutationOutput("pool", "updated", PoolSchema);

export const ConfigPoolRemoveInputSchema = z.strictObject({ name: z.string().min(1), confirm: RemovalConfirmationSchema });
export const ConfigPoolRemoveOutputSchema = mutationOutput("pool", "removed", undefined);

export const ConfigPoolUseOutputSchema = mutationOutput("pool", "selected", undefined);

/** A new provider: an `http` one names `baseUrl`, a `codex` one names none and may carry `codex` settings. `env` is deliberately absent: set it from the CLI. */
export const ConfigProviderAddInputSchema = z.strictObject({
  name: z.string().min(1),
  kind: z.enum(PROVIDER_KINDS).optional(),
  displayName: z.string().min(1),
  baseUrl: z.string().min(1).optional(),
  credential: CredentialWriteSchema(PROVIDER_CREDENTIAL_TARGETS).required({ sources: true }),
  codex: CodexProviderConfigSchema.optional(),
});
export const ConfigProviderAddOutputSchema = mutationOutput("provider", "created", ProviderValueSchema);

/** The fields to change; `credential.sources` replaces the whole ordered list, `codex.models` entries merge per tier. At least one field must be present. */
export const ConfigProviderSetInputSchema = z.strictObject({
  name: z.string().min(1),
  displayName: z.string().min(1).optional(),
  baseUrl: z.string().min(1).optional(),
  credential: CredentialWriteSchema(PROVIDER_CREDENTIAL_TARGETS).optional(),
  codex: CodexProviderConfigSchema.optional(),
});
export const ConfigProviderSetOutputSchema = mutationOutput("provider", "updated", ProviderValueSchema);

export const ConfigProviderRemoveInputSchema = z.strictObject({ name: z.string().min(1), confirm: RemovalConfirmationSchema });
export const ConfigProviderRemoveOutputSchema = mutationOutput("provider", "removed", undefined);

/** A rule's `name` in a response is its path, as the CLI reports it. */
export const ConfigRuleAddInputSchema = z.strictObject({
  path: z.string().min(1),
  configProfile: z.string().min(1).optional(),
  identity: z.string().min(1).optional(),
});
export const ConfigRuleAddOutputSchema = mutationOutput("rule", "created", DirectoryRuleSchema);

/** `configProfile` and `identity` each replace the rule's target, `false` stops pinning it. At least one field must be present. */
export const ConfigRuleSetInputSchema = z.strictObject({
  path: z.string().min(1),
  configProfile: z.union([z.string().min(1), z.literal(false)]).optional(),
  identity: z.union([z.string().min(1), z.literal(false)]).optional(),
});
export const ConfigRuleSetOutputSchema = mutationOutput("rule", "updated", DirectoryRuleSchema);

export const ConfigRuleRemoveInputSchema = z.strictObject({ path: z.string().min(1), confirm: RemovalConfirmationSchema });
export const ConfigRuleRemoveOutputSchema = mutationOutput("rule", "removed", undefined);
