import { realFarmFs, realRunningAmong } from "../realPorts";
import type { LayoutPaths } from "../paths";
import { COMPACT_TIMEOUT_MS } from "../supervise/compactTimeout";
import { launchedSessionOfBridge } from "../supervise/launchControl";
import { supervisedSessionOfBridge } from "../supervise/registry";
import { createTranscriptFollower, realTranscriptReadPort } from "../supervise/transcriptFollower";
import { compactInSession, runGoalInSession, sessionControlVersion, submitTurnInSession } from "../supervise/sessionControl";
import { sessionControlPluginPaths } from "../supervise/sessionControlPlugin";
import { createSelfHostedSessionVersions, type RcClaudeCodeVersions, type RcPersonWriteDeps } from "./rcSelfHostCommands";
import { createRcSessionCommands, type RcSessionCommands } from "./rcSessionCommands";
import type { RcEventFanout } from "./rcStream";

/** What the door hands its goal, compaction and turn verbs: its state paths, its tracker's view of the sessions, and, only when it serves Remote Control itself, the self-hosted route's write and stream. */
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
        /** The version the launch that created a session recorded for its binary, from the door's own surface. */
        readonly launchVersionOf: (sessionId: string) => string | undefined;
        /** The door's log, where a recorded version the worker's report contradicts is noted. */
        readonly log: (line: string) => void;
      }
    | undefined;
}

/**
 * The door's goal, compaction and turn verbs over the real machine (`rcSessionCommands.ts` holds the routing): a supervised session is reached through its supervisor's in-process control plugin, found by the bridge-session row in its own transcript, and a session the launcher started with no supervisor through the control plugin its launch recorded, found by the same row in the transcript the plugin recorded; a session on the door's own self-hosted surface gets the command written there as a person's app, over a dial that reaches that surface and nothing else (it refuses rather than fall back to the real API host when the surface is not bound, and the route refuses first with the reason); anything else is refused with the reason.
 */
export function createDoorRcSessionCommands(deps: DoorRcSessionCommandsDeps): RcSessionCommands {
  const { selfHost } = deps;
  // Every plugin-reached transcript's facts, kept across verbs and read asynchronously, so a call reads only what each transcript gained since the last one.
  const follower = createTranscriptFollower(realTranscriptReadPort);
  return createRcSessionCommands({
    supervisedOf: async (sessionId) => {
      const lookup = await supervisedSessionOfBridge(realFarmFs, deps.paths, sessionId, realRunningAmong, follower);
      if (lookup.kind === "ambiguous") {
        return { refused: `more than one live supervised launch records Remote Control session ${sessionId} as its current bridge session (${lookup.sessionIds.join(", ")}), as a resumed or forked conversation can, so the door does not guess which one to act on` };
      }
      const found = lookup.kind === "found" ? lookup.session : undefined;
      if (found?.control === undefined) {
        return undefined;
      }
      const plugin = sessionControlPluginPaths(found.control.directory);
      const conversationId = found.state?.conversationId ?? found.session.sessionId;
      return {
        conversationId,
        transcriptPath: found.state?.transcriptPath,
        version: sessionControlVersion(plugin),
        compact: async (signal, instructions, waitMs) => await compactInSession(plugin, conversationId, { signal, expiresInMs: waitMs }, instructions),
        runGoal: async (args, signal, waitMs) => await runGoalInSession(plugin, conversationId, args, { signal, expiresInMs: waitMs }),
        submitTurn: async (text, signal, waitMs) => await submitTurnInSession(plugin, conversationId, text, { signal, expiresInMs: waitMs }),
      };
    },
    launchedOf: async (sessionId) => {
      const lookup = await launchedSessionOfBridge(realFarmFs, deps.paths, sessionId, realRunningAmong, follower);
      if (lookup.kind === "ambiguous") {
        return { refused: `more than one live launch's control plugin records Remote Control session ${sessionId} as its current bridge session (conversations ${lookup.conversationIds.join(", ")}), as a resumed or forked conversation can, so the door does not guess which one to act on` };
      }
      if (lookup.kind === "none") {
        return undefined;
      }
      const plugin = sessionControlPluginPaths(lookup.session.control.directory);
      const { conversationId, transcriptPath } = lookup.session.conversation;
      return {
        conversationId,
        transcriptPath,
        version: sessionControlVersion(plugin),
        compact: async (signal, instructions, waitMs) => await compactInSession(plugin, conversationId, { signal, expiresInMs: waitMs }, instructions),
        runGoal: async (args, signal, waitMs) => await runGoalInSession(plugin, conversationId, args, { signal, expiresInMs: waitMs }),
        submitTurn: async (text, signal, waitMs) => await submitTurnInSession(plugin, conversationId, text, { signal, expiresInMs: waitMs }),
      };
    },
    goalOf: async (file) => (await follower.factsOf(file))?.goal,
    pluginTurnsOf: async (file) => (await follower.factsOf(file))?.pluginTurns,
    isObserved: deps.isTracked,
    selfHost:
      selfHost === undefined
        ? undefined
        : {
            personWrite: selfHost.personWrite,
            unavailable: selfHost.unavailable,
            fanout: selfHost.fanout,
            versionOf: createSelfHostedSessionVersions({
              reported: (sessionId) => {
                selfHost.versions.sweep(deps.isTracked);
                return selfHost.versions.versionOf(sessionId);
              },
              recorded: selfHost.launchVersionOf,
              warn: selfHost.log,
            }),
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
