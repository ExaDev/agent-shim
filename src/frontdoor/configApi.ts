import { checkedProxyBypass } from "../launcher/proxyBypass";
import { InterruptedNameRenameError } from "../identityNameRenameRecord";
import { identityCacheKey } from "../credential";
import { keychainCacheDeleteArgs } from "../realCredentialCache";
import { ORPCError } from "@orpc/client";
import { openapi } from "@orpc/openapi";

import { CliError } from "../cliError";
import { type Provider, isAntigravityProvider, isCodexProvider, isHttpProvider, isRouterProvider } from "../config/schema";
import { applyProfileChange, createProfile, ProfileAlreadyExistsError, ProfileNotFoundError, readProfile, removeProfile, requireProfileExists, setGlobalDefaultProfile } from "../configProfilesStore";
import { summariseCredential } from "../credential";
import { identityWriteView } from "../identityWriteView";
import { mergeCredentialCache } from "../credentialCacheChange";
import { addDirectoryRule, DirectoryRuleAlreadyExistsError, DirectoryRuleNotFoundError, listDirectoryRules, removeDirectoryRule, requireRuleSelector, updateDirectoryRule } from "../directoryRulesStore";
import { addIdentity, IdentityAlreadyExistsError, IdentityNotFoundError, identityExists, readIdentity, removeIdentityWithLockHeld, REMOVED_STATE, loggedIdentityIds, requireIdentityAddable, requireIdentityNames, setAllowAmbientCredential, setDefaultConfigProfile, setIdentityLabel, setIdentityProvider, setIdentityAnchors, setIdentityCredential, useIdentity, type IdentityCredentialChange, identityNotFound } from "../identityStore";
import { KeychainCacheDeleteError, KeychainLoginError, KeychainLookupError, requireKeychainCacheDeleted } from "../keychainLogin";
import { acquireIdentityNamesLock, nonWaitingIdentityNamesLockPorts } from "../identityNamesLock";
import { IdentityLockBusyError } from "../launcher/lock";
import { poolNameOf } from "../launcher/identity";
import type { LayoutPaths } from "../paths";
import { resolveWithAsyncRuns, type AsyncRun } from "../replayRun";
import { addPool, changePool, isPoolChange, PoolAlreadyExistsError, PoolNotFoundError, readPools, removePool, requirePool } from "../poolStore";
import { displayBaseUrl } from "../baseUrlDisplay";
import { addProvider, ProviderAlreadyExistsError, ProviderNotFoundError, providerExists, readProvider, removeProvider, requireProviderExists, updateProvider } from "../providersStore";
import {
  ConfigIdentityAddInputSchema,
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
  ConfigRouteSetInputSchema,
  ConfigRouteSetOutputSchema,
  ConfigRouteUnsetInputSchema,
  ConfigRouteUnsetOutputSchema,
} from "./configSchemas";
import { setRouteOverride, unsetRouteOverride } from "../routeOverrides";
import { scopeLabelOf } from "../routeOverridesStore";
import { doorApiAuth } from "./rcApi";

/**
 * The door's configuration management as a typed oRPC API: the writes the CLI's `identity`, `profile`, `pool`, `provider` and `rule` verbs make, (and `route set|unset`) as `config.<noun>.<verb>` procedures, every one behind the same per-generation control token as the rest of the mount.
 *
 * Each procedure makes the checks its verb makes and calls the store function it calls (and the shared rules extracted beside them), so a write through the API and a write through the CLI are the same write: the same validation, the same atomic store write, the same refusals. The one check that reaches outside the stores is `config.identity.add`'s question to the macOS Keychain, asked through the asynchronous runner in `deps.keychain` so the door's event loop is never held, by the function the CLI asks it with. A refusal is the CLI's own message carried as an oRPC error (`NOT_FOUND` for a name that does not exist, `CONFLICT` for one that already does or for a Keychain login in the way, `BAD_REQUEST` for anything else the store refuses, and the retryable `SERVICE_UNAVAILABLE` for a Keychain that could not be asked), and every outcome is the `--json` object the verb prints.
 *
 * What the API deliberately does not accept: a credential source of the `command` kind, a provider's `env` block and a statusline patch setting the `extra` group, all of which would let a holder of the control token run a program of their choosing at the next launch; the interactive wizards and `configure`, which need a terminal; a removal without `confirm: true`, and a change of an existing provider's `baseUrl` that does not restate its credential block. Those stay on the CLI.
 */

/** Everything the configuration procedures need: the token to gate them with and the layout the stores read and write. */
export interface ConfigApiDeps {
  /** This generation's control token: the same value every other router on the mount checks. */
  readonly expectedToken: string;
  /** The configuration tree the stores operate on. */
  readonly paths: LayoutPaths;
  /** How the door asks the macOS Keychain whether a login is already filed for a directory an identity is about to be created in: `security` run without blocking the event loop, and the platform, since only macOS has a Keychain. The door builds it with `doorKeychainProbe`. */
  readonly keychain: { readonly runAsync: AsyncRun; readonly platform: NodeJS.Platform };
}

/** The OpenAPI tag the configuration procedures group under in the document. */
const CONFIG_API_TAG = "config";

/** Maps the stores' expected refusals onto the oRPC error a typed client reads: a missing name, a name or a Keychain login already in the way, a Keychain that could not be asked (a failure to retry, not a conflict), a cached credential the Keychain would not delete, and everything else the store rejects as a malformed request. Anything that is not an expected refusal is a bug and propagates as one. */
function refusal(error: unknown): never {
  // Before the conflicts, because a `KeychainLookupError` is a `KeychainLoginError`: the Keychain could not be asked (`security` stopped after its time limit, a locked Keychain, no `security`), so nothing is known to be in the way and asking again may succeed.
  // The identity names lock is taken without waiting, since a wait would hold the door's event loop; a rename holding it ends soon, so asking again may succeed.
  if (error instanceof IdentityLockBusyError) {
    throw new ORPCError("SERVICE_UNAVAILABLE", { message: error.message });
  }
  if (error instanceof KeychainLookupError) {
    throw new ORPCError("SERVICE_UNAVAILABLE", { message: error.message });
  }
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
    error instanceof InterruptedNameRenameError ||
    error instanceof IdentityAlreadyExistsError ||
    error instanceof ProfileAlreadyExistsError ||
    error instanceof PoolAlreadyExistsError ||
    error instanceof ProviderAlreadyExistsError ||
    error instanceof DirectoryRuleAlreadyExistsError ||
    error instanceof KeychainLoginError
  ) {
    throw new ORPCError("CONFLICT", { message: error.message });
  }
  // The request was carried out but left a Keychain entry behind, so it is no fault of the request.
  if (error instanceof KeychainCacheDeleteError) {
    throw new ORPCError("INTERNAL_SERVER_ERROR", { message: error.message });
  }
  if (error instanceof CliError) {
    throw new ORPCError("BAD_REQUEST", { message: error.message });
  }
  throw error;
}

/** Runs one write that awaits, converting the expected refusals as `guarded` does. */
async function guardedAsync<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error: unknown) {
    return refusal(error);
  }
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

/** One identity as a write reports it (see `identityWriteView`), read back after the write. */
function identityValue(name: string, paths: LayoutPaths) {
  const identity = readIdentity(paths, name);
  if (identity === undefined) {
    throw identityNotFound(paths, name);
  }
  return identityWriteView(identity);
}

/** One provider as a write reports it, the shape `provider show --json` prints except that its base URL is named as `displayBaseUrl` shows it, since a base URL may carry a credential and a write's report is logged by its callers. */
function providerValue(name: string, provider: Provider) {
  return {
    name,
    kind: provider.kind ?? "http",
    displayName: provider.displayName,
    ...(isCodexProvider(provider)
      ? (provider.codex === undefined ? {} : { codex: provider.codex })
      : isAntigravityProvider(provider)
      ? (provider.antigravity === undefined ? {} : { antigravity: provider.antigravity })
      : isRouterProvider(provider)
      ? {}
      : { baseUrl: displayBaseUrl(provider.baseUrl) }),
    ...(isRouterProvider(provider) ? {} : { credential: summariseCredential(provider.credential), ...(provider.env === undefined ? {} : { env: provider.env }) }),
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
          .input(ConfigIdentityAddInputSchema)
          .output(ConfigIdentityAddOutputSchema)
          .handler(async ({ input }) => {
            // The Keychain is asked through the asynchronous runner, so the door's event loop is never held, by the same check the CLI makes (it changes nothing, which is what lets it run over the replaying port); the write follows once it has passed.
            // The id it checked is the one the identity is created under, so a remove that frees another id in between cannot move the identity to a directory nothing checked.
            // The decision starts again for each Keychain answer, so the usage log is read once, outside it, and every start answers from that read.
            const loggedIds = loggedIdentityIds(paths);
            const checkedId = await guardedAsync(async () => await resolveWithAsyncRuns((run) => requireIdentityAddable(paths, input.name, { run, platform: deps.keychain.platform }, input.keepKeychainLogin === true, loggedIds), deps.keychain.runAsync));
            return guarded(() => {
              addIdentity(paths, input.name, { namesLock: nonWaitingIdentityNamesLockPorts, checkedId });
              return { action: "created" as const, kind: "identity" as const, name: input.name, value: identityValue(input.name, paths) };
            });
          }),
        set: route("/rest/config/identity/set", "Update an identity's label, default profile, provider, ambient-credential setting, credential or anchors")
          .input(ConfigIdentitySetInputSchema)
          .output(ConfigIdentitySetOutputSchema)
          .handler(({ input }) =>
            guarded(() => {
              requireChange(input.label !== undefined || input.defaultConfigProfile !== undefined || input.provider !== undefined || input.allowAmbientCredential !== undefined || input.credential !== undefined || input.anchors !== undefined, "label, defaultConfigProfile, provider, allowAmbientCredential, credential or anchors");
              if (!identityExists(paths, input.name)) {
                throw identityNotFound(paths, input.name);
              }
              if (typeof input.defaultConfigProfile === "string") {
                requireProfileExists(paths, input.defaultConfigProfile);
              }
              if (typeof input.provider === "string") {
                requireProviderExists(paths, input.provider);
              }
              if (input.label !== undefined) {
                setIdentityLabel(paths, input.name, input.label === false ? undefined : input.label);
              }
              if (input.defaultConfigProfile !== undefined) {
                setDefaultConfigProfile(paths, input.name, input.defaultConfigProfile === false ? undefined : input.defaultConfigProfile);
              }
              if (input.provider !== undefined) {
                setIdentityProvider(paths, input.name, input.provider === false ? undefined : input.provider);
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
              if (input.anchors !== undefined) {
                setIdentityAnchors(paths, input.name, input.anchors === false ? undefined : input.anchors);
              }
              return { action: "updated" as const, kind: "identity" as const, name: input.name, value: identityValue(input.name, paths) };
            }),
          ),
        remove: route("/rest/config/identity/remove", "Delete an identity and its directory")
          .input(ConfigIdentityRemoveInputSchema)
          .output(ConfigIdentityRemoveOutputSchema)
          .handler(async ({ input }) => {
            requireConfirmation(input.confirm, `identity "${input.name}", its directory, and ${REMOVED_STATE}`);
            const lock = guarded(() => acquireIdentityNamesLock(paths, nonWaitingIdentityNamesLockPorts));
            try {
              const id = guarded(() => removeIdentityWithLockHeld(paths, input.name, nonWaitingIdentityNamesLockPorts));
              // The Keychain store's cached credential is forgotten too, through the runner that does not block the event loop; an item that is not there is no failure, and any other leaves the entry behind, so it is reported (the identity itself is removed by then).
              if (deps.keychain.platform === "darwin") {
                const owner = identityCacheKey(id);
                const { status } = await deps.keychain.runAsync("security", keychainCacheDeleteArgs(owner));
                guarded(() => {
                  requireKeychainCacheDeleted(owner, status, input.name);
                });
              }
              return { action: "removed" as const, kind: "identity" as const, name: input.name };
            } finally {
              lock.release();
            }
          }),
        use: route("/rest/config/identity/use", "Select the active identity")
          .input(ConfigNameInputSchema)
          .output(ConfigIdentityUseOutputSchema)
          .handler(({ input }) =>
            guarded(() => {
              if (poolNameOf(input.name) === undefined && !identityExists(paths, input.name)) {
                throw identityNotFound(paths, input.name);
              }
              useIdentity(paths, input.name, nonWaitingIdentityNamesLockPorts);
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
                ...(launch?.delay === undefined ? {} : { launchDelay: launch.delay }),
                ...(launch?.pause === undefined ? {} : { launchPause: launch.pause }),
                ...(launch?.explain === undefined ? {} : { launchExplain: launch.explain }),
                ...(launch?.proxyBypass === undefined ? {} : { launchProxyBypass: launch.proxyBypass === false ? false : checkedProxyBypass(launch.proxyBypass, "launch.proxyBypass") }),
                ...(launch?.statusline === undefined ? {} : { launchStatusline: launch.statusline }),
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
              const created = addPool(paths, input.name, input.identities, { preference: input.preference, resumeOnLimit: input.resumeOnLimit, compactBeforeLimit: input.compactBeforeLimit, compactAtUtilisation: input.compactAtUtilisation });
              return { action: "created" as const, kind: "pool" as const, name: input.name, value: created };
            }),
          ),
        set: route("/rest/config/pool/set", "Replace a pool's members, change its preference or whether it resumes on a spent quota")
          .input(ConfigPoolSetInputSchema)
          .output(ConfigPoolSetOutputSchema)
          .handler(({ input }) =>
            guarded(() => {
              const change = { identities: input.identities, preference: input.preference, resumeOnLimit: input.resumeOnLimit, compactBeforeLimit: input.compactBeforeLimit, compactAtUtilisation: input.compactAtUtilisation };
              requireChange(isPoolChange(change), "identities, preference, resumeOnLimit, compactBeforeLimit or compactAtUtilisation");
              requirePool(paths, input.name);
              if (input.identities !== undefined) {
                // Only the freshly listed names are validated: the pass-through keeps object entries whose condition the request does not restate.
                requireIdentityNames(paths, input.identities);
              }
              return { action: "updated" as const, kind: "pool" as const, name: input.name, value: changePool(paths, input.name, change) };
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
              useIdentity(paths, `pool:${input.name}`, nonWaitingIdentityNamesLockPorts);
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
              // The provider's stored credential would be attached to requests for the new endpoint, so a holder of the control token could point it at a host they run and collect the token. Moving the endpoint must restate the credential in the same call, which makes the caller supply the value's source rather than inherit it.
              if (input.baseUrl !== undefined && isHttpProvider(existing) && input.baseUrl !== existing.baseUrl && credential?.sources === undefined) {
                throw new ORPCError("BAD_REQUEST", { message: `Changing the base URL of provider "${input.name}" requires a credential block in the same call: the stored credential is not sent to a different endpoint.` });
              }
              const cache =
                credential?.cache === undefined || isRouterProvider(existing) ? undefined : mergeCredentialCache(credential.cache === false ? { enabled: false } : { ...credential.cache, enabled: true }, isRouterProvider(existing) ? undefined : existing.credential.cache);
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
      route: {
        set: route("/rest/config/route/set", "Route a Claude model name or class to a target in one scope, from each session's next request")
          .input(ConfigRouteSetInputSchema)
          .output(ConfigRouteSetOutputSchema)
          .handler(({ input }) =>
            guarded(() => {
              setRouteOverride(paths, input.scope, input.model, input.target);
              return { action: "updated" as const, kind: "route" as const, name: input.model, value: { scope: scopeLabelOf(input.scope), model: input.model, target: input.target } };
            }),
          ),
        unset: route("/rest/config/route/unset", "Remove one route override")
          .input(ConfigRouteUnsetInputSchema)
          .output(ConfigRouteUnsetOutputSchema)
          .handler(({ input }) =>
            guarded(() => {
              unsetRouteOverride(paths, input.scope, input.model);
              return { action: "removed" as const, kind: "route" as const, name: input.model };
            }),
          ),
      },
    },
  };
}

/** The configuration router, as the merged mount's and the client's own types are derived from it. */
export type ConfigApiRouter = ReturnType<typeof createConfigApiRouter>;
