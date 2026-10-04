# Using agent-shim as a library

`agent-shim` (and `claude-use`, its former name, published as an identical package) ships a library alongside the CLI: `import { ... } from "agent-shim"`, ESM or CommonJS, with type declarations. The library exposes the parts that are pure over facts and ports passed in, so another tool can call them in process instead of shelling out. It never imports `commander` or `@clack/prompts`, and the build fails if that stops being true.

## What it exposes

| Group | Entry points | Use it to |
|---|---|---|
| State root | `resolveAgentShimHome`, `resolveLayoutPaths`, `buildLayoutPaths`, `resolveClaudeHome`, `LayoutPaths` | Find where agent-shim keeps its state, with the same rules as the CLI (`AGENT_SHIM_HOME`, then `~/.agent-shim`, then an existing `~/.claude-use` used in place) |
| Configuration schemas | `IdentitySchema`, `ConfigProfileSchema`, `ProviderSchema`, `PoolSchema`, `DirectoryRulesSchema`, `GlobalConfigSchema`, `CredentialSchema`, `CategoryMapSchema` and the rest, each with its inferred type | Validate or generate a config file with the definitions the CLI itself uses; `z.toJSONSchema(Schema)` produces a JSON Schema |
| Resolution and farm sync | `resolveDecisions`, `buildEntryFacts`, `resyncFarm`, `recoverFarm` | Decide what an identity shares for a directory, and build or repair its farm, over an injected filesystem |
| Routing | `startConnectServer`, `ensureFrontDoor`, `runFrontDoorSupervisor`, `ensureHeadroom`, `runSupervisor` | Run or attach to the front door and the headroom daemon |
| Remote Control | `createRcSessionTracker`, `observingRoutedRoute`, `injectRcUserMessage`, `answerRcControlRequest`, `interruptRcSession`, `setRcSessionModel`, `setRcSessionPermissionMode` (with `RC_PERMISSION_MODES` and `isRcPermissionMode` for its mode enum), `realRcEventDial`, `createRcControlHandler`, `frontDoorRcControl` | Track the `cse_` sessions whose traffic a door serves, their pending control requests and worker status, inject a prompt into one, answer a pending request, and send the client half's own control requests into one (interrupt, model, permission mode), each by replaying the protocol's client-half write over the door's own dials |
| Usage | `readUsageSnapshot`, `listUsageSnapshots`, `UsageSnapshotSchema` | Read the per-identity usage snapshot a statusline shows |
| Guard | `detectAmbientCredential`, `evaluateAmbientCredentialGuard` | Check whether an environment variable would override an identity's login |
| Configuration management | `addIdentity`, `listIdentities`, `setIdentityCredential`, `createProfile`, `setProfileCategories`, `addProvider`, `readProvider`, `addPool`, `addDirectoryRule`, and the rest of the `*Store` modules | Create, read, list and change identities, configuration profiles, providers, pools and directory rules under a state root, exactly as the CLI does; each takes the `LayoutPaths` root and throws a typed error such as `IdentityNotFoundError` |
| Reports | `collectCheckReport`, `collectDoctorReport`, `runCheck`, `runDoctor`, `formatCheckReport`, `formatDoctorReport`, `checkReportToJson` | Ask what a launch in a directory would share or hide (`check`), or audit the whole state root (`doctor`), and get a report object back. The `collect…` functions read this machine; `runCheck` and `runDoctor` take the facts as parameters, so they run over fakes |
| Launching | `prepareClaudeLaunch`, `LaunchRefusedError`, `prepareLaunch`, `LaunchPlan` | Resolve a launch for a directory (the identity, provider, credential, sharing rules and flags the command line would apply) and get back the `claude` binary, arguments and environment to spawn yourself. It performs the effects the child depends on (the identity's farm resync, and bringing up and registering with the front door and headroom, which needs `agentShim`, the path of the agent-shim executable, because this process is not it); call `release` on the plan when the child exits. A refusal throws `LaunchRefusedError` with the launcher's message. `prepareLaunch` is the same over injected ports |
| Errors | `CliError`, `UsageError`, `EXIT_FAILURE`, `EXIT_USAGE` | Tell an expected, user-facing failure from a crash |

## Example

```ts
import { IdentitySchema, resolveLayoutPaths } from "agent-shim";
import { readFileSync } from "node:fs";
import path from "node:path";

const paths = resolveLayoutPaths();
const identity = IdentitySchema.parse(JSON.parse(readFileSync(path.join(paths.identitiesDir, "work", "identity.json"), "utf8")));
```

## What is not in the library

Launching `claude` is a CLI operation today, and so is anything interactive (the setup wizards and prompts). Scripts should call the CLI for those; every `list`, `show`, `check`, `doctor` and mutating (`add`, `set`, `remove`, `use`) command accepts `--json`.

The export list is guarded by `src/index.test.ts`, so removing or renaming an entry point is a deliberate, visible change.
