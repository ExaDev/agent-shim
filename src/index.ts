/**
 * The library surface of agent-shim: the pure, port-injected parts other tools can call in-process instead of shelling out to the CLI. Four groups, none of which imports interactive prompting or argument parsing:
 *
 * - identity and configuration-profile resolution and farm sync (`resolveDecisions`, `resyncFarm`, `buildEntryFacts`, ...), pure over facts and ports passed in;
 * - routing: the front door's Remote-Control-preserving, capability-authenticated CONNECT surface and its certificate authority, the front-door supervisor and ensure lifecycle, and the headroom supervisor and ensure lifecycle, each pure over its injected ports;
 * - the ambient-credential guard;
 * - the per-identity usage snapshot a statusline or launcher reads: its schema and the reader over an injected filesystem.
 *
 * Everything the CLI alone needs (commander wiring, prompts, `doctor`, `check`) is deliberately not exported here.
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
  CONNECT_LIMITS,
  createLeafCache,
  ensureCa,
  forwardableHeaders,
  generateCa,
  isInterceptedHost,
  mintLeaf,
  parseConnectTarget,
  realConnectCertStore,
  realConnectEffects,
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
