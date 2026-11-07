import { describe, expect, it } from "vitest";

import type { CompactionResult } from "../supervise/realCompact";
import { activeGoalOfTranscript } from "../supervise/sessionGoal";
import type { RcSelfHostCommandDeps } from "./rcSelfHostCommands";
import { rcSelfHostEventDial } from "./rcSelfHostDial";
import { RC_GOAL_CONDITION_MAX_CHARS, RC_SESSION_COMMAND_VERIFIED_VERSIONS, createRcSessionCommands, type RcSessionCommandDeps, type RcSupervisedTarget } from "./rcSessionCommands";
import { createRcEventFanout } from "./rcStream";

const SESSION = "cse_00000000-0000-4000-8000-000000000000";
const TRANSCRIPT = "/transcripts/conversation.jsonl";

/** A wait short enough that the bounded case ends at once, named so its refusal can be checked to name it. */
const SHORT_WAIT_MS = 5;

/** The supervised sessions a world whose session no supervisor owns holds: none. */
const NO_SUPERVISORS = new Map<string, RcSupervisedTarget>();

/** Finds no supervisor. */
async function noSupervisor(sessionId: string): Promise<RcSupervisedTarget | { readonly refused: string } | undefined> {
  return await Promise.resolve(NO_SUPERVISORS.get(sessionId));
}

/** The files a world whose route never reaches a transcript holds: none. */
const NO_FILES = new Map<string, null>();

/** Reads no transcript. */
async function noFile(file: string): Promise<null | undefined> {
  return await Promise.resolve(NO_FILES.get(file));
}

/** A version both routes were verified on, read from the module so the tests follow the list rather than restate it. */
const VERIFIED_VERSION = RC_SESSION_COMMAND_VERIFIED_VERSIONS[0] ?? "";

/** One `goal_status` row in the shape the 2.1.319 CLI writes. */
function goalRow(attachment: Record<string, unknown>): string {
  return JSON.stringify({ type: "attachment", attachment: { type: "goal_status", ...attachment } });
}

/** A supervised session whose plugin edits an in-memory transcript the way the real CLI does: a set writes a sentinel row, a clear a met sentinel. */
function supervisedWorld(options: Readonly<{ version?: string; transcript?: string[]; compact?: CompactionResult }> = {}) {
  const transcript = options.transcript ?? [];
  const ran: string[] = [];
  const instructed: (string | undefined)[] = [];
  const target: RcSupervisedTarget = {
    conversationId: "conversation",
    transcriptPath: TRANSCRIPT,
    version: "version" in options ? options.version : VERIFIED_VERSION,
    compact: async (_signal, instructions) => {
      instructed.push(instructions);
      return await Promise.resolve(options.compact ?? { kind: "compacted", beforeTokens: 900, afterTokens: 120 });
    },
    runGoal: async (args) => {
      ran.push(args);
      const active = transcript.filter((line) => line.includes("sentinel")).at(-1);
      if (args === "clear") {
        const condition = active === undefined ? "" : String((JSON.parse(active) as { attachment: { condition: unknown } }).attachment.condition);
        transcript.push(goalRow({ met: true, sentinel: true, condition }));
      } else {
        transcript.push(goalRow({ met: false, sentinel: true, condition: args }));
      }
      await Promise.resolve();
    },
  };
  const deps: RcSessionCommandDeps = {
    supervisedOf: async () => await Promise.resolve(target),
    goalOf: async (file) => await Promise.resolve(file === TRANSCRIPT ? activeGoalOfTranscript(transcript.join("\n")) : undefined),
    selfHost: undefined,
    isObserved: () => true,
  };
  return { deps, ran, instructed, transcript };
}

/** A self-hosted session with no supervisor, whose self-hosted dial records each write and whose surface answers 500; `unavailable` is the surface's refusal, when it gives one. */
function selfHostedWorld(version: string | undefined, unavailable?: string, accepts = false, owned = true) {
  const written: string[] = [];
  const dial = rcSelfHostEventDial({ resolve: () => ({ host: "127.0.0.1", port: 47_592 }), unboundReason: () => "the surface is unbound" }, () => ({
    writeEvents: async (_sessionId, _headers, body) => {
      written.push(body);
      // An accepting surface numbers the write and its worker never answers, so only the verb's own deadline ends the wait.
      return await Promise.resolve(accepts ? { status: 200, body: JSON.stringify({ results: [{ sequence_num: String(written.length) }] }) } : { status: 500, body: "the self-hosted surface refused the write" });
    },
    writeTeleportEvents: async () => await Promise.reject(new Error("unused")),
  }));
  const selfHost: RcSelfHostCommandDeps = {
    personWrite: { credentialOf: () => ({ authorization: "Bearer sk-ant-oat", anthropicVersion: undefined, anthropicClientPlatform: "claude_code_cli" }), noteSequenceNums: () => undefined, newUuid: () => "00000000-0000-4000-8000-000000000001", dial },
    owns: () => owned,
    unavailable: () => unavailable,
    fanout: createRcEventFanout(),
    versionOf: () => version,
    setTimer: () => () => undefined,
    defaultWaitMs: 1,
  };
  const deps: RcSessionCommandDeps = { supervisedOf: noSupervisor, goalOf: noFile, selfHost, isObserved: () => true };
  return { deps, written };
}

describe("goal and compaction control over Remote Control, by route", () => {
  it("reads a supervised session's goal from its transcript without running anything in it", async () => {
    const world = supervisedWorld({ transcript: [goalRow({ met: false, sentinel: true, condition: "tests pass" }), goalRow({ met: false, condition: "tests pass", reason: "two fail" })] });
    const commands = createRcSessionCommands(world.deps);
    expect(await commands.goalGet(SESSION)).toEqual({ ok: true, report: { route: "supervised", goal: { condition: "tests pass", iterations: 1, lastCheck: "two fail" } } });
    expect(world.ran).toEqual([]);
  });

  it("sets a supervised session's goal through its plugin, naming the goal it replaced and confirming it from the transcript", async () => {
    const world = supervisedWorld({ transcript: [goalRow({ met: false, sentinel: true, condition: "docs are updated" })] });
    const commands = createRcSessionCommands(world.deps);
    expect(await commands.goalSet(SESSION, "  tests pass ")).toEqual({ ok: true, report: { route: "supervised", condition: "tests pass", superseded: "docs are updated" } });
    expect(world.ran).toEqual(["tests pass"]);
  });

  it("clears a supervised session's goal, and clears nothing when it has none", async () => {
    const world = supervisedWorld({ transcript: [goalRow({ met: false, sentinel: true, condition: "tests pass" })] });
    const commands = createRcSessionCommands(world.deps);
    expect(await commands.goalClear(SESSION)).toEqual({ ok: true, report: { route: "supervised", cleared: "tests pass" } });
    expect(await commands.goalClear(SESSION)).toEqual({ ok: true, report: { route: "supervised", cleared: null } });
    expect(world.ran).toEqual(["clear"]);
  });

  it("compacts a supervised session through its plugin, with instructions when given, and reports a refusal in the session's words", async () => {
    const world = supervisedWorld();
    const commands = createRcSessionCommands(world.deps);
    expect(await commands.compact(SESSION, { instructions: " keep the plan " })).toEqual({ ok: true, report: { route: "supervised", trigger: "plugin", preTokens: 900, postTokens: 120 } });
    expect(await commands.compact(SESSION, { instructions: "  " })).toMatchObject({ ok: true });
    expect(world.instructed).toEqual(["keep the plan", undefined]);
    const refused = await createRcSessionCommands(supervisedWorld({ compact: { kind: "unchanged", reason: "Not enough messages to compact." } }).deps).compact(SESSION);
    expect(refused).toEqual({ ok: false, message: `session ${SESSION} was not compacted: Not enough messages to compact.` });
  });

  it("refuses a supervised session on an unverified version or whose plugin has not loaded, naming the version, before acting", async () => {
    const unverified = supervisedWorld({ version: "2.0.1" });
    const result = await createRcSessionCommands(unverified.deps).goalSet(SESSION, "tests pass");
    expect(result.ok ? "" : result.message).toContain("runs Claude Code 2.0.1");
    expect(result.ok ? "" : result.message).toContain(VERIFIED_VERSION);
    const unloaded = supervisedWorld({ version: undefined });
    const unknown = await createRcSessionCommands(unloaded.deps).compact(SESSION);
    expect(unknown.ok ? "" : unknown.message).toContain("control plugin has not loaded");
    expect([...unverified.ran, ...unloaded.instructed]).toEqual([]);
  });

  it("refuses unsent a goal condition that is empty, a clear word, or longer than /goal accepts", async () => {
    const world = supervisedWorld();
    const commands = createRcSessionCommands(world.deps);
    for (const condition of ["   ", "Stop", "x".repeat(RC_GOAL_CONDITION_MAX_CHARS + 1)]) {
      expect((await commands.goalSet(SESSION, condition)).ok).toBe(false);
    }
    expect(world.ran).toEqual([]);
  });

  it("runs one session's verbs one at a time, in the order they were asked", async () => {
    const order: string[] = [];
    let release: (() => void) | undefined;
    const world = supervisedWorld();
    const commands = createRcSessionCommands({
      ...world.deps,
      supervisedOf: async () => {
        const target = await world.deps.supervisedOf(SESSION);
        if (target === undefined || "refused" in target) throw new Error("no target");
        return {
          ...target,
          compact: async () => {
            order.push("compact started");
            await new Promise<void>((resolve) => {
              release = resolve;
            });
            order.push("compact ended");
            return { kind: "compacted" as const };
          },
          runGoal: async (args, signal, waitMs) => {
            order.push("goal ran");
            await target.runGoal(args, signal, waitMs);
          },
        };
      },
    });
    const compacting = commands.compact(SESSION);
    const setting = commands.goalSet(SESSION, "tests pass");
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    expect(order).toEqual(["compact started"]);
    release?.();
    await Promise.all([compacting, setting]);
    expect(order).toEqual(["compact started", "compact ended", "goal ran"]);
  });

  it("takes the self-hosted route only for a session no supervisor owns, gated on the worker's own reported version", async () => {
    const unknown = selfHostedWorld(undefined);
    const refused = await createRcSessionCommands(unknown.deps).goalGet(SESSION);
    expect(refused.ok ? "" : refused.message).toContain("has not reported its Claude Code version");
    expect(unknown.written).toEqual([]);
    const verified = selfHostedWorld(VERIFIED_VERSION);
    const delivered = await createRcSessionCommands(verified.deps).goalClear(SESSION);
    expect(delivered).toEqual({ ok: false, message: "the API answered HTTP 500 to the injected event: the self-hosted surface refused the write" });
    expect(verified.written.map((body) => body.includes('"content":"/goal clear"'))).toEqual([true]);
  });

  it("refuses an unsupervised session when the door self-hosts but its own surface is unbound, naming why, and writes nothing", async () => {
    const unbound = selfHostedWorld(VERIFIED_VERSION, "AGENT_SHIM_TRANSPARENT_SURFACE is not set");
    const refused = await createRcSessionCommands(unbound.deps).goalSet(SESSION, "tests pass");
    expect(refused.ok ? "" : refused.message).toContain("cannot take a command: AGENT_SHIM_TRANSPARENT_SURFACE is not set");
    expect(unbound.written).toEqual([]);
  });

  it("refuses an unsupervised session the door's self-hosted service does not own, writing nothing, since a native session is never written to as a person's app", async () => {
    const native = selfHostedWorld(VERIFIED_VERSION, undefined, true, false);
    const refused = await createRcSessionCommands(native.deps).goalSet(SESSION, "tests pass");
    expect(refused.ok ? "" : refused.message).toContain("not launched under an agent-shim supervisor");
    expect(native.written).toEqual([]);
  });

  it("refuses a session neither route reaches with the reason, and an unknown one as unknown", async () => {
    const deps: RcSessionCommandDeps = { supervisedOf: noSupervisor, goalOf: noFile, selfHost: undefined, isObserved: (id) => id === SESSION };
    const commands = createRcSessionCommands(deps);
    const unsupported = await commands.compact(SESSION);
    expect(unsupported.ok ? "" : unsupported.message).toContain("not launched under an agent-shim supervisor");
    expect(unsupported.ok ? "" : unsupported.message).toContain("treats any other writer as a peer");
    const missing = await commands.goalGet("cse_missing");
    expect(missing.ok ? "" : missing.message).toBe("the front door has not observed Remote Control session cse_missing");
  });

  it("bounds a supervised request by the wait, aborting the plugin's wait when it passes", async () => {
    const world = supervisedWorld();
    let seen: AbortSignal | undefined;
    const commands = createRcSessionCommands({
      ...world.deps,
      supervisedOf: async () => {
        const target = await world.deps.supervisedOf(SESSION);
        if (target === undefined || "refused" in target) throw new Error("no target");
        return {
          ...target,
          // A plugin that never answers, as one queued behind a turn waiting on a permission prompt does: only the signal ends its wait.
          compact: async (signal) => {
            seen = signal;
            await new Promise<void>((resolve) => {
              signal.addEventListener("abort", () => {
                resolve();
              }, { once: true });
            });
            signal.throwIfAborted();
            return { kind: "compacted" as const };
          },
        };
      },
    });
    const result = await commands.compact(SESSION, { waitMs: SHORT_WAIT_MS });
    expect(seen?.aborted).toBe(true);
    expect(result.ok ? "" : result.message).toContain(`within ${String(SHORT_WAIT_MS)} ms`);
  });

  it("bounds a self-hosted verb by one deadline in all, however many commands it runs", async () => {
    const world = selfHostedWorld(VERIFIED_VERSION, undefined, true);
    const result = await createRcSessionCommands(world.deps).goalSet(SESSION, "tests pass", { waitMs: SHORT_WAIT_MS });
    expect(result.ok ? "" : result.message).toContain(`within ${String(SHORT_WAIT_MS)} ms in all`);
    // The goal set reads the goal it replaces first; the deadline passed during that read, so the set itself was never written.
    expect(world.written).toHaveLength(1);
  });

  it("waits for the transcript row that records a goal set when it lands after the command returns", async () => {
    const world = supervisedWorld();
    const lagging: RcSessionCommandDeps = {
      ...world.deps,
      supervisedOf: async () => {
        const target = await world.deps.supervisedOf(SESSION);
        if (target === undefined || "refused" in target) throw new Error("no target");
        return {
          ...target,
          // The command resolves before its row is written, as a transcript flush can trail the command's own completion.
          runGoal: async (args) => {
            world.ran.push(args);
            setTimeout(() => {
              world.transcript.push(goalRow({ met: false, sentinel: true, condition: args }));
            }, 0);
            await Promise.resolve();
          },
        };
      },
    };
    expect(await createRcSessionCommands(lagging).goalSet(SESSION, "tests pass")).toEqual({ ok: true, report: { route: "supervised", condition: "tests pass", superseded: null } });
  });

  it("refuses a goal condition that spans lines, unsent", async () => {
    const world = supervisedWorld();
    const result = await createRcSessionCommands(world.deps).goalSet(SESSION, "tests pass\nand docs build");
    expect(result.ok ? "" : result.message).toContain("a goal condition is one line");
    expect(world.ran).toEqual([]);
  });

  it("refuses with the reason when the door cannot tell which supervised launch the session is", async () => {
    const deps: RcSessionCommandDeps = { supervisedOf: async () => await Promise.resolve({ refused: "two launches claim it" }), goalOf: noFile, selfHost: undefined, isObserved: () => true };
    expect(await createRcSessionCommands(deps).goalGet(SESSION)).toEqual({ ok: false, message: "two launches claim it" });
  });

  it("does not start a verb whose request was already aborted", async () => {
    const world = supervisedWorld();
    const controller = new AbortController();
    controller.abort();
    const result = await createRcSessionCommands(world.deps).goalSet(SESSION, "tests pass", { signal: controller.signal });
    expect(result.ok ? "" : result.message).toContain("aborted before it ran");
    expect(world.ran).toEqual([]);
  });
});
