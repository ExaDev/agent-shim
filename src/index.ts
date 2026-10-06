/**
 * The library surface of agent-shim: the pure, port-injected parts other tools can call in-process instead of shelling out to the CLI. Four groups, none of which imports interactive prompting or argument parsing:
 *
 * - identity and configuration-profile resolution and farm sync (`resolveDecisions`, `resyncFarm`, `buildEntryFacts`, ...), pure over facts and ports passed in;
 * - routing: the front door's Remote-Control-preserving, capability-authenticated CONNECT surface and its certificate authority, the Remote Control session tracker (pending control requests and worker status included) with prompt injection and control-request answering over the same observed protocol, the control surface that lists, reads status and writes through, the client read stream attachment (the SSE parser, the fan-out and the per-session hub that holds the stream open over the door's own dials), the same operations as a typed oRPC API with its node handler and TLS-pinned client, the door's control-plane routers beside it (usage snapshots and effective quota windows, the front door's status and session registry, check and doctor as data), the front-door supervisor and ensure lifecycle, and the headroom supervisor and ensure lifecycle, each pure over its injected ports;
 * - the ambient-credential guard;
 * - the per-identity usage snapshot a statusline or launcher reads: its schema and the reader over an injected filesystem, `effectiveWindow` (how a window past its reset reads), and the pool ranking (`rankPool` over snapshots and a clock, `collectPoolPick` reading this machine, and the schema of the report `pool pick --json` prints);
 * - `evaluateWhen` and `matchBranch`, the condition evaluator behind a rule's or entry's `when`, so a consumer reading directory rules applies the same semantics;
 * - the state root's layout (`resolveAgentShimHome`, `resolveLayoutPaths`, `buildLayoutPaths`), which includes adopting an existing `~/.claude-use` in place, and the Zod schema and inferred type of every configuration file (identity, configuration profile, provider, pool, directory rules, global config, credential), so a tool can validate or generate them with the same definitions the CLI uses.
 *
 * Creating and changing identities, configuration profiles, providers, pools and directory rules: the `*Store` modules, which take the state root's `LayoutPaths`, return typed values and throw `CliError` subclasses.
 *
 * - `check` and `doctor` as data: `collectCheckReport` and `collectDoctorReport` read this machine and return the report, the pure `runCheck` and `runDoctor` take the facts as parameters, and `checkReportToJson` returns the report in the shape `CheckReportJsonSchema` (in `checkReportSchema.ts`) defines, so the JSON the CLI prints, the door's `check.run` procedure and any consumer's validation share one definition.
 *
 * - launching: `prepareClaudeLaunch` resolves a launch for a directory on this machine and returns the binary, arguments and environment to spawn (performing the farm resync and daemon registration the child depends on), `prepareLaunch` does the same over injected ports, and `runLauncher` and `spawnClaude` are the spawn step itself: the former plans and releases in one call, the latter takes a plan's parts with the release-on-exit ordering an embedder would otherwise get wrong.
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
  type ConnectLocalSurface,
  type ConnectServerConfig,
  type ConnectServerHandle,
  type ConnectTarget,
  type LeafCert,
} from "./frontdoor/connect";
export { lateRcEventDial, lateRcStreamDial, realConnectEffects, realRcEventDial, realRcStreamDial, type RcDialTarget } from "./frontdoor/connectEffects";
export {
  RC_SESSIONS_PATH_PREFIX,
  RC_IDLE_EXPIRY_MS,
  RC_PENDING_DEADLINE_MS,
  RC_REQUEST_PARSE_CAP_BYTES,
  createRcSessionTracker,
  observingRoutedRoute,
  rcObserverAsPassthrough,
  type RcExchangeObserver,
  type RcObservedRequest,
  type RcPendingRequestSummary,
  type RcSessionStatus,
  type RcSessionSummary,
  type RcSessionTracker,
  type RcSessionTrackerDeps,
  type RcWorkerFact,
} from "./frontdoor/rcSessions";
export {
  RC_CONTEXT_USAGE_DETAILS,
  RC_PERMISSION_MODES,
  RC_READ_FILE_ENCODINGS,
  answerRcControlRequest,
  authenticateRcSessionMcpServer,
  buildRcControlRequestPayload,
  buildRcControlResponsePayload,
  buildRcEndSessionPayload,
  buildRcEventWriteBody,
  buildRcFileSuggestionsPayload,
  buildRcGetContextUsagePayload,
  buildRcGetUsagePayload,
  buildRcInterruptPayload,
  buildRcKeepAlivePayload,
  buildRcMcpAuthenticatePayload,
  buildRcMcpOAuthCallbackUrlPayload,
  buildRcMcpReconnectPayload,
  buildRcMarkReadBody,
  buildRcMcpStatusPayload,
  buildRcReadFilePayload,
  buildRcSetModelPayload,
  buildRcSetPermissionModePayload,
  buildRcUserMessagePayload,
  endRcSession,
  getRcSessionContextUsage,
  getRcSessionMcpStatus,
  getRcSessionUsage,
  injectRcUserMessage,
  interruptRcSession,
  isRcContextUsageDetail,
  isRcPermissionMode,
  isRcReadFileEncoding,
  rcEventWriteResultFromAnswer,
  readRcSessionFile,
  reconnectRcSessionMcpServer,
  sendRcKeepAlive,
  setRcSessionModel,
  setRcSessionPermissionMode,
  submitRcSessionMcpOAuthCallbackUrl,
  suggestRcSessionFiles,
  teleportRcSession,
  type RcAnswerDecision,
  type RcAnswerDeps,
  type RcContextUsageDetail,
  type RcControlRequestDeps,
  type RcDialAnswer,
  type RcEventDial,
  type RcEventWriteResult,
  type RcInjectDeps,
  type RcObservedCredential,
  type RcPermissionMode,
  type RcReadFileEncoding,
  type RcReadFileOptions,
  type RcWriteHeaders,
} from "./frontdoor/rcWrites";
export { createRcCredentialStore, type RcCredentialStore } from "./frontdoor/rcCredentialStore";
export { CONTROL_PATH_PREFIX, createRcControlHandler, frontDoorRcControl, realRcControlTransport, type FrontDoorRcControl, type RcControlAnswer, type RcControlHandlerDeps, type RcControlTransport } from "./frontdoor/rcControl";
export {
  RC_ORPC_PATH_PREFIX,
  createRcApiNodeHandler,
  createRcApiRouter,
  doorApiAuth,
  doorApiNodeHandlerOf,
  frontDoorApiLink,
  frontDoorRcApiClient,
  type DoorApiContext,
  type RcApiClient,
  type RcApiDeps,
  type RcApiRouter,
} from "./frontdoor/rcApi";
export {
  createControlApiRouter,
  createDoorApiNodeHandler,
  createDoorApiRouter,
  frontDoorApiClient,
  type ControlApiClient,
  type ControlApiDeps,
  type ControlApiRouter,
  type DoorApiClient,
  type DoorApiDeps,
  type DoorApiRouter,
} from "./frontdoor/controlApi";
export {
  CheckRunInputSchema,
  DoctorFindingSchema,
  DoctorRunOutputSchema,
  EffectiveWindowSchema,
  FrontDoorSessionsOutputSchema,
  FrontDoorSessionStatusSchema,
  FrontDoorStatusOutputSchema,
  HeadroomSocketTargetSchema,
  UsageListOutputSchema,
  UsageLiveOutputSchema,
  UsageWindowsInputSchema,
  UsageWindowsOutputSchema,
} from "./frontdoor/controlSchemas";
export { collectFrontDoorStatus, formatFrontDoorStatus, headroomSocketTarget, type FrontDoorSessionStatus, type FrontDoorStatus } from "./frontdoor/status";
export { FrontDoorStateSchema } from "./frontdoor/state";
export { createEventsApiRouter, type DoorEventsApiDeps } from "./frontdoor/eventsApi";
export {
  DOOR_EVENT_BUFFER_EVENTS,
  createDoorEventHub,
  rcFanoutOnDoorHub,
  type DoorEventHub,
  type DoorEventPublisher,
  type DoorEventStream,
} from "./frontdoor/eventHub";
export {
  DOOR_EVENT_SOURCE_RC,
  LAUNCH_EVENT_SOURCE,
  DoorEventSchema,
  DoorEventSourceQuerySchema,
  LaunchLifecycleEventSchema,
  type DoorEvent,
  type LaunchLifecycleEvent,
} from "./frontdoor/eventSchemas";
export { createLaunchEventPublisher, type LaunchEventPublisher } from "./frontdoor/launchEvents";
export {
  RcLiveRateLimitSchema,
  RcPermissionModeSchema,
  RcRateLimitInfoSchema,
  RcRateLimitWindowSchema,
  RcStreamEnvelopeSchema,
  RcStreamEventSchema,
  type RcLiveRateLimit,
  type RcRateLimitInfo,
  type RcRateLimitWindow,
  type RcStreamEnvelope,
  type RcStreamEvent,
} from "./frontdoor/rcSchemas";
export { createRcLiveUsage, rcRateLimitInfoOf, type RcLiveUsage, type RcLiveUsageDeps } from "./frontdoor/rcLiveUsage";
export {
  RC_STREAM_BACKOFF_MS,
  createRcEventFanout,
  createRcStreamHub,
  createSseParser,
  parseRcStreamEnvelope,
  type RcEventFanout,
  type RcPresenceAnswer,
  type RcStreamAnswer,
  type RcStreamDial,
  type RcStreamHub,
  type RcStreamHubDeps,
  type SseParsedEvent,
} from "./frontdoor/rcStream";
export {
  RC_SELF_HOST_ENV,
  RC_SELF_HOST_KEEPALIVE_MS,
  RC_SELF_HOST_RETENTION_MS,
  RC_SELF_HOST_SCOPE_LIST,
  RC_SELF_HOST_WORKER_JWT_TTL_SECONDS,
  createRcSelfHostSurface,
  rcSelfHostFromEnv,
  type RcSelfHostCredentialRecord,
  type RcSelfHostDeps,
  type RcSelfHostSurface,
} from "./frontdoor/rcSelfHost";
export { mintRcSelfHostCredential, readRcSelfHostRecord, RC_SELF_HOST_RECORD_DIR, RC_SELF_HOST_RECORD_FILE, type RcSelfHostMintResult } from "./frontdoor/rcSelfHostMint";
export { fetchThroughWebProxy, isPrivateAddress, realRcWebFetch, rcWebFetchAllowsPrivateFromEnv, RC_WEB_FETCH_ALLOW_PRIVATE_ENV, RC_WEB_FETCH_DEADLINE_MS, RC_WEB_FETCH_MAX_BYTES, RC_WEB_FETCH_MAX_REDIRECTS, type RcWebFetchDeps, type RcWebFetchHop, type RcWebFetchOutcome, type RcWebFetcher } from "./frontdoor/rcWebFetch";
export { ensureFrontDoor, FrontDoorStartError, type EnsureFrontDoorPorts } from "./frontdoor/ensure";
export { runFrontDoorSupervisor, type FrontDoorSupervisorPorts, type RunFrontDoorSupervisorOptions } from "./frontdoor/supervisor";
export { listUsageSnapshots, readUsageSnapshot, snapshotPath, UsageSnapshotError, type UsageReadFs } from "./usage/read";
export { UsageSnapshotSchema, type UsageSnapshot } from "./usage/schema";
export { effectiveWindow, type EffectiveWindow } from "./usage/preflight";
export { PROMPT_CACHE_TTL_MS, rankPool, type Candidate, type NestedContribution, type PoolMember, type PoolRanking, type RankPoolInput, type StickyPick } from "./usage/pick";
export { planOf, PlanClassSchema, type PlanClass } from "./usage/plan";
export { collectPoolPick } from "./poolPickReport";
export { PoolPickReportSchema, type PoolPickReport } from "./usage/pickReportSchema";
export { evaluateWhen, matchBranch, type ConditionContext, type WhenEvaluation } from "./resolve/conditions";
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
export { CHECK_CREDENTIAL_APPLIES, CheckReportJsonSchema, type CheckReportJson } from "./checkReportSchema";
export {
  collectDoctorReport,
  formatDoctorReport,
  runDoctor,
  type CollectDoctorReportParams,
  type DoctorReport,
  type RunDoctorParams,
} from "./doctorReport";
export { prepareLaunch, runLauncher, type LaunchPlan, type PrepareLaunchParams, type RunLauncherParams } from "./launcher";
export { spawnClaude, type SpawnClaudeParams } from "./launcher/spawn";
export { LaunchRefusedError, prepareClaudeLaunch, type PrepareClaudeLaunchOptions } from "./launchWiring";

