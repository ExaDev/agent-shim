import { describe, expect, it } from "vitest";

import type { RcStreamEvent } from "./rcSchemas";
import type { RcDialTarget } from "./connectEffects";
import { CONTROL_BODY_CAP_BYTES } from "./rcControl";
import { createRcClaudeCodeVersions, selfHostSurfaceUnboundReason, parseRcGoalOutput, rcSelfHostEventDial, runSelfHostedSlashCommand, type RcSelfHostCommandDeps } from "./rcSelfHostCommands";
import { createRcEventFanout } from "./rcStream";
import type { RcEventDial, RcEventWriteResult } from "./rcWrites";

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

/** The credential the client half replays, as the tracker would hold it for an observed session. */
const OBSERVED = { authorization: "Bearer sk-ant-oat", anthropicVersion: "2023-06-01", anthropicClientPlatform: "claude_code_cli" };

/** The loopback target of the door's own surface in these worlds. */
const SURFACE = { host: "127.0.0.1", port: 47_592, servername: "api.anthropic.com" };

/** A world over a real fan-out whose self-hosted dial records each write (target and headers) and echoes the command, then publishes the scripted answers once the write is numbered. */
function makeWorld(answer: readonly RcStreamEvent[] = [], injectResult?: RcEventWriteResult, surface: Readonly<{ target: RcDialTarget | undefined }> = { target: SURFACE }) {
  const target = surface.target;
  const fanout = createRcEventFanout();
  const written: { readonly text: string; readonly platform: string | undefined; readonly host: string }[] = [];
  const timers: (() => void)[] = [];
  const fakeDial = (dialled: RcDialTarget): RcEventDial => ({
    writeEvents: async (_sessionId, headers, body) => {
      const parsed: unknown = JSON.parse(body);
      const text = typeof parsed === "object" && parsed !== null && "events" in parsed && Array.isArray(parsed.events) ? String((parsed.events[0] as { payload: { message: { content: unknown } } }).payload.message.content) : "";
      written.push({ text, platform: headers["anthropic-client-platform"], host: dialled.host });
      if (injectResult !== undefined) {
        return await Promise.resolve({ status: 500, body: injectResult.ok ? "" : injectResult.message });
      }
      fanout.publish(streamEvent(COMMAND_SEQUENCE, { type: "user", message: { role: "user", content: text } }, "client"));
      queueMicrotask(() => {
        for (const event of answer) {
          fanout.publish(event);
        }
      });
      return await Promise.resolve({ status: 200, body: JSON.stringify({ results: [{ sequence_num: String(COMMAND_SEQUENCE) }] }) });
    },
    writeTeleportEvents: async () => await Promise.reject(new Error("unused")),
    readWorker: async () => await Promise.reject(new Error("unused")),
  });
  const deps: RcSelfHostCommandDeps = {
    fanout,
    versionOf: () => "2.1.319",
    defaultWaitMs: SHORT_WAIT_MS,
    personWrite: { credentialOf: () => OBSERVED, noteSequenceNums: () => undefined, newUuid: () => "00000000-0000-4000-8000-000000000001", dial: rcSelfHostEventDial(() => target, fakeDial) },
    unavailable: () => undefined,
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
    expect(world.written).toEqual([{ text: "/goal tests pass", platform: "web_claude_ai", host: SURFACE.host }]);
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
    const world = makeWorld([], { ok: false, message: "the surface refused it" });
    expect(await runSelfHostedSlashCommand(world.deps, SESSION, { kind: "goal-get" }, undefined, NEVER)).toEqual({ ok: false, message: "the API answered HTTP 500 to the injected event: the surface refused it" });
  });

  it("never writes as a person's app while the door's own surface is unbound, or to an address that is not this machine", async () => {
    const unbound = makeWorld([], undefined, { target: undefined });
    const refused = await runSelfHostedSlashCommand(unbound.deps, SESSION, { kind: "goal-clear" }, undefined, NEVER);
    expect(refused.ok ? "" : refused.message).toContain("self-hosted surface is not bound");
    // A name, even one that resolves to this machine, is refused: the guard takes literal loopback addresses only.
    const named = makeWorld([], undefined, { target: { host: "localhost", port: 47_592 } });
    const refusedNamed = await runSelfHostedSlashCommand(named.deps, SESSION, { kind: "goal-clear" }, undefined, NEVER);
    expect(refusedNamed.ok ? "" : refusedNamed.message).toContain("which is not this machine");
    expect(named.written).toEqual([]);
    const elsewhere = makeWorld([], undefined, { target: { host: "api.anthropic.com", port: 443 } });
    const refusedElsewhere = await runSelfHostedSlashCommand(elsewhere.deps, SESSION, { kind: "goal-clear" }, undefined, NEVER);
    expect(refusedElsewhere.ok ? "" : refusedElsewhere.message).toContain("which is not this machine");
    expect([...unbound.written, ...elsewhere.written]).toEqual([]);
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

  it("names why the door's own surface is unbound: unset, not a port, or set but not bound", () => {
    expect(selfHostSurfaceUnboundReason(undefined)).toContain("is not set");
    expect(selfHostSurfaceUnboundReason("abc")).toContain('is "abc", which is not a port');
    expect(selfHostSurfaceUnboundReason("47592")).toContain("on port 47592 is not bound");
  });

  it("refuses a command whose event write would be larger than the door's own surface reads, unsent", async () => {
    const world = makeWorld();
    const result = await runSelfHostedSlashCommand(world.deps, SESSION, { kind: "compact", instructions: "x".repeat(CONTROL_BODY_CAP_BYTES) }, undefined, NEVER);
    expect(result.ok ? "" : result.message).toContain("over the");
    expect(world.written).toEqual([]);
  });
});
