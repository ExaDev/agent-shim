import type { LayoutPaths } from "./paths";

/** What a rename does about a place the state root keeps files. `name` places hold an identity's name, which both renames rewrite. `id` places are filed under an identity's id (the directory it is stored in), which only `identity rename --move` changes, so only it moves or rewrites them; the rename of the name alone leaves them as they are, and that is what lets it go ahead while sessions run. `unaffected` places hold nothing a rename could invalidate. */
type NameLocation = "name" | "id" | "unaffected";

/**
 * Every field of `LayoutPaths`, decided. A rename must rewrite each place an identity's name is filed, `--move` also each place filed under its id, and a place added later is easy to forget, so this table is typed to be complete: adding a field to `LayoutPaths` without deciding it here is a compile error, and the decision is where a reviewer sees it.
 *
 * `identitiesDir` is `name` for the `identity.json` in each identity's directory and the credential sources it holds; the directories themselves are named by id, and `--move` renames one. `root` is `id` for the two directories it derives that `LayoutPaths` has no field for, `credentials/` (one token file per identity id) and `credential-cache/` (one entry per owner, `identity <id>` for an identity). `providersDir` is `id` because a provider's credential sources can name an identity's token file, its directory or its Keychain login, all of which only `--move` changes; the provider's own name, which keys its file, does not change. `usageSnapshotsDir` is `id`: the door files a snapshot under the id the session's identity header carries. `usageAnchorsFile` is `id`: the window keeper files each identity's handled anchor under its id. `superviseDir` and `modelMovesDir` are `id`: the supervisor registers each session and the door writes each model-move request under the id of the identity, so a rename of the name leaves them true. `routeOverridesFile` is `name`: an identity scope is keyed by the identity's name, and a target may name one (`acct:<name>/<model>`, or a selector naming it). The `unaffected` ones are keyed by something other than an identity (a provider's name, a job, a session, a process), hold the front door's and headroom's runtime state, or are history that keeps the key it was written under (the usage log, keyed by id). Tests rename an identity referenced from every place, once each way, and check that each file a rename of the name changed lies in a `name` place and each file `--move` changed in a `name` or `id` place, so this table cannot drift from what the renames do.
 */
export const IDENTITY_NAME_LOCATIONS = {
  root: "id",
  identitiesDir: "name",
  configProfilesDir: "name",
  directoryRulesFile: "name",
  activeIdentityFile: "name",
  globalConfigFile: "name",
  usageSnapshotsDir: "id",
  usagePicksFile: "name",
  usageAnchorsFile: "id",
  providersDir: "id",
  providerAliasesFile: "unaffected",
  catalogueDir: "unaffected",
  categoriesLocalFile: "unaffected",
  claudeShimFile: "unaffected",
  mcpPermissionsFile: "unaffected",
  chatgptSignInFile: "unaffected",
  headroomDir: "unaffected",
  headroomStateFile: "unaffected",
  headroomRoutingFile: "unaffected",
  routeOverridesFile: "name",
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
  identityNameRenamesDir: "unaffected",
  launchesDir: "unaffected",
  launchControlDir: "unaffected",
  superviseDir: "id",
  modelMovesDir: "id",
} as const satisfies Record<keyof LayoutPaths, NameLocation>;
