/**
 * The library surface of claude-use: the pure, port-injected parts other tools can call in-process instead of shelling out to the CLI. Three groups, none of which imports interactive prompting or argument parsing:
 *
 * - identity and configuration-profile resolution and farm sync (`resolveDecisions`, `resyncFarm`, `buildEntryFacts`, ...), pure over facts and ports passed in;
 * - headroom routing: the Remote-Control-preserving MITM CONNECT proxy and its certificate authority, and the supervisor and ensure lifecycle, pure over `SupervisorPorts`;
 * - the ambient-credential guard.
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
  createLeafCache,
  ensureCa,
  forwardableHeaders,
  generateCa,
  HEADROOM_SERVED_PATH_PREFIX,
  isInterceptedHost,
  MITM_INTERCEPT_HOST,
  mintLeaf,
  parseConnectTarget,
  realMitmCertStore,
  realMitmEffects,
  servedByHeadroom,
  startMitmServer,
  type CaMaterial,
  type ConnectTarget,
  type LeafCert,
  type MitmCertStore,
  type MitmEffects,
  type MitmServerConfig,
  type MitmServerHandle,
} from "./headroom/mitm";
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
