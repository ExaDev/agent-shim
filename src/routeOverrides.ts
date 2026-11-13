import type { Command } from "commander";

import { printJson, reportMutation, withExamples, type CommandDeps } from "./cli/commandDeps";
import { UsageError } from "./cliError";
import type { LayoutPaths } from "./paths";
import { overrideNamesOf, overrideScopeProblem, overrideTargetProblem } from "./routeOverrideChecks";
import { describeScope, readRouteOverrides, ROUTE_OVERRIDE_SCOPES, scopeLabelOf, withRouteOverride, writeRouteOverrides, type RouteOverrideScope } from "./routeOverridesStore";
import type { RouteOverrides } from "./routeOverridesSchema";

/** The scope flags one `route set` or `route unset` takes, at most one of them. */
interface ScopeOptions {
  readonly session?: string;
  readonly identity?: string;
  readonly provider?: string;
}

/** The scope the flags name: global with none, else the one given. Throws `UsageError` when more than one is given. */
function scopeOfOptions(options: Readonly<ScopeOptions>): RouteOverrideScope {
  const given = [
    ...(options.session === undefined ? [] : [{ kind: "session", name: options.session } as const]),
    ...(options.identity === undefined ? [] : [{ kind: "identity", name: options.identity } as const]),
    ...(options.provider === undefined ? [] : [{ kind: "provider", name: options.provider } as const]),
  ];
  if (given.length > 1) {
    throw new UsageError("Give at most one of --session, --identity and --provider: an override lives in one scope.");
  }
  return given[0] ?? { kind: "global" };
}

/** One entry as `route list` reports it. */
interface ListedOverride {
  readonly scope: string;
  readonly model: string;
  readonly target: string;
}

/** Every entry of the overrides, in scope precedence order (session, identity, provider, global) and by name within a kind. */
function listed(overrides: Readonly<RouteOverrides>): readonly ListedOverride[] {
  const tables: Readonly<Record<(typeof ROUTE_OVERRIDE_SCOPES)[number], readonly (readonly [RouteOverrideScope, Readonly<Record<string, string>>])[]>> = {
    session: Object.entries(overrides.sessions ?? {}).map(([name, table]) => [{ kind: "session", name }, table] as const),
    identity: Object.entries(overrides.identities ?? {}).map(([name, table]) => [{ kind: "identity", name }, table] as const),
    provider: Object.entries(overrides.providers ?? {}).map(([name, table]) => [{ kind: "provider", name }, table] as const),
    global: overrides.global === undefined ? [] : [[{ kind: "global" }, overrides.global] as const],
  };
  return ROUTE_OVERRIDE_SCOPES.flatMap((kind) => [...tables[kind]].sort(([left], [right]) => scopeLabelOf(left).localeCompare(scopeLabelOf(right))).flatMap(([scope, table]) => Object.entries(table).sort(([left], [right]) => left.localeCompare(right)).map(([model, target]) => ({ scope: scopeLabelOf(scope), model, target }))));
}

/**
 * Sets one override after checking it against the configuration as the door would route it: the scope names a defined identity or provider, and the target names something defined (`overrideTargetProblem`). Shared by `route set` and `config.route.set`, so both refuse the same writes. Throws `UsageError` for anything refused. Returns the overrides as written.
 */
export function setRouteOverride(paths: LayoutPaths, scope: RouteOverrideScope, model: string, target: string): RouteOverrides {
  const names = overrideNamesOf(paths);
  const scopeProblem = overrideScopeProblem(scope, names);
  if (scopeProblem !== undefined) {
    throw new UsageError(`Cannot set an override ${describeScope(scope)}: ${scopeProblem}.`);
  }
  const problem = overrideTargetProblem(target, names);
  if (problem !== undefined) {
    throw new UsageError(`Cannot route ${JSON.stringify(model)} to ${JSON.stringify(target)}: ${problem}.`);
  }
  const overrides = withRouteOverride(readRouteOverrides(paths), scope, model, target);
  writeRouteOverrides(paths, overrides);
  return overrides;
}

/** Removes one override; throws `UsageError` when none is set there. Shared by `route unset` and `config.route.unset`. Returns the overrides as written. */
export function unsetRouteOverride(paths: LayoutPaths, scope: RouteOverrideScope, model: string): RouteOverrides {
  const overrides = withRouteOverride(readRouteOverrides(paths), scope, model, undefined);
  writeRouteOverrides(paths, overrides);
  return overrides;
}

/** Registers `agent-shim route set|unset|list`: the runtime route overrides the front door applies to the next request with no restart. */
export function registerRouteCommand(program: Command, deps: CommandDeps): void {
  const { paths } = deps;
  const route = program.command("route").description("Route a Claude model name or class somewhere else at runtime, per session, identity, provider or globally; the front door applies a change to the next request.");
  withExamples(route, ["agent-shim route set opus z/glm-5.3", "agent-shim route list"]);
  const scoped = (command: Command): Command =>
    command
      .option("--session <id>", "One launch session, by the session id its requests carry.")
      .option("--identity <name>", "The sessions running as one identity.")
      .option("--provider <name>", "The sessions whose request would reach one provider.")
      .option("--json", "Print the result as JSON.");
  withExamples(
    scoped(route.command("set <model> <target>").description("Route requests for a Claude model name or class (opus, sonnet, haiku, fable, claude-opus-5-5) to a target: <provider>/<model>, anthropic/<model>, a virtual model, family:<key>, acct:<identity>/<model> or a selector (auto/<selector>[/<class>]).")),
    ["agent-shim route set opus z/glm-5.3", "agent-shim route set claude-sonnet-5-5 auto/subs/sonnet --identity work", "agent-shim route set haiku fast --session <id> --json"],
  ).action((model: string, target: string, options: Readonly<ScopeOptions & { json?: boolean }>) => {
    const scope = scopeOfOptions(options);
    setRouteOverride(paths, scope, model, target);
    reportMutation(options.json, { action: "updated", kind: "route", name: model, value: { scope: scopeLabelOf(scope), model, target } }, () => {
      console.log(`Routing ${model} to ${target} ${describeScope(scope)}, from each session's next request.`);
    });
  });
  withExamples(
    scoped(route.command("unset <model>").description("Remove one override, so requests for the name go where they would without it.")),
    ["agent-shim route unset opus", "agent-shim route unset claude-sonnet-5-5 --identity work --json"],
  ).action((model: string, options: Readonly<ScopeOptions & { json?: boolean }>) => {
    const scope = scopeOfOptions(options);
    unsetRouteOverride(paths, scope, model);
    reportMutation(options.json, { action: "removed", kind: "route", name: model, value: undefined }, () => {
      console.log(`Removed the override of ${model} ${describeScope(scope)}.`);
    });
  });
  withExamples(
    route.command("list").description("List every override, highest precedence first: session, identity, provider, global.").option("--json", "Print the overrides as JSON."),
    ["agent-shim route list", "agent-shim route list --json"],
  ).action((options: Readonly<{ json?: boolean }>) => {
    const entries = listed(readRouteOverrides(paths));
    if (options.json === true) {
      printJson(entries);
      return;
    }
    if (entries.length === 0) {
      console.log("No route overrides are set.");
      return;
    }
    for (const entry of entries) {
      console.log(`${entry.scope}  ${entry.model} -> ${entry.target}`);
    }
  });
}
