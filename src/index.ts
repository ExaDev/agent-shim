/**
 * The library surface of agent-shim: the pure, port-injected parts other tools can call in-process instead of shelling out to the CLI. Four groups, none of which imports interactive prompting or argument parsing:
 *
 * - identity and configuration-profile resolution and farm sync (`resolveDecisions`, `resyncFarm`, `buildEntryFacts`, ...), pure over facts and ports passed in;
 * - routing: the front door's Remote-Control-preserving, capability-authenticated CONNECT surface and its certificate authority, the front-door supervisor and ensure lifecycle, and the headroom supervisor and ensure lifecycle, each pure over its injected ports;
 * - the ambient-credential guard;
 * - the per-identity usage snapshot a statusline or launcher reads: its schema and the reader over an injected filesystem;
 * - the state root's layout (`resolveAgentShimHome`, `resolveLayoutPaths`, `buildLayoutPaths`), which includes adopting an existing `~/.claude-use` in place, and the Zod schema and inferred type of every configuration file (identity, configuration profile, provider, pool, directory rules, global config, credential), so a tool can validate or generate them with the same definitions the CLI uses.
 *
 * Creating and changing identities, configuration profiles, providers, pools and directory rules: the `*Store` modules, which take the state root's `LayoutPaths`, return typed values and throw `CliError` subclasses.
 *
 * - `check` and `doctor` as data: `collectCheckReport` and `collectDoctorReport` read this machine and return the report, and the pure `runCheck` and `runDoctor` take the facts as parameters.
 *
 * - launching: `prepareClaudeLaunch` resolves a launch for a directory on this machine and returns the binary, arguments and environment to spawn (performing the farm resync and daemon registration the child depends on), and `prepareLaunch` does the same over injected ports.
 *
 * Everything the CLI alone needs (commander wiring and prompts) is deliberately not exported here.
 */

export { resolveDecisions, topLevelNames, type ResolveDecisionsInput, type ResolvedState } from "./resolve/pipeline";
export type { CompiledRule, Decision, Diagnostic, EliminatedRule, EntryFact, EntryFacts, FlattenedCascade, Layer, LayerId } from "./resolve/types";
export {
  buildEntryFacts,
  carryOver,
  FARM_MANIFEST_FILENAME,
  readFarmManifest,
  recoverFarm,
  recoveryDiagnostics,
  resyncFarm,
  type BuildEntryFactsParams,
  type CarryOverParams,
  type CarryOverResult,
  type RecoverFarmParams,
  type RecoveryResult,
  type ResyncFarmParams,
  type ResyncFarmResult,
} from "./launcher/farm";

export {
  CONNECT_INTERCEPT_HOST,
  CONNECT_INTERCEPT_HOSTS,
  CONNECT_LIMITS,
  createLeafCache,
  ensureCa,
  forwardableHeaders,
  generateCa,
  isInterceptedHost,
  mintLeaf,
  parseConnectTarget,
  realConnectCertStore,

  ROUTED_PATH_PREFIX,
  servedByPipeline,
  startConnectServer,
  type CaMaterial,
  type ConnectCertStore,
  type ConnectEffects,
  type ConnectLimits,
  type ConnectServerConfig,
  type ConnectServerHandle,
  type ConnectTarget,
  type LeafCert,
} from "./frontdoor/connect";
export { realConnectEffects } from "./frontdoor/connectEffects";
export { ensureFrontDoor, FrontDoorStartError, type EnsureFrontDoorPorts } from "./frontdoor/ensure";
export { runFrontDoorSupervisor, type FrontDoorSupervisorPorts, type RunFrontDoorSupervisorOptions } from "./frontdoor/supervisor";
export { listUsageSnapshots, readUsageSnapshot, snapshotPath, UsageSnapshotError, type UsageReadFs } from "./usage/read";
export { UsageSnapshotSchema, type UsageSnapshot } from "./usage/schema";
export { ensureHeadroom, HeadroomStartError, type EnsureHeadroomPorts } from "./headroom/ensure";
export { resolveSupervisorConfig, runSupervisor, type HeadroomSupervisorConfig, type RunSupervisorOptions, type SupervisorPorts } from "./headroom/supervisor";

export {
  AMBIENT_CREDENTIAL_VARS,
  detectAmbientCredential,
  evaluateAmbientCredentialGuard,
  formatAmbientCredentialGuardMessage,
  type AmbientCredentialDetection,
  type AmbientCredentialGuardResult,
  type AmbientCredentialVar,
  type EvaluateAmbientCredentialGuardParams,
  type InjectedCredential,
} from "./launcher/guard";

export { buildLayoutPaths, resolveAgentShimHome, resolveClaudeHome, resolveLayoutPaths, type LayoutPaths } from "./paths";
export { CliError, EXIT_FAILURE, EXIT_USAGE, UsageError } from "./cliError";
export {
  CategoryClassificationOverlaySchema,
  CategoryClassificationSchema,
  CategoryMapSchema,
  ConfigProfileSchema,
  CredentialCacheSchema,
  CredentialSchema,
  CredentialSourceSchema,
  DirectoryRuleSchema,
  DirectoryRulesSchema,
  EntryValueSchema,
  GlobalConfigSchema,
  IdentitySchema,
  PoolNameSchema,
  PoolSchema,
  PortableConfigSchema,
  ProviderSchema,
  WhenSchema,
  type CategoryMap,
  type ConfigProfile,
  type Credential,
  type CredentialSource,
  type DirectoryRule,
  type DirectoryRules,
  type EntryValue,
  type GlobalConfig,
  type Identity,
  type Pool,
  type PortableConfig,
  type Provider,
  type WhenCondition,
} from "./config/schema";

export {
  addIdentity,
  IdentityAlreadyExistsError,
  IdentityNotFoundError,
  identityExists,
  InvalidIdentityNameError,
  isIdentityDirectoryName,
  listIdentities,
  readActiveIdentity,
  readIdentity,
  removeIdentity,
  setAllowAmbientCredential,
  setDefaultConfigProfile,
  setIdentityCredential,
  useIdentity,
  type IdentityCredentialChange,
  type IdentityListEntry,
  type IdentityListing,
  type UnreadableIdentityListEntry,
} from "./identityStore";
export {
  createProfile,
  InvalidCategoryNameError,
  listProfiles,
  ProfileAlreadyExistsError,
  ProfileNotFoundError,
  profileExists,
  readGlobalConfig,
  readProfile,
  removeProfile,
  setGlobalDefaultProfile,
  setProfileCategories,
  setProfileEntries,
  setProfileLaunchFlags,
  setProfileMetadata,
  type ProfileListEntry,
} from "./configProfilesStore";
export {
  addProvider,
  describeProviderEndpoint,
  InvalidProviderNameError,
  LegacyProviderFileError,
  listProviders,
  ProviderAlreadyExistsError,
  ProviderKindMismatchError,
  ProviderNotFoundError,
  providerExists,
  readProvider,
  removeProvider,
  updateProvider,
  type AddProviderInput,
  type ProviderListEntry,
  type UpdateProviderInput,
} from "./providersStore";
export { addPool, PoolNotFoundError, readPools, removePool, requirePool, setPool } from "./poolStore";
export {
  addDirectoryRule,
  DirectoryRuleAlreadyExistsError,
  DirectoryRuleMissingTargetError,
  DirectoryRuleNotFoundError,
  listDirectoryRules,
  readDirectoryRules,
  removeDirectoryRule,
  updateDirectoryRule,
  writeDirectoryRules,
  type AddDirectoryRuleOptions,
  type UpdateDirectoryRuleOptions,
} from "./directoryRulesStore";
export {
  checkReportHasWarnings,
  checkReportToJson,
  collectCheckReport,
  formatCheckReport,
  runCheck,
  type CheckReport,
  type CollectCheckReportParams,
  type RunCheckParams,
} from "./checkReport";
export {
  collectDoctorReport,
  formatDoctorReport,
  runDoctor,
  type CollectDoctorReportParams,
  type DoctorReport,
  type RunDoctorParams,
} from "./doctorReport";
export { prepareLaunch, type LaunchPlan, type PrepareLaunchParams } from "./launcher";
export { LaunchRefusedError, prepareClaudeLaunch, type PrepareClaudeLaunchOptions } from "./launchWiring";

