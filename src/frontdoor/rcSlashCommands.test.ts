import { describe, expect, it } from "vitest";

import type { RcStreamEvent } from "./rcSchemas";
import { RC_PERSON_CLIENT_PLATFORM, RC_SLASH_COMMAND_VERIFIED_VERSIONS, clearRcSessionGoal, compactRcSession, createRcClaudeCodeVersions, getRcSessionGoal, parseRcGoalReport, setRcSessionGoal, type RcSlashCommandDeps } from "./rcSlashCommands";
import { createRcEventFanout, type RcEventFanout } from "./rcStream";
import type { RcEventWriteResult } from "./rcWrites";

const SESSION = "cse_00000000-0000-4000-8000-000000000000";

/** A version the route was verified on, read from the module so the tests follow the list rather than restate it. */
const VERIFIED_VERSION = RC_SLASH_COMMAND_VERIFIED_VERSIONS[0] ?? "";

/** The sequence number the service assigns the command's own write in these worlds; answers are numbered after it. */
const COMMAND_SEQUENCE = 40;

/** The wait bound the timeout case arms, a named value so the refusal can be checked to name it. */
const SHORT_WAIT_MS = 5;

/** One stream event: the session, the source and the payload, numbered as the service would number it. */
function streamEvent(sequenceNum: number, payload: Record<string, unknown>, source = "worker"): RcStreamEvent {
  return { session: SESSION, envelope: { event_type: typeof payload.type === "string" ? payload.type : "event", sequence_num: sequenceNum, source, payload } };
}

/** The worker's answer to one local command, in the shape a live 2.1.319 session emits it: a synthetic assistant message naming the command it answers. */
function localCommandAnswer(sequenceNum: number, command: string, args: string, text: string): RcStreamEvent {
  return streamEvent(sequenceNum, { type: "assistant", message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text }] }, local_command_source: `<local-command-stdout>${text}</local-command-stdout>`, local_command_run: { command, args } });
}

/** The compaction events a live 2.1.319 session emits, by outcome. */
function compactStatus(sequenceNum: number, result: "success" | "failed", error?: string): RcStreamEvent {
  return streamEvent(sequenceNum, { type: "system", subtype: "status", status: null, compact_result: result, ...(error === undefined ? {} : { compact_error: error }) });
}

function compactBoundary(sequenceNum: number): RcStreamEvent {
  return streamEvent(sequenceNum, { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: 1200, post_tokens: 300, duration_ms: 90 } });
}

/** One world: a real fan-out, an inject that records what it was asked and publishes the worker's scripted answer once the write is numbered, and timers the test fires by hand. */
function makeWorld(options: Readonly<{ version?: string; answer?: readonly RcStreamEvent[]; injectResult?: RcEventWriteResult }> = {}) {
  const fanout: RcEventFanout = createRcEventFanout();
  const written: { readonly text: string; readonly platform: string }[] = [];
  const timers: (() => void)[] = [];
  const deps: RcSlashCommandDeps = {
    fanout,
    claudeCodeVersionOf: () => ("version" in options ? options.version : VERIFIED_VERSION),
    inject: async (_sessionId, text, platform) => {
      written.push({ text, platform });
      if (options.injectResult !== undefined) {
        return options.injectResult;
      }
      // The command itself is echoed on the stream before the service answers the write, which is why the engine ignores everything numbered at or before it.
      fanout.publish(streamEvent(COMMAND_SEQUENCE, { type: "user", message: { role: "user", content: text } }, "client"));
      queueMicrotask(() => {
        for (const event of options.answer ?? []) {
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
  return { deps, written, timers, fanout };
}

describe("goal and compaction control over Remote Control", () => {
  it("writes each command as a person's message, the only author whose slash command the worker runs", async () => {
    const world = makeWorld({ answer: [localCommandAnswer(COMMAND_SEQUENCE + 2, "goal", "clear", "No goal set")] });
    expect(await clearRcSessionGoal(world.deps, SESSION)).toEqual({ ok: true, sequenceNums: [COMMAND_SEQUENCE], report: { cleared: null } });
    expect(world.written).toEqual([{ text: "/goal clear", platform: RC_PERSON_CLIENT_PLATFORM }]);
  });

  it("refuses a session on an unverified Claude Code version, naming it, and one that has reported none, without writing anything", async () => {
    const unverified = makeWorld({ version: "2.0.1" });
    const refused = await getRcSessionGoal(unverified.deps, SESSION);
    expect(refused.ok).toBe(false);
    expect(refused.ok ? "" : refused.message).toContain("runs Claude Code 2.0.1");
    expect(refused.ok ? "" : refused.message).toContain(VERIFIED_VERSION);
    const unknown = makeWorld({ version: undefined });
    const unreported = await compactRcSession(unknown.deps, SESSION);
    expect(unreported.ok ? "" : unreported.message).toContain("has not reported its Claude Code version");
    expect([...unverified.written, ...unknown.written]).toEqual([]);
  });

  it("reads the active goal, ignoring the command's own echo, client events and another command's answer", async () => {
    // The decoys come first and the goal's own answer is numbered straight after them.
    const decoys = [
      localCommandAnswer(COMMAND_SEQUENCE - 1, "goal", "", "No goal set. Usage: `/goal <condition>`"),
      streamEvent(COMMAND_SEQUENCE + 1, { type: "mark_read" }, "client"),
      localCommandAnswer(COMMAND_SEQUENCE + 2, "model", "", "Current model: `Opus 5.5 (default)`"),
    ];
    const world = makeWorld({ answer: [...decoys, localCommandAnswer(COMMAND_SEQUENCE + decoys.length, "goal", "", "Goal active: the build is green (not yet evaluated)")] });
    expect(await getRcSessionGoal(world.deps, SESSION)).toEqual({ ok: true, sequenceNums: [COMMAND_SEQUENCE], report: { goal: { condition: "the build is green", iterations: 0 } } });
    expect(world.written).toEqual([{ text: "/goal", platform: RC_PERSON_CLIENT_PLATFORM }]);
  });

  it("parses every goal line the verified versions answer with", () => {
    expect(parseRcGoalReport("No goal set. Usage: `/goal <condition>`")).toEqual({ goal: null });
    expect(parseRcGoalReport("Goal active: tests pass (1 turn)")).toEqual({ goal: { condition: "tests pass", iterations: 1 } });
    expect(parseRcGoalReport("Goal active: the file (done.txt) exists (3 turns)\nLast check: the file is still missing")).toEqual({ goal: { condition: "the file (done.txt) exists", iterations: 3, lastCheck: "the file is still missing" } });
    expect(parseRcGoalReport("something else entirely")).toBeUndefined();
  });

  it("sets a goal and returns the condition the worker confirmed", async () => {
    const world = makeWorld({ answer: [localCommandAnswer(COMMAND_SEQUENCE + 2, "goal", "the build is green", "Goal set: the build is green")] });
    expect(await setRcSessionGoal(world.deps, SESSION, "  the build is green ")).toEqual({ ok: true, sequenceNums: [COMMAND_SEQUENCE], report: { condition: "the build is green" } });
    expect(world.written.map((entry) => entry.text)).toEqual(["/goal the build is green"]);
  });

  it("returns the worker's own refusal of a goal as the failure", async () => {
    const world = makeWorld({ answer: [localCommandAnswer(COMMAND_SEQUENCE + 2, "goal", "x", "Goal condition is limited to 4000 characters (got 4001)")] });
    const result = await setRcSessionGoal(world.deps, SESSION, "x");
    expect(result.ok ? "" : result.message).toBe("the worker did not set the goal: Goal condition is limited to 4000 characters (got 4001)");
  });

  it("refuses an empty condition and one /goal reads as a clear, before writing anything", async () => {
    const world = makeWorld();
    const empty = await setRcSessionGoal(world.deps, SESSION, "   ");
    const clearWord = await setRcSessionGoal(world.deps, SESSION, "Stop");
    expect(empty.ok ? "" : empty.message).toContain("non-empty condition");
    expect(clearWord.ok ? "" : clearWord.message).toContain("cannot be set as a goal condition");
    expect(world.written).toEqual([]);
  });

  it("clears a goal and names the condition it cleared", async () => {
    const world = makeWorld({ answer: [localCommandAnswer(COMMAND_SEQUENCE + 2, "goal", "clear", "Goal cleared: the build is green")] });
    expect(await clearRcSessionGoal(world.deps, SESSION)).toEqual({ ok: true, sequenceNums: [COMMAND_SEQUENCE], report: { cleared: "the build is green" } });
  });

  it("finishes a compaction on its boundary, not on the success status before it", async () => {
    const statuses = [streamEvent(COMMAND_SEQUENCE + 1, { type: "system", subtype: "status", status: "compacting" }), compactStatus(COMMAND_SEQUENCE + 2, "success")];
    const world = makeWorld({ answer: [...statuses, compactBoundary(COMMAND_SEQUENCE + statuses.length + 1)] });
    expect(await compactRcSession(world.deps, SESSION, { instructions: " keep the decisions " })).toEqual({ ok: true, sequenceNums: [COMMAND_SEQUENCE], report: { trigger: "manual", preTokens: 1200, postTokens: 300 } });
    expect(world.written.map((entry) => entry.text)).toEqual(["/compact keep the decisions"]);
  });

  it("returns the worker's reason when a compaction fails", async () => {
    const world = makeWorld({ answer: [compactStatus(COMMAND_SEQUENCE + 2, "failed", "Not enough messages to compact.")] });
    const result = await compactRcSession(world.deps, SESSION);
    expect(result.ok ? "" : result.message).toBe(`the worker did not compact session ${SESSION}: Not enough messages to compact.`);
    expect(world.written.map((entry) => entry.text)).toEqual(["/compact"]);
  });

  it("fails once the wait bound passes with no outcome, naming the delivered write", async () => {
    const world = makeWorld();
    const pending = compactRcSession(world.deps, SESSION, { waitMs: SHORT_WAIT_MS });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(world.timers).toHaveLength(1);
    world.timers[0]?.();
    const result = await pending;
    expect(result.ok ? "" : result.message).toContain(`sequence_num ${String(COMMAND_SEQUENCE)}`);
    expect(result.ok ? "" : result.message).toContain(`within ${String(SHORT_WAIT_MS)} ms`);
  });

  it("returns the write's own failure when the command could not be delivered", async () => {
    const world = makeWorld({ injectResult: { ok: false, message: "the API answered HTTP 500 to the injected event" } });
    expect(await getRcSessionGoal(world.deps, SESSION)).toEqual({ ok: false, message: "the API answered HTTP 500 to the injected event" });
  });

  it("files the Claude Code version each session's system/init reports, the latest winning", () => {
    const fanout = createRcEventFanout();
    const versions = createRcClaudeCodeVersions(fanout);
    expect(versions.versionOf(SESSION)).toBeUndefined();
    fanout.publish(streamEvent(COMMAND_SEQUENCE, { type: "system", subtype: "init", claude_code_version: "2.1.318" }));
    fanout.publish(streamEvent(COMMAND_SEQUENCE + 1, { type: "system", subtype: "status", claude_code_version: "9.9.9" }));
    fanout.publish(streamEvent(COMMAND_SEQUENCE + 2, { type: "system", subtype: "init", claude_code_version: VERIFIED_VERSION }));
    expect(versions.versionOf(SESSION)).toBe(VERIFIED_VERSION);
  });
});
