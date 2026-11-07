import { realFarmFs, realRunningAmong } from "../realPorts";
import type { LayoutPaths } from "../paths";
import { COMPACT_TIMEOUT_MS } from "../supervise/compactTimeout";
import { supervisedSessionOfBridge } from "../supervise/registry";
import { compactInSession, runGoalInSession, sessionControlVersion } from "../supervise/sessionControl";
import { sessionControlPluginPaths } from "../supervise/sessionControlPlugin";
import type { RcClaudeCodeVersions, RcPersonWriteDeps } from "./rcSelfHostCommands";
import { createRcSessionCommands, type RcSessionCommands } from "./rcSessionCommands";
import type { RcEventFanout } from "./rcStream";

/** What the door hands its goal and compaction verbs: its state paths, its tracker's view of the sessions, and, only when it serves Remote Control itself, the self-hosted route's write and stream. */
export interface DoorRcSessionCommandsDeps {
  readonly paths: LayoutPaths;
  /** Whether the tracker holds the session. */
  readonly isTracked: (sessionId: string) => boolean;
  /** Present only in the self-hosted mode: the person's-app write over the self-hosted dial, the fan-out and the observed worker versions. */
  readonly selfHost:
    | {
        /** The person's-app write, over the dial that reaches the door's own surface and nothing else. */
        readonly personWrite: RcPersonWriteDeps;
        /** Why that surface cannot take a command now, or undefined when it can. */
        readonly unavailable: () => string | undefined;
        readonly fanout: RcEventFanout;
        readonly versions: RcClaudeCodeVersions;
      }
    | undefined;
}

/**
 * The door's goal and compaction verbs over the real machine (`rcSessionCommands.ts` holds the routing): a supervised session is reached through its supervisor's in-process control plugin, found by the bridge-session row in its own transcript; a session on the door's own self-hosted surface gets the command written there as a person's app, over a dial that reaches that surface and nothing else (it refuses rather than fall back to the real API host when the surface is not bound, and the route refuses first with the reason); anything else is refused with the reason.
 */
export function createDoorRcSessionCommands(deps: DoorRcSessionCommandsDeps): RcSessionCommands {
  const { selfHost } = deps;
  return createRcSessionCommands({
    supervisedOf: async (sessionId) => {
      const found = await supervisedSessionOfBridge(realFarmFs, deps.paths, sessionId, realRunningAmong);
      if (found?.control === undefined) {
        return undefined;
      }
      const plugin = sessionControlPluginPaths(found.control.directory);
      const conversationId = found.state?.conversationId ?? found.session.sessionId;
      return {
        conversationId,
        transcriptPath: found.state?.transcriptPath,
        version: sessionControlVersion(plugin),
        compact: async (signal, instructions) => await compactInSession(plugin, conversationId, signal, instructions),
        runGoal: async (args, signal) => await runGoalInSession(plugin, conversationId, args, signal),
      };
    },
    readFile: (file) => realFarmFs.readFileUtf8(file),
    isObserved: deps.isTracked,
    selfHost:
      selfHost === undefined
        ? undefined
        : {
            personWrite: selfHost.personWrite,
            unavailable: selfHost.unavailable,
            fanout: selfHost.fanout,
            versionOf: (sessionId) => {
              selfHost.versions.sweep(deps.isTracked);
              return selfHost.versions.versionOf(sessionId);
            },
            setTimer: (action, ms) => {
              const timer = setTimeout(action, ms);
              return () => {
                clearTimeout(timer);
              };
            },
            defaultWaitMs: COMPACT_TIMEOUT_MS,
          },
  });
}
