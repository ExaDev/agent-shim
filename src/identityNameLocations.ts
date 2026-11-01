import type { LayoutPaths } from "./paths";

/** What `identity rename` does about a place the state root keeps files: `rewritten` when files there hold an identity's name, `unaffected` when they hold nothing a rename could invalidate. */
type NameLocation = "rewritten" | "unaffected";

/**
 * Every field of `LayoutPaths`, decided. A rename must rewrite each place an identity's name is filed, and a place added later is easy to forget, so this table is typed to be complete: adding a field to `LayoutPaths` without deciding it here is a compile error, and the decision is where a reviewer sees it.
 *
 * `rewritten` places are the ones `renameIdentity` plans a step for. `root` is `rewritten` for the two directories it derives that `LayoutPaths` has no field for, `credentials/` (one token file per identity) and `credential-cache/` (one entry per owner). `providersDir` is `rewritten` because a provider's credential sources can name the identity's token file, its directory or its Keychain login, which the rename re-points; the provider's own name, which keys its file, does not change. The `unaffected` ones are keyed by something other than an identity (a provider's name, a job, a session, a process), hold the front door's and headroom's runtime state (which a rename that refuses while a session runs finds idle), or are history that keeps the name it was written under. A test renames an identity referenced from every place and checks that each file it changed lies in a `rewritten` place, so this table cannot drift from what the rename does.
 */
export const IDENTITY_NAME_LOCATIONS = {
  root: "rewritten",
  identitiesDir: "rewritten",
  configProfilesDir: "rewritten",
  directoryRulesFile: "rewritten",
  activeIdentityFile: "rewritten",
  globalConfigFile: "rewritten",
  usageSnapshotsDir: "rewritten",
  usagePicksFile: "rewritten",
  usageAnchorsFile: "rewritten",
  providersDir: "rewritten",
  providerAliasesFile: "unaffected",
  catalogueDir: "unaffected",
  categoriesLocalFile: "unaffected",
  claudeShimFile: "unaffected",
  mcpPermissionsFile: "unaffected",
  chatgptSignInFile: "unaffected",
  headroomDir: "unaffected",
  headroomStateFile: "unaffected",
  headroomRoutingFile: "unaffected",
  headroomLegacyStateFile: "unaffected",
  headroomAllowlistFile: "unaffected",
  headroomSocketDir: "unaffected",
  headroomLockFile: "unaffected",
  headroomSessionsDir: "unaffected",
  logsDir: "unaffected",
  headroomLogPath: "unaffected",
  frontdoorDir: "unaffected",
  frontdoorCaDir: "unaffected",
  frontdoorCaCertFile: "unaffected",
  frontdoorCaKeyFile: "unaffected",
  frontdoorCaBundlesDir: "unaffected",
  frontdoorStateFile: "unaffected",
  frontdoorLockFile: "unaffected",
  frontdoorControlTokenFile: "unaffected",
  frontdoorSessionsDir: "unaffected",
  frontdoorDirectRecordsDir: "unaffected",
  frontdoorDrainingDir: "unaffected",
  frontdoorRcCredentialsDir: "unaffected",
  frontdoorLogPath: "unaffected",
  usageDir: "unaffected",
  usageLogDir: "unaffected",
  usageJobsFile: "unaffected",
  jobLogsDir: "unaffected",
  statuslineDir: "unaffected",
  identityRenamesDir: "unaffected",
  launchesDir: "unaffected",
  superviseDir: "unaffected",
  modelMovesDir: "unaffected",
} as const satisfies Record<keyof LayoutPaths, NameLocation>;
