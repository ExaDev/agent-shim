import { describe, expect, it } from "vitest";

import type { RcStreamEvent } from "./rcSchemas";
import { RC_PERSON_CLIENT_PLATFORM, createRcClaudeCodeVersions, parseRcGoalOutput, runSelfHostedSlashCommand, type RcSelfHostCommandDeps } from "./rcSelfHostCommands";
import { createRcEventFanout } from "./rcStream";
import type { RcEventWriteResult } from "./rcWrites";

const SESSION = "cse_00000000-0000-4000-8000-000000000000";

/** The sequence number the surface assigns the command's own write in these worlds; answers are numbered after it. */
const COMMAND_SEQUENCE = 40;

/** The wait bound the timeout case arms, named so the refusal can be checked to name it. */
const SHORT_WAIT_MS = 5;

function streamEvent(sequenceNum: number, payload: Record<string, unknown>, source = "worker"): RcStreamEvent {
  return { session: SESSION, envelope: { event_type: typeof payload.type === "string" ? payload.type : "event", sequence_num: sequenceNum, source, payload } };
}

/** The worker's answer to one local command, in the shape a live 2.1.319 session emits it. */
function localAnswer(sequenceNum: number, command: string, args: string, text: string, outcome?: string): RcStreamEvent {
  return streamEvent(sequenceNum, { type: "assistant", message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text }] }, local_command_run: { command, args }, ...(outcome === undefined ? {} : { local_command_outcome: { kind: outcome } }) });
}

function boundary(sequenceNum: number, trigger: string): RcStreamEvent {
  return streamEvent(sequenceNum, { type: "system", subtype: "compact_boundary", compact_metadata: { trigger, pre_tokens: 1200, post_tokens: 300 } });
}

/** A world over a real fan-out whose inject echoes the command, then publishes the scripted answers once the write is numbered. */
function makeWorld(answer: readonly RcStreamEvent[] = [], injectResult?: RcEventWriteResult) {
  const fanout = createRcEventFanout();
  const written: { readonly text: string; readonly platform: string }[] = [];
  const timers: (() => void)[] = [];
  const deps: RcSelfHostCommandDeps = {
    fanout,
    versionOf: () => "2.1.319",
    defaultWaitMs: SHORT_WAIT_MS,
    inject: async (_sessionId, text, platform) => {
      written.push({ text, platform });
      if (injectResult !== undefined) {
        return injectResult;
      }
      fanout.publish(streamEvent(COMMAND_SEQUENCE, { type: "user", message: { role: "user", content: text } }, "client"));
      queueMicrotask(() => {
        for (const event of answer) {
          fanout.publish(event);
        }
      });
      return await Promise.resolve({ ok: true, sequenceNums: [COMMAND_SEQUENCE] });
    },
    setTimer: (action) => {
      timers.push(action);
      return () => {
        timers.splice(timers.indexOf(action), 1);
      };
    },
  };
  return { deps, written, timers };
}

const NEVER = new AbortController().signal;

describe("slash commands on the door's own self-hosted surface", () => {
  it("writes the command as a person's app and matches its answer by command and exact arguments, ignoring echoes, client events and other runs", async () => {
    // The decoys come first, and the answer is numbered straight after them.
    const decoys = [localAnswer(COMMAND_SEQUENCE - 1, "goal", "", "No goal set"), streamEvent(COMMAND_SEQUENCE + 1, { type: "mark_read" }, "client"), localAnswer(COMMAND_SEQUENCE + 2, "goal", "", "Goal active: someone else's read (not yet evaluated)")];
    const world = makeWorld([...decoys, localAnswer(COMMAND_SEQUENCE + decoys.length, "goal", "tests pass", "Goal set: tests pass")]);
    expect(await runSelfHostedSlashCommand(world.deps, SESSION, { kind: "goal-set", condition: "tests pass" }, undefined, NEVER)).toEqual({ ok: true, report: { condition: "tests pass" } });
    expect(world.written).toEqual([{ text: "/goal tests pass", platform: RC_PERSON_CLIENT_PLATFORM }]);
  });

  it("parses every goal line the verified version answers with, a multi-line condition included", () => {
    expect(parseRcGoalOutput("No goal set. Usage: `/goal <condition>`")).toEqual({ goal: null });
    expect(parseRcGoalOutput("Goal active: tests pass (1 turn)")).toEqual({ goal: { condition: "tests pass", iterations: 1 } });
    expect(parseRcGoalOutput("Goal active: the file (done.txt)\nexists (3 turns)\nLast check: still missing")).toEqual({ goal: { condition: "the file (done.txt)\nexists", iterations: 3, lastCheck: "still missing" } });
    expect(parseRcGoalOutput("something else entirely")).toBeUndefined();
  });

  it("finishes a compaction on a manual boundary only, and returns the worker's reason when it does not compact", async () => {
    const compacted = makeWorld([boundary(COMMAND_SEQUENCE + 1, "auto"), boundary(COMMAND_SEQUENCE + 2, "manual")]);
    expect(await runSelfHostedSlashCommand(compacted.deps, SESSION, { kind: "compact", instructions: "keep it" }, undefined, NEVER)).toEqual({ ok: true, report: { trigger: "manual", preTokens: 1200, postTokens: 300 } });
    expect(compacted.written.map((entry) => entry.text)).toEqual(["/compact keep it"]);
    const refused = makeWorld([localAnswer(COMMAND_SEQUENCE + 1, "compact", "", "Not enough messages to compact.")]);
    expect(await runSelfHostedSlashCommand(refused.deps, SESSION, { kind: "compact", instructions: undefined }, undefined, NEVER)).toEqual({ ok: false, message: "the worker did not compact the session: Not enough messages to compact." });
  });

  it("fails at once when the worker passes the command to its model as a peer's, or reports the command failed", async () => {
    const peer = makeWorld([streamEvent(COMMAND_SEQUENCE + 1, { type: "user", origin: { kind: "peer", from: "unknown" }, message: { role: "user", content: "Another Claude session sent a message:\n/goal clear" } })]);
    const result = await runSelfHostedSlashCommand(peer.deps, SESSION, { kind: "goal-clear" }, undefined, NEVER);
    expect(result.ok ? "" : result.message).toContain("as a peer's message");
    const failed = makeWorld([localAnswer(COMMAND_SEQUENCE + 1, "goal", "clear", "boom", "failed")]);
    const failure = await runSelfHostedSlashCommand(failed.deps, SESSION, { kind: "goal-clear" }, undefined, NEVER);
    expect(failure.ok ? "" : failure.message).toBe("the worker reported /goal failed: boom");
  });

  it("fails once the wait passes, naming the delivered write, and when the request aborts", async () => {
    const world = makeWorld();
    const pending = runSelfHostedSlashCommand(world.deps, SESSION, { kind: "goal-get" }, undefined, NEVER);
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    world.timers[0]?.();
    const timedOut = await pending;
    expect(timedOut.ok ? "" : timedOut.message).toContain(`sequence_num ${String(COMMAND_SEQUENCE)}`);
    expect(timedOut.ok ? "" : timedOut.message).toContain(`within ${String(SHORT_WAIT_MS)} ms`);
    const controller = new AbortController();
    const aborting = runSelfHostedSlashCommand(makeWorld().deps, SESSION, { kind: "goal-get" }, undefined, controller.signal);
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    controller.abort();
    const aborted = await aborting;
    expect(aborted.ok ? "" : aborted.message).toContain("aborted before the worker answered");
  });

  it("returns the write's own failure when the command could not be delivered", async () => {
    const world = makeWorld([], { ok: false, message: "the surface answered HTTP 500" });
    expect(await runSelfHostedSlashCommand(world.deps, SESSION, { kind: "goal-get" }, undefined, NEVER)).toEqual({ ok: false, message: "the surface answered HTTP 500" });
  });

  it("files the version only from a worker's own system/init, the latest winning, and forgets a session that is no longer tracked", () => {
    const fanout = createRcEventFanout();
    const versions = createRcClaudeCodeVersions(fanout);
    fanout.publish(streamEvent(1, { type: "system", subtype: "init", claude_code_version: "2.1.318" }));
    fanout.publish(streamEvent(2, { type: "system", subtype: "init", claude_code_version: "9.9.9" }, "client"));
    expect(versions.versionOf(SESSION)).toBe("2.1.318");
    fanout.publish(streamEvent(COMMAND_SEQUENCE, { type: "system", subtype: "init", claude_code_version: "2.1.319" }));
    expect(versions.versionOf(SESSION)).toBe("2.1.319");
    versions.sweep(() => false);
    expect(versions.versionOf(SESSION)).toBeUndefined();
  });
});
