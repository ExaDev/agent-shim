import type { Command } from "commander";

import { printJson, withExamples, type CommandDeps } from "../cli/commandDeps";
import { UsageError } from "../cliError";
import { readFrontDoorState } from "../frontdoor/state";
import { daemonSpawnerFor } from "../launchWiring";
import { realFarmFs, realHeadroomPort, realIsProcessRunning } from "../realPorts";
import { asksForHeadroom, readRoutingSetting, withRoutingChoice, writeRoutingSetting, type RoutingScope } from "./routingSetting";
import { removeSession } from "./state";

interface RoutingOptions {
  readonly session?: string;
  readonly now?: boolean;
  readonly json?: boolean;
}

/** The long-lived process that keeps the daemon wanted on a session's behalf: the serving front door, which lives as long as there is anything routed through it. */
function servingDoorPid(deps: CommandDeps): number | undefined {
  const pid = readFrontDoorState(realFarmFs, deps.paths.frontdoorStateFile)?.supervisorPid;
  return pid !== undefined && realIsProcessRunning(pid) ? pid : undefined;
}

/**
 * Registers `agent-shim headroom enable` and `disable`: the live routing setting the front door reads on every request, for every session or one (`--session`). A change reaches a session at its next cache boundary unless `--now` pays for an immediate prompt-cache rewrite.
 *
 * Enabling brings the daemon up and registers the serving front door as the session that keeps it alive, since the sessions it will serve may not have been launched with headroom; disabling the last request for headroom releases that registration so the daemon can idle out.
 */
export function registerHeadroomRoutingCommands(headroom: Command, deps: CommandDeps): void {
  const { paths } = deps;
  const change = (viaHeadroom: boolean) => (options: Readonly<RoutingOptions>): void => {
    const scope: RoutingScope = options.session === undefined ? { kind: "global" } : { kind: "session", sessionId: options.session };
    const doorPid = servingDoorPid(deps);
    if (viaHeadroom && doorPid === undefined) {
      throw new UsageError("no front door is serving, so nothing is routed yet; start a launch, then enable headroom for its sessions.");
    }
    const setting = withRoutingChoice(readRoutingSetting(paths), scope, { viaHeadroom, immediately: options.now === true, nowMs: Date.now() });
    if (viaHeadroom && doorPid !== undefined) {
      realHeadroomPort(paths, { spawnDaemon: daemonSpawnerFor(undefined), cwd: process.cwd(), registerAs: doorPid }).ensure({ routesProvider: false });
    }
    writeRoutingSetting(paths, setting);
    if (!asksForHeadroom(setting) && doorPid !== undefined) {
      removeSession(realFarmFs, paths.headroomSessionsDir, doorPid);
    }
    const covers = scope.kind === "global" ? "every session without its own setting" : `session ${scope.sessionId}`;
    const when = options.now === true ? "from its next request, rewriting its prompt cache once" : "at each session's next cache boundary";
    if (options.json === true) {
      printJson({ action: viaHeadroom ? "enabled" : "disabled", scope, immediately: options.now === true });
      return;
    }
    console.log(`headroom ${viaHeadroom ? "enabled" : "disabled"} for ${covers}, ${when}`);
  };
  const options = (command: Command): Command =>
    command
      .option("--session <id>", "Cover one launch session instead of every session.")
      .option("--now", "Apply on the session's next request instead of at its next cache boundary. The session's prompt cache is rewritten once.")
      .option("--json", "Print the result as JSON.");
  withExamples(
    options(headroom.command("enable").description("Route sessions through headroom, whatever their launch asked for.")).action(change(true)),
    ["agent-shim headroom enable", "agent-shim headroom enable --session <id> --now"],
  );
  withExamples(
    options(headroom.command("disable").description("Stop routing sessions through headroom, whatever their launch asked for.")).action(change(false)),
    ["agent-shim headroom disable", "agent-shim headroom disable --session <id>"],
  );
}
