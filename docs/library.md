# Using agent-shim as a library

`agent-shim` (and `claude-use`, its former name, published as an identical package) ships a library alongside the CLI: `import { ... } from "agent-shim"`, ESM or CommonJS, with type declarations. The library exposes the parts that are pure over facts and ports passed in, so another tool can call them in process instead of shelling out. It never imports `commander` or `@clack/prompts`, and the build fails if that stops being true.

## What it exposes

| Group | Entry points | Use it to |
|---|---|---|
| State root | `resolveAgentShimHome`, `resolveLayoutPaths`, `buildLayoutPaths`, `resolveClaudeHome`, `LayoutPaths` | Find where agent-shim keeps its state, with the same rules as the CLI (`AGENT_SHIM_HOME`, then `~/.agent-shim`, then an existing `~/.claude-use` used in place) |
| Configuration schemas | `IdentitySchema`, `ConfigProfileSchema`, `ProviderSchema`, `PoolSchema`, `DirectoryRulesSchema`, `GlobalConfigSchema`, `CredentialSchema`, `CategoryMapSchema` and the rest, each with its inferred type | Validate or generate a config file with the definitions the CLI itself uses; `z.toJSONSchema(Schema)` produces a JSON Schema |
| Resolution and farm sync | `resolveDecisions`, `buildEntryFacts`, `resyncFarm`, `recoverFarm` | Decide what an identity shares for a directory, and build or repair its farm, over an injected filesystem |
| Routing | `startConnectServer`, `ensureFrontDoor`, `runFrontDoorSupervisor`, `ensureHeadroom`, `runSupervisor` | Run or attach to the front door and the headroom daemon |
| Usage | `readUsageSnapshot`, `listUsageSnapshots`, `UsageSnapshotSchema` | Read the per-identity usage snapshot a statusline shows |
| Guard | `detectAmbientCredential`, `evaluateAmbientCredentialGuard` | Check whether an environment variable would override an identity's login |
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

Creating and changing identities, configuration profiles, providers, pools and directory rules, inspecting a directory (`check`), auditing the whole tree (`doctor`) and launching `claude` are CLI operations today. Scripts should call the CLI for those; every `list`, `show`, `check` and `doctor` command accepts `--json`.

The export list is guarded by `src/index.test.ts`, so removing or renaming an entry point is a deliberate, visible change.
