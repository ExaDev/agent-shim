import { ORPCError } from "@orpc/client";
import { openapi } from "@orpc/openapi";

import { CliError } from "../cliError";
import { type Pool, type Provider, isCodexProvider } from "../config/schema";
import { applyProfileChange, createProfile, ProfileAlreadyExistsError, ProfileNotFoundError, readProfile, removeProfile, requireProfileExists, setGlobalDefaultProfile } from "../configProfilesStore";
import { summariseCredential } from "../credential";
import { mergeCredentialCache } from "../credentialCacheChange";
import { addDirectoryRule, DirectoryRuleAlreadyExistsError, DirectoryRuleNotFoundError, listDirectoryRules, removeDirectoryRule, requireRuleSelector, updateDirectoryRule } from "../directoryRulesStore";
import {
  addIdentity,
  IdentityAlreadyExistsError,
  IdentityNotFoundError,
  identityExists,
  readIdentity,
  removeIdentity,
  requireIdentityNames,
  setAllowAmbientCredential,
  setDefaultConfigProfile,
  setIdentityCredential,
  useIdentity,
  type IdentityCredentialChange,
} from "../identityStore";
import { poolNameOf } from "../launcher/identity";
import type { LayoutPaths } from "../paths";
import { addPool, PoolAlreadyExistsError, PoolNotFoundError, readPools, removePool, requirePool, setPool } from "../poolStore";
import { addProvider, ProviderAlreadyExistsError, ProviderNotFoundError, providerExists, readProvider, removeProvider, updateProvider } from "../providersStore";
import {
  ConfigIdentityAddOutputSchema,
  ConfigNameInputSchema,
  ConfigIdentityRemoveInputSchema,
  ConfigIdentityRemoveOutputSchema,
  ConfigIdentitySetInputSchema,
  ConfigIdentitySetOutputSchema,
  ConfigIdentityUseOutputSchema,
  ConfigPoolAddInputSchema,
  ConfigPoolAddOutputSchema,
  ConfigPoolRemoveInputSchema,
  ConfigPoolRemoveOutputSchema,
  ConfigPoolSetInputSchema,
  ConfigPoolSetOutputSchema,
  ConfigPoolUseOutputSchema,
  ConfigProfileAddInputSchema,
  ConfigProfileAddOutputSchema,
  ConfigProfileRemoveInputSchema,
  ConfigProfileRemoveOutputSchema,
  ConfigProfileSetInputSchema,
  ConfigProfileSetOutputSchema,
  ConfigProfileUseOutputSchema,
  ConfigProviderAddInputSchema,
  ConfigProviderAddOutputSchema,
  ConfigProviderRemoveInputSchema,
  ConfigProviderRemoveOutputSchema,
  ConfigProviderSetInputSchema,
  ConfigProviderSetOutputSchema,
  ConfigRuleAddInputSchema,
  ConfigRuleAddOutputSchema,
  ConfigRuleRemoveInputSchema,
  ConfigRuleRemoveOutputSchema,
  ConfigRuleSetInputSchema,
  ConfigRuleSetOutputSchema,
} from "./configSchemas";
import { doorApiAuth } from "./rcApi";

/**
 * The door's configuration management as a typed oRPC API: the writes the CLI's `identity`, `profile`, `pool`, `provider` and `rule` verbs make, as `config.<noun>.<verb>` procedures, every one behind the same per-generation control token as the rest of the mount.
 *
 * Each procedure calls the store function its verb calls (and the shared rules extracted beside them), so a write through the API and a write through the CLI are the same write: the same validation, the same atomic store write, the same refusals. A refusal is the CLI's own message carried as an oRPC error (`NOT_FOUND` for a name that does not exist, `CONFLICT` for one that already does, `BAD_REQUEST` for anything else the store refuses), and every outcome is the `--json` object the verb prints.
 *
 * What the API deliberately does not accept: a credential source of the `command` kind and a provider's `env` block, both of which would let a holder of the control token run a program of their choosing at the next launch; the interactive wizards and `configure`, which need a terminal; and a removal without `confirm: true`. Those stay on the CLI.
 */

/** Everything the configuration procedures need: the token to gate them with and the layout the stores read and write. */
export interface ConfigApiDeps {
  /** This generation's control token: the same value every other router on the mount checks. */
  readonly expectedToken: string;
  /** The configuration tree the stores operate on. */
  readonly paths: LayoutPaths;
}

/** The OpenAPI tag the configuration procedures group under in the document. */
const CONFIG_API_TAG = "config";

/** Maps the stores' expected refusals onto the oRPC error a typed client reads: a missing name, a name already taken, and everything else the store rejects as a malformed request. Anything that is not an expected refusal is a bug and propagates as one. */
function refusal(error: unknown): never {
  if (
    error instanceof IdentityNotFoundError ||
    error instanceof ProfileNotFoundError ||
    error instanceof PoolNotFoundError ||
    error instanceof ProviderNotFoundError ||
    error instanceof DirectoryRuleNotFoundError
  ) {
    throw new ORPCError("NOT_FOUND", { message: error.message });
  }
  if (
    error instanceof IdentityAlreadyExistsError ||
    error instanceof ProfileAlreadyExistsError ||
    error instanceof PoolAlreadyExistsError ||
    error instanceof ProviderAlreadyExistsError ||
    error instanceof DirectoryRuleAlreadyExistsError
  ) {
    throw new ORPCError("CONFLICT", { message: error.message });
  }
  if (error instanceof CliError) {
    throw new ORPCError("BAD_REQUEST", { message: error.message });
  }
  throw error;
}

/** Runs one write, converting the stores' expected refusals as `refusal` does. */
function guarded<T>(write: () => T): T {
  try {
    return write();
  } catch (error: unknown) {
    return refusal(error);
  }
}

/** Refuses a removal that did not state its confirmation, naming the CLI flag it stands for. */
function requireConfirmation(confirm: boolean, what: string): void {
  if (!confirm) {
    throw new ORPCError("BAD_REQUEST", { message: `removing ${what} needs confirm: true, the API's form of the CLI's --yes` });
  }
}

/** Refuses a write that names nothing to change, as each `set` verb does. */
function requireChange(given: boolean, fields: string): void {
  if (!given) {
    throw new ORPCError("BAD_REQUEST", { message: `Nothing to change: pass ${fields}.` });
  }
}

/** One identity as a write reports it, its credential block summarised so no source's value is echoed. */
function identityValue(name: string, paths: LayoutPaths) {
  const identity = readIdentity(paths, name);
  if (identity === undefined) {
    throw new IdentityNotFoundError(name);
  }
  return {
    name: identity.name,
    ...(identity.defaultConfigProfile === undefined ? {} : { defaultConfigProfile: identity.defaultConfigProfile }),
    allowAmbientCredential: identity.allowAmbientCredential,
    ...(identity.credential === undefined ? {} : { credential: summariseCredential(identity.credential) }),
  };
}

/** One provider as a write reports it, the shape `provider show --json` prints. */
function providerValue(name: string, provider: Provider) {
  return {
    name,
    kind: provider.kind ?? "http",
    displayName: provider.displayName,
    ...(isCodexProvider(provider) ? (provider.codex === undefined ? {} : { codex: provider.codex }) : { baseUrl: provider.baseUrl }),
    credential: summariseCredential(provider.credential),
    ...(provider.env === undefined ? {} : { env: provider.env }),
  };
}

/** The `$schema` pointer a profile file may carry is editor-only and never part of what a write reports. */
function profileValue(name: string, paths: LayoutPaths) {
  const profile = { ...readProfile(paths, name) };
  delete profile.$schema;
  return profile;
}

/** Builds the configuration router: one procedure per write, every one behind the control-token middleware. */
export function createConfigApiRouter(deps: ConfigApiDeps) {
  const authed = doorApiAuth(deps.expectedToken);
  const { paths } = deps;
  const route = (path: `/${string}`, summary: string) => authed.meta(openapi({ method: "POST", path, summary, tags: [CONFIG_API_TAG] }));
  return {
    config: {
      identity: {
        add: route("/rest/config/identity/add", "Create an identity")
          .input(ConfigNameInputSchema)
          .output(ConfigIdentityAddOutputSchema)
          .handler(({ input }) =>
            guarded(() => {
              addIdentity(paths, input.name);
              return { action: "created" as const, kind: "identity" as const, name: input.name, value: identityValue(input.name, paths) };
            }),
          ),
        set: route("/rest/config/identity/set", "Update an identity's default profile, ambient-credential setting or credential")
          .input(ConfigIdentitySetInputSchema)
          .output(ConfigIdentitySetOutputSchema)
          .handler(({ input }) =>
            guarded(() => {
              requireChange(input.defaultConfigProfile !== undefined || input.allowAmbientCredential !== undefined || input.credential !== undefined, "defaultConfigProfile, allowAmbientCredential or credential");
              if (!identityExists(paths, input.name)) {
                throw new IdentityNotFoundError(input.name);
              }
              if (typeof input.defaultConfigProfile === "string") {
                requireProfileExists(paths, input.defaultConfigProfile);
              }
              if (input.defaultConfigProfile !== undefined) {
                setDefaultConfigProfile(paths, input.name, input.defaultConfigProfile === false ? undefined : input.defaultConfigProfile);
              }
              if (input.allowAmbientCredential !== undefined) {
                setAllowAmbientCredential(paths, input.name, input.allowAmbientCredential);
              }
              if (input.credential === false) {
                setIdentityCredential(paths, input.name, false);
              } else if (input.credential !== undefined) {
                const { sources, target, cache } = input.credential;
                const merged = cache === undefined ? undefined : mergeCredentialCache(cache === false ? { enabled: false } : { ...cache, enabled: true }, readIdentity(paths, input.name)?.credential?.cache);
                const change: IdentityCredentialChange = {
                  ...(sources === undefined ? {} : { sources }),
                  ...(target === undefined ? {} : { target }),
                  ...(merged === undefined ? {} : { cache: merged }),
                };
                setIdentityCredential(paths, input.name, change);
              }
              return { action: "updated" as const, kind: "identity" as const, name: input.name, value: identityValue(input.name, paths) };
            }),
          ),
        remove: route("/rest/config/identity/remove", "Delete an identity and its directory")
          .input(ConfigIdentityRemoveInputSchema)
          .output(ConfigIdentityRemoveOutputSchema)
          .handler(({ input }) => {
            requireConfirmation(input.confirm, `identity "${input.name}" and its directory`);
            return guarded(() => {
              removeIdentity(paths, input.name);
              return { action: "removed" as const, kind: "identity" as const, name: input.name };
            });
          }),
        use: route("/rest/config/identity/use", "Select the active identity")
          .input(ConfigNameInputSchema)
          .output(ConfigIdentityUseOutputSchema)
          .handler(({ input }) =>
            guarded(() => {
              if (poolNameOf(input.name) === undefined && !identityExists(paths, input.name)) {
                throw new IdentityNotFoundError(input.name);
              }
              useIdentity(paths, input.name);
              return { action: "selected" as const, kind: "identity" as const, name: input.name };
            }),
          ),
      },
      profile: {
        add: route("/rest/config/profile/add", "Create a configuration profile")
          .input(ConfigProfileAddInputSchema)
          .output(ConfigProfileAddOutputSchema)
          .handler(({ input }) =>
            guarded(() => {
              createProfile(paths, input.name, input.extends, input.description);
              return { action: "created" as const, kind: "profile" as const, name: input.name, value: profileValue(input.name, paths) };
            }),
          ),
        set: route("/rest/config/profile/set", "Update a configuration profile's categories, entries, extends list, description or launch settings")
          .input(ConfigProfileSetInputSchema)
          .output(ConfigProfileSetOutputSchema)
          .handler(({ input }) =>
            guarded(() => {
              const { launch } = input;
              requireChange(
                input.category !== undefined || input.entry !== undefined || input.extends !== undefined || input.description !== undefined || launch !== undefined,
                "category, entry, extends, description or launch",
              );
              requireProfileExists(paths, input.name);
              applyProfileChange(paths, input.name, {
                ...(input.category === undefined ? {} : { category: input.category }),
                ...(input.entry === undefined ? {} : { entry: input.entry }),
                ...(input.extends === undefined ? {} : { extends: input.extends }),
                ...(input.description === undefined ? {} : { description: input.description }),
                ...(launch?.skipPermissions === undefined ? {} : { launchSkipPermissions: launch.skipPermissions }),
                ...(launch?.remoteControl === undefined ? {} : { launchRemoteControl: launch.remoteControl }),
                ...(launch?.headroom === undefined ? {} : { launchHeadroom: launch.headroom }),
                ...(launch?.trackUsage === undefined ? {} : { launchTrackUsage: launch.trackUsage }),
                ...(launch?.provider === undefined ? {} : { launchProvider: launch.provider }),
                ...(launch?.claudeVersion === undefined ? {} : { launchClaudeVersion: launch.claudeVersion }),
              });
              return { action: "updated" as const, kind: "profile" as const, name: input.name, value: profileValue(input.name, paths) };
            }),
          ),
        remove: route("/rest/config/profile/remove", "Delete a configuration profile")
          .input(ConfigProfileRemoveInputSchema)
          .output(ConfigProfileRemoveOutputSchema)
          .handler(({ input }) => {
            requireConfirmation(input.confirm, `configuration profile "${input.name}"`);
            return guarded(() => {
              removeProfile(paths, input.name);
              return { action: "removed" as const, kind: "profile" as const, name: input.name };
            });
          }),
        use: route("/rest/config/profile/use", "Make a configuration profile the global default")
          .input(ConfigNameInputSchema)
          .output(ConfigProfileUseOutputSchema)
          .handler(({ input }) =>
            guarded(() => {
              requireProfileExists(paths, input.name);
              setGlobalDefaultProfile(paths, input.name);
              return { action: "selected" as const, kind: "profile" as const, name: input.name };
            }),
          ),
      },
      pool: {
        add: route("/rest/config/pool/add", "Define a pool")
          .input(ConfigPoolAddInputSchema)
          .output(ConfigPoolAddOutputSchema)
          .handler(({ input }) =>
            guarded(() => {
              requireIdentityNames(paths, input.identities);
              const created = addPool(paths, input.name, input.identities, input.preference);
              return { action: "created" as const, kind: "pool" as const, name: input.name, value: created };
            }),
          ),
        set: route("/rest/config/pool/set", "Replace a pool's members, its preference or both")
          .input(ConfigPoolSetInputSchema)
          .output(ConfigPoolSetOutputSchema)
          .handler(({ input }) =>
            guarded(() => {
              requireChange(input.identities !== undefined || input.preference !== undefined, "identities or preference");
              const existing = requirePool(paths, input.name);
              if (input.identities !== undefined) {
                // Only the freshly listed names are validated: the pass-through keeps object entries whose condition the request does not restate.
                requireIdentityNames(paths, input.identities);
              }
              const members: Pool["identities"] = input.identities ?? existing.identities;
              const preference = input.preference === undefined ? existing.preference : input.preference === false ? undefined : input.preference;
              return { action: "updated" as const, kind: "pool" as const, name: input.name, value: setPool(paths, input.name, members, preference) };
            }),
          ),
        remove: route("/rest/config/pool/remove", "Delete a pool")
          .input(ConfigPoolRemoveInputSchema)
          .output(ConfigPoolRemoveOutputSchema)
          .handler(({ input }) => {
            requireConfirmation(input.confirm, `pool "${input.name}"`);
            return guarded(() => {
              removePool(paths, input.name);
              return { action: "removed" as const, kind: "pool" as const, name: input.name };
            });
          }),
        use: route("/rest/config/pool/use", "Make launches with no other selection pick a member of a pool")
          .input(ConfigNameInputSchema)
          .output(ConfigPoolUseOutputSchema)
          .handler(({ input }) =>
            guarded(() => {
              if (readPools(paths)[input.name] === undefined) {
                throw new PoolNotFoundError(input.name);
              }
              useIdentity(paths, `pool:${input.name}`);
              return { action: "selected" as const, kind: "pool" as const, name: input.name };
            }),
          ),
      },
      provider: {
        add: route("/rest/config/provider/add", "Create an API provider definition")
          .input(ConfigProviderAddInputSchema)
          .output(ConfigProviderAddOutputSchema)
          .handler(({ input }) =>
            guarded(() => {
              const created = addProvider(paths, input.name, {
                ...(input.kind === undefined ? {} : { kind: input.kind }),
                displayName: input.displayName,
                ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
                sources: input.credential.sources,
                ...(input.credential.target === undefined ? {} : { target: input.credential.target }),
                ...(input.codex === undefined ? {} : { codex: input.codex }),
              });
              const cache = input.credential.cache;
              const stored = cache === undefined || cache === false ? created : updateProvider(paths, input.name, { cache });
              return { action: "created" as const, kind: "provider" as const, name: input.name, value: providerValue(input.name, stored) };
            }),
          ),
        set: route("/rest/config/provider/set", "Update an API provider definition")
          .input(ConfigProviderSetInputSchema)
          .output(ConfigProviderSetOutputSchema)
          .handler(({ input }) =>
            guarded(() => {
              requireChange(input.displayName !== undefined || input.baseUrl !== undefined || input.credential !== undefined || input.codex !== undefined, "displayName, baseUrl, credential or codex");
              const existing = readProvider(paths, input.name);
              if (existing === undefined) {
                throw new ProviderNotFoundError(input.name);
              }
              const credential = input.credential;
              const cache =
                credential?.cache === undefined ? undefined : mergeCredentialCache(credential.cache === false ? { enabled: false } : { ...credential.cache, enabled: true }, existing.credential.cache);
              const updated = updateProvider(paths, input.name, {
                ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
                ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
                ...(credential?.sources === undefined ? {} : { sources: credential.sources }),
                ...(credential?.target === undefined ? {} : { target: credential.target }),
                ...(cache === undefined ? {} : { cache }),
                ...(input.codex === undefined ? {} : { codex: input.codex }),
              });
              return { action: "updated" as const, kind: "provider" as const, name: input.name, value: providerValue(input.name, updated) };
            }),
          ),
        remove: route("/rest/config/provider/remove", "Delete an API provider definition")
          .input(ConfigProviderRemoveInputSchema)
          .output(ConfigProviderRemoveOutputSchema)
          .handler(({ input }) => {
            requireConfirmation(input.confirm, `provider "${input.name}"`);
            return guarded(() => {
              if (!providerExists(paths, input.name)) {
                throw new ProviderNotFoundError(input.name);
              }
              removeProvider(paths, input.name);
              return { action: "removed" as const, kind: "provider" as const, name: input.name };
            });
          }),
      },
      rule: {
        add: route("/rest/config/rule/add", "Add a directory rule for a path")
          .input(ConfigRuleAddInputSchema)
          .output(ConfigRuleAddOutputSchema)
          .handler(({ input }) =>
            guarded(() => {
              if (input.identity !== undefined) {
                requireRuleSelector(paths, input.identity);
              }
              if (input.configProfile !== undefined) {
                requireProfileExists(paths, input.configProfile);
              }
              const created = addDirectoryRule(paths, input.path, {
                ...(input.configProfile === undefined ? {} : { configProfile: input.configProfile }),
                ...(input.identity === undefined ? {} : { identity: input.identity }),
              });
              return { action: "created" as const, kind: "rule" as const, name: input.path, value: created };
            }),
          ),
        set: route("/rest/config/rule/set", "Update the directory rule for a path")
          .input(ConfigRuleSetInputSchema)
          .output(ConfigRuleSetOutputSchema)
          .handler(({ input }) =>
            guarded(() => {
              requireChange(input.configProfile !== undefined || input.identity !== undefined, "configProfile or identity");
              if (typeof input.identity === "string") {
                requireRuleSelector(paths, input.identity);
              }
              if (typeof input.configProfile === "string") {
                requireProfileExists(paths, input.configProfile);
              }
              const updated = updateDirectoryRule(paths, input.path, {
                ...(input.configProfile === undefined ? {} : { configProfile: input.configProfile }),
                ...(input.identity === undefined ? {} : { identity: input.identity }),
              });
              return { action: "updated" as const, kind: "rule" as const, name: input.path, value: updated };
            }),
          ),
        remove: route("/rest/config/rule/remove", "Remove the directory rule for a path")
          .input(ConfigRuleRemoveInputSchema)
          .output(ConfigRuleRemoveOutputSchema)
          .handler(({ input }) => {
            requireConfirmation(input.confirm, `the directory rule for "${input.path}"`);
            return guarded(() => {
              if (!listDirectoryRules(paths).some((entry) => entry.path === input.path)) {
                throw new DirectoryRuleNotFoundError(input.path);
              }
              removeDirectoryRule(paths, input.path);
              return { action: "removed" as const, kind: "rule" as const, name: input.path };
            });
          }),
      },
    },
  };
}

/** The configuration router, as the merged mount's and the client's own types are derived from it. */
export type ConfigApiRouter = ReturnType<typeof createConfigApiRouter>;
