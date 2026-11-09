import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { enterProcessRole } from "../processRole";
import { MAX_TIMER_DELAY_MS } from "../config/schema";
import { DEFAULT_PROVIDER_CONNECT_TIMEOUT_MS } from "../providerReachability";
import { PROBE_WAIT_MARGIN_MS } from "./probe";
import { REPORT_PROGRESS_FD, REPORT_PROGRESS_FD_ENV, reportProgressTarget, LOCAL_WORK_ANNOUNCE_INTERVAL_MS, REPORT_QUIET_MS, REPORT_SIZE_PREFIX, encodeReportSize } from "./reportProgress";
import { createDoorReports } from "./doorReports";
import { MAX_REPORT_CHILDREN } from "./reportLimits";

/** The release the doors in these tests say they are. */
const RELEASE = "12.0.0";
const DOOR = { release: RELEASE, build: "door-build" };

const DOCTOR = { ok: false, findings: [{ section: "provider", severity: "fail", message: "provider spark could not connect to http://192.0.2.1:8000: no connection accepted within 1500ms", subject: "spark" }] };

/** An invocation of this test's own Node running `script`, standing in for the door's own executable: what the child prints and exits with is what the door is told. */
function nodeRunning(script: string): (args: readonly string[]) => { readonly command: string; readonly args: readonly string[] } {
  return (args) => ({ command: process.execPath, args: ["-e", script, "--", ...args] });
}

/** A report bound short enough that a test waiting it out stays quick. */
const SHORT_BOUND_MS = 300;
/** How many short bounds make the long one. */
const BOUNDS_BEFORE_GIVING_UP = 10;
/** A bound a test that must not reach it can name: well past the abort it waits for, and short enough that a missing abort fails promptly. */
const LONG_BOUND_MS = SHORT_BOUND_MS * BOUNDS_BEFORE_GIVING_UP;
/** How long a hung child's timer holds it open: far past every bound a test waits, so only a kill ends it. */
const HOLD_MS = 600_000;
const POLL_MS = 20;
/** Polls a test gives a killed child to disappear from the process table: many times the kill's own latency. */
const POLL_ATTEMPTS = 250;

let leaveRole: (() => void) | undefined;

afterEach(() => {
  leaveRole?.();
  leaveRole = undefined;
});

/** A child script that prints `report` the way a report child does: its size line, then the report. */
function printing(report: string): string {
  return `process.stdout.write(${JSON.stringify(encodeReportSize(Buffer.byteLength(report)))}); process.stdout.write(${JSON.stringify(report)});`;
}

/** A report child that is only streams the test writes to, so the watchdog is driven by announcements and fake timers alone, with no process start-up for a loaded host to stretch. */
function fakeReportChild(): { readonly spawn: typeof spawn; readonly progress: PassThrough; readonly killed: () => boolean } {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const progress = new PassThrough();
  class FakeChild extends EventEmitter {
    public readonly stdio = [null, stdout, stderr, progress];
    public killed = false;
    // A real child closes after the kill has been sent, never inside it.
    public kill(): boolean {
      this.killed = true;
      queueMicrotask(() => { this.emit("close", null); });
      return true;
    }
  }
  const child = new FakeChild();
  return { spawn: (() => child) as unknown as typeof spawn, progress, killed: () => child.killed };
}

/** Report children the test finishes itself: each spawn makes a fresh fake child, remembered in the order started, and `finish` ends the oldest that is still running with `report` as its output. */
function controllableChildren(): { readonly spawn: typeof spawn; readonly started: () => number; readonly running: () => number; readonly peak: () => number; readonly finish: (report: string) => void; readonly killedCount: () => number } {
  class Fake extends EventEmitter {
    public readonly stdout = new PassThrough();
    public readonly stdio = [null, this.stdout, new PassThrough(), new PassThrough()];
    public done = false;
    public wasKilled = false;
    public kill(): boolean {
      this.wasKilled = true;
      this.done = true;
      queueMicrotask(() => { this.emit("close", null, "SIGKILL"); });
      return true;
    }
  }
  const children: Fake[] = [];
  let peakRunning = 0;
  const alive = (): number => children.filter((child) => !child.done).length;
  return {
    spawn: (() => {
      const fake = new Fake();
      children.push(fake);
      peakRunning = Math.max(peakRunning, alive());
      return fake;
    }) as unknown as typeof spawn,
    started: () => children.length,
    running: alive,
    peak: () => peakRunning,
    killedCount: () => children.filter((child) => child.wasKilled).length,
    finish: (report) => {
      const oldest = children.find((child) => !child.done);
      if (oldest === undefined) {
        throw new Error("no report child is running");
      }
      oldest.done = true;
      oldest.stdout.write(`${encodeReportSize(Buffer.byteLength(report))}${report}`);
      oldest.emit("close", 0, null);
    },
  };
}

describe("reports requested together", () => {
  const FIRST = 100;
  const SECOND = 200;
  const THIRD = 400;
  const SIZES = [FIRST, SECOND, THIRD] as const;
  const settle = async (): Promise<void> => {
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  };

  it("share one child for any number of requests for the same report, and each gets the report", async () => {
    for (const size of SIZES) {
      const children = controllableChildren();
      const reports = createDoorReports({ selfInvocation: nodeRunning(""), env: {}, door: DOOR, spawn: children.spawn });
      const asked = Array.from({ length: size }, async () => reports.doctorReport(undefined));
      await settle();
      expect(children.started(), `size ${String(size)}`).toBe(1);
      children.finish(JSON.stringify(DOCTOR));
      const answers = await Promise.all(asked);
      expect(answers).toHaveLength(size);
      expect(answers.every((answer) => answer.ok === DOCTOR.ok)).toBe(true);
      // A request made after the report is in starts a new child: nothing is cached.
      void reports.doctorReport(undefined).catch(() => undefined);
      await settle();
      expect(children.started()).toBe(2);
    }
  });

  it("run no more children at once than the bound, however many different reports are asked for", async () => {
    for (const size of SIZES) {
      const children = controllableChildren();
      const reports = createDoorReports({ selfInvocation: nodeRunning(""), env: {}, door: DOOR, spawn: children.spawn });
      const asked = Array.from({ length: size }, async (_, index) => reports.checkReport(`/work/${String(index)}`, undefined, undefined).catch(() => undefined));
      await settle();
      for (let finished = 0; finished < size; finished += 1) {
        expect(children.running(), `size ${String(size)} after ${String(finished)}`).toBe(Math.min(MAX_REPORT_CHILDREN, size - finished));
        children.finish("{}");
        await settle();
      }
      await Promise.all(asked);
      expect(children.peak()).toBeLessThanOrEqual(MAX_REPORT_CHILDREN);
      expect(children.started()).toBe(size);
    }
  });

  it("do not join a collection every request for it has abandoned, even while it still waits for a child slot", async () => {
    const children = controllableChildren();
    const reports = createDoorReports({ selfInvocation: nodeRunning(""), env: {}, door: DOOR, spawn: children.spawn });
    // Both slots are busy, so a third report waits its turn.
    const busy = Array.from({ length: MAX_REPORT_CHILDREN }, async (_, index) => reports.checkReport(`/busy/${String(index)}`, undefined, undefined).catch(() => undefined));
    await settle();
    expect(children.running()).toBe(MAX_REPORT_CHILDREN);
    const first = new AbortController();
    const abandoned = reports.checkReport("/wanted", undefined, first.signal).catch((error: unknown) => error);
    await settle();
    first.abort(new Error("the first client went away"));
    expect(await abandoned).toEqual(new Error("the first client went away"));
    // A second client asks for the same report with no abort of its own: its own child's outcome answers it (an empty report is refused by the schema), never the first client's reason.
    const second = reports.checkReport("/wanted", undefined, undefined).catch((error: unknown) => error);
    await settle();
    // The abandoned collection settles when a slot reaches it, which must not forget the collection the second client started: a third client still joins that one.
    children.finish("{}");
    await settle();
    const third = reports.checkReport("/wanted", undefined, undefined).catch((error: unknown) => error);
    await settle();
    for (let finished = 1; finished < MAX_REPORT_CHILDREN + 1; finished += 1) {
      children.finish("{}");
      await settle();
    }
    expect(await third).toBeInstanceOf(Error);
    const outcome = await second;
    expect(outcome).toBeInstanceOf(Error);
    expect(outcome).not.toEqual(new Error("the first client went away"));
    await Promise.all(busy);
    expect(children.started()).toBe(MAX_REPORT_CHILDREN + 1);
  });

  it("end the child only when every request waiting on it has aborted", async () => {
    const children = controllableChildren();
    const reports = createDoorReports({ selfInvocation: nodeRunning(""), env: {}, door: DOOR, spawn: children.spawn });
    const first = new AbortController();
    const second = new AbortController();
    const a = reports.doctorReport(first.signal).catch((error: unknown) => error);
    const b = reports.doctorReport(second.signal).catch((error: unknown) => error);
    await settle();
    first.abort(new Error("first gave up"));
    expect(await a).toEqual(new Error("first gave up"));
    await settle();
    expect(children.killedCount()).toBe(0);
    second.abort(new Error("second gave up"));
    expect(await b).toEqual(new Error("second gave up"));
    await settle();
    expect(children.killedCount()).toBe(1);
  });
});

describe("the bound on a report child", () => {
  const QUIET_MS = 1_000;
  /** What the door waits between announcements outside a step: one unit's allowance and the interval a unit's note may be dropped for. */
  const SILENCE_MS = QUIET_MS + LOCAL_WORK_ANNOUNCE_INTERVAL_MS;
  const STEP_MS = 5_000;
  /** Well past every bound of these tests, in fake time. */
  const LONG_WAIT_MS = 100_000;

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Starts a doctor report on a fake child; `announce` writes a progress line and lets it arrive. */
  function startReport() {
    vi.useFakeTimers();
    const fake = fakeReportChild();
    const reports = createDoorReports({ selfInvocation: nodeRunning(""), env: {}, door: DOOR, silenceMs: SILENCE_MS, spawn: fake.spawn });
    const controller = new AbortController();
    const outcome = reports.doctorReport(controller.signal).then(() => "reported", (error: unknown) => (error instanceof Error ? error.message : String(error)));
    return {
      fake,
      outcome,
      controller,
      announce: async (line: string) => {
        fake.progress.write(line);
        await vi.advanceTimersByTimeAsync(0);
      },
      wait: async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); },
    };
  }

  it("is two default probe bounds of silence", () => {
    expect(REPORT_QUIET_MS).toBe(2 * DEFAULT_PROVIDER_CONNECT_TIMEOUT_MS);
  });

  it("holds a child that announces nothing to the quiet bound from its start", async () => {
    const run = startReport();
    await run.wait(SILENCE_MS - 1);
    expect(run.fake.killed()).toBe(false);
    await run.wait(1);
    expect(await run.outcome).toBe(`agent-shim doctor --json made no progress within ${String(SILENCE_MS)}ms`);
    expect(run.fake.killed()).toBe(true);
  });

  it("gives a child inside an announced step the step's bound and margin, not the quiet bound", async () => {
    const run = startReport();
    await run.announce(`begin ${String(STEP_MS)}\n`);
    await run.wait(STEP_MS + PROBE_WAIT_MARGIN_MS - 1);
    expect(run.fake.killed()).toBe(false);
    await run.wait(1);
    expect(await run.outcome).toBe(`agent-shim doctor --json made no progress within ${String(STEP_MS + PROBE_WAIT_MARGIN_MS)}ms`);
  });

  it("holds a child to the quiet bound again once it announces the end of a step", async () => {
    const run = startReport();
    await run.announce(`begin ${String(LONG_WAIT_MS)}\n`);
    await run.wait(SILENCE_MS * 2);
    expect(run.fake.killed()).toBe(false);
    await run.announce("end\n");
    await run.wait(SILENCE_MS - 1);
    expect(run.fake.killed()).toBe(false);
    await run.wait(1);
    expect(await run.outcome).toBe(`agent-shim doctor --json made no progress within ${String(SILENCE_MS)}ms`);
  });

  it("keeps a child that announces local work alive past the quiet bound, for as long as it announces", async () => {
    const WORK_ROUNDS = 8;
    const run = startReport();
    for (let round = 0; round < WORK_ROUNDS; round += 1) {
      await run.wait(SILENCE_MS - 1);
      await run.announce("work\n");
    }
    expect(run.fake.killed()).toBe(false);
    await run.wait(SILENCE_MS);
    expect(await run.outcome).toBe(`agent-shim doctor --json made no progress within ${String(SILENCE_MS)}ms`);
  });

  it("waits, by default, a unit's whole allowance after the latest moment a unit whose note was dropped can start", async () => {
    vi.useFakeTimers();
    const fake = fakeReportChild();
    const reports = createDoorReports({ selfInvocation: nodeRunning(""), env: {}, door: DOOR, spawn: fake.spawn });
    const outcome = reports.doctorReport(new AbortController().signal).then(() => "reported", (error: unknown) => (error instanceof Error ? error.message : String(error)));
    fake.progress.write("work\n");
    await vi.advanceTimersByTimeAsync(0);
    // The unit starts as late as the interval allows after that announcement, and its own note is dropped.
    await vi.advanceTimersByTimeAsync(LOCAL_WORK_ANNOUNCE_INTERVAL_MS - 1);
    // It then stalls for its whole allowance: the door must still be waiting.
    await vi.advanceTimersByTimeAsync(REPORT_QUIET_MS);
    expect(fake.killed()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toBe(`agent-shim doctor --json made no progress within ${String(REPORT_QUIET_MS + LOCAL_WORK_ANNOUNCE_INTERVAL_MS)}ms`);
  });

  it("ends the call with the abort of a child inside a long step", async () => {
    const run = startReport();
    await run.announce(`begin ${String(LONG_WAIT_MS)}\n`);
    await run.wait(SILENCE_MS * 2);
    run.controller.abort();
    await run.wait(0);
    expect(run.fake.killed()).toBe(true);
    expect(await run.outcome).toMatch(/abort/i);
  });

  it("never sets a timer past the longest delay a timer takes", async () => {
    vi.useFakeTimers();
    const delays: number[] = [];
    const real = globalThis.setTimeout;
    const timers = vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: () => void, delay?: number) => {
      delays.push(delay ?? 0);
      return real(handler, delay);
    }) as typeof setTimeout);
    const fake = fakeReportChild();
    const reports = createDoorReports({ selfInvocation: nodeRunning(""), env: {}, door: DOOR, silenceMs: SILENCE_MS, spawn: fake.spawn });
    const controller = new AbortController();
    const outcome = reports.doctorReport(controller.signal).catch(() => undefined);
    fake.progress.write(`begin ${String(MAX_TIMER_DELAY_MS * 2)}\n`);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await outcome;
    timers.mockRestore();
    expect(delays.length).toBeGreaterThan(0);
    expect(Math.max(...delays)).toBeLessThanOrEqual(MAX_TIMER_DELAY_MS);
  });

  it("starts its child with the descriptor its progress is announced on", async () => {
    const reports = createDoorReports({ selfInvocation: nodeRunning(printing("{}")), env: {}, door: DOOR });
    await expect(reports.doctorReport(new AbortController().signal)).rejects.toThrow();
    const seen = createDoorReports({ selfInvocation: nodeRunning(`process.stderr.write(process.env.${REPORT_PROGRESS_FD_ENV} ?? "none"); process.exitCode = 1;`), env: {}, door: DOOR });
    await expect(seen.doctorReport(new AbortController().signal)).rejects.toThrow(String(REPORT_PROGRESS_FD));
  });

  it("names its own process, descriptor and release in the variable it gives the child", async () => {
    const seen = createDoorReports({ selfInvocation: nodeRunning(`process.stderr.write(process.env.${REPORT_PROGRESS_FD_ENV} ?? "none"); process.exitCode = 1;`), env: {}, door: DOOR });
    await expect(seen.doctorReport(new AbortController().signal)).rejects.toThrow(reportProgressTarget(REPORT_PROGRESS_FD, process.pid, DOOR));
  });

  it("says the door should be restarted when the executable it runs is gone", async () => {
    const reports = createDoorReports({ selfInvocation: () => ({ command: path.join(os.tmpdir(), `no-such-agent-shim-${randomUUID()}`), args: [] }), env: {}, door: DOOR });
    await expect(reports.doctorReport(new AbortController().signal)).rejects.toThrow(/is gone.*agent-shim frontdoor restart/);
  });
});

describe("the door's check and doctor reports", () => {
  it("are collected in a child of the door's own executable, never on the door's event loop, so the supervisor role does not refuse them", async () => {
    leaveRole = enterProcessRole("frontdoor-supervisor");
    // doctor exits 1 when a finding fails, and still prints its report.
    const asked: (readonly string[])[] = [];
    const reports = createDoorReports({
      selfInvocation: (args) => {
        asked.push(args);
        return nodeRunning(`${printing(JSON.stringify(DOCTOR))} process.exitCode = 1;`)(args);
      },
      env: {}, door: DOOR,
    });
    expect(await reports.doctorReport(new AbortController().signal)).toEqual(DOCTOR);
    expect(asked).toEqual([["doctor", "--json"]]);
  });

  it("asks check for the directory and the identity it was given", async () => {
    const asked: (readonly string[])[] = [];
    const reports = createDoorReports({
      selfInvocation: (args) => {
        asked.push(args);
        return nodeRunning(printing("{}"))(args);
      },
      env: {}, door: DOOR,
    });
    await expect(reports.checkReport("/work", "personal", new AbortController().signal)).rejects.toThrow();
    expect(asked).toEqual([["check", "/work", "--identity", "personal", "--json"]]);
  });

  it("fails with what the child said when it printed no report", async () => {
    const reports = createDoorReports({ selfInvocation: nodeRunning("process.stderr.write('agent-shim: no identity named ghost\\n'); process.exitCode = 1;"), env: {}, door: DOOR });
    await expect(reports.doctorReport(new AbortController().signal)).rejects.toThrow("agent-shim: no identity named ghost");
  });

  it("refuses a report that does not match its schema", async () => {
    const reports = createDoorReports({ selfInvocation: nodeRunning(printing(JSON.stringify({ ok: "yes" }))), env: {}, door: DOOR });
    await expect(reports.doctorReport(new AbortController().signal)).rejects.toThrow();
  });

  /** A child that never reports, standing in for a report step stuck on something that does not answer. */
  const hungChild = nodeRunning(`setInterval(() => undefined, ${String(HOLD_MS)});`);

  /** `spawn` that keeps every child it starts, so a test reads a child's pid from the process itself, which exists the moment `spawn` returns, however soon the bound kills it. */
  function recordingSpawn(): { readonly spawn: typeof spawn; readonly children: ChildProcess[] } {
    const children: ChildProcess[] = [];
    return {
      children,
      spawn: ((...args: Parameters<typeof spawn>) => {
        const child = spawn(...args);
        children.push(child);
        return child;
      }) as typeof spawn,
    };
  }

  async function gone(pid: number): Promise<boolean> {
    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
      try {
        process.kill(pid, 0);
      } catch {
        return true;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, POLL_MS);
      });
    }
    return false;
  }

  it("kills a child that has not reported within its bound, and fails naming the bound", async () => {
    const recorded = recordingSpawn();
    const reports = createDoorReports({ selfInvocation: hungChild, env: {}, door: DOOR, silenceMs: SHORT_BOUND_MS, spawn: recorded.spawn });
    await expect(reports.doctorReport(new AbortController().signal)).rejects.toThrow(`made no progress within ${String(SHORT_BOUND_MS)}ms`);
    const pid = recorded.children[0]?.pid;
    if (pid === undefined) {
      throw new Error("the child did not start");
    }
    expect(await gone(pid)).toBe(true);
  });

  it("kills the child of a request whose client went away", async () => {
    const recorded = recordingSpawn();
    const reports = createDoorReports({ selfInvocation: hungChild, env: {}, door: DOOR, silenceMs: LONG_BOUND_MS, spawn: recorded.spawn });
    const controller = new AbortController();
    const answered = reports.checkReport("/work", undefined, controller.signal);
    // The abort, not the bound, must be what ends the call.
    const settled = expect(answered).rejects.toMatchObject({ name: "AbortError" });
    const pid = recorded.children[0]?.pid;
    if (pid === undefined) {
      throw new Error("the child did not start");
    }
    controller.abort();
    await settled;
    expect(await gone(pid)).toBe(true);
  });

  it("ends the child of an aborted request and of an expired bound with the same signal", async () => {
    const endedBy = async (abort: boolean): Promise<NodeJS.Signals | null> => {
      const recorded = recordingSpawn();
      const reports = createDoorReports({ selfInvocation: hungChild, env: {}, door: DOOR, silenceMs: abort ? LONG_BOUND_MS : SHORT_BOUND_MS, spawn: recorded.spawn });
      const controller = new AbortController();
      const answered = reports.doctorReport(controller.signal).catch(() => undefined);
      if (abort) {
        controller.abort();
      }
      await answered;
      const child = recorded.children[0];
      if (child?.pid === undefined) {
        throw new Error("the child did not start");
      }
      await gone(child.pid);
      return child.signalCode;
    };
    expect(await endedBy(true)).toBe("SIGKILL");
    expect(await endedBy(false)).toBe("SIGKILL");
  });

  it("ends the child's own children with it, so a program the report ran does not outlive the request", async () => {
    const pidFile = path.join(os.tmpdir(), `agent-shim-grandchild-${String(process.pid)}-${randomUUID()}`);
    const spawnsGrandchild = nodeRunning(
      `const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => undefined, ${String(HOLD_MS)})"], { stdio: "ignore" }); require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)); setInterval(() => undefined, ${String(HOLD_MS)});`,
    );
    const reports = createDoorReports({ selfInvocation: spawnsGrandchild, env: {}, door: DOOR, silenceMs: LONG_BOUND_MS });
    const controller = new AbortController();
    const answered = reports.doctorReport(controller.signal).catch(() => undefined);
    let grandchild: number | undefined;
    for (let attempt = 0; attempt < POLL_ATTEMPTS && grandchild === undefined; attempt += 1) {
      const written = fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf8") : "";
      grandchild = written === "" ? undefined : Number(written);
      if (grandchild === undefined) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, POLL_MS);
        });
      }
    }
    fs.rmSync(pidFile, { force: true });
    if (grandchild === undefined) {
      throw new Error("the grandchild did not start");
    }
    controller.abort();
    await answered;
    const ended = await gone(grandchild);
    if (!ended) {
      process.kill(grandchild, "SIGKILL");
    }
    expect(ended).toBe(true);
  });

  it("ends a child that prints a report longer than the size it announced, and fails naming that size", async () => {
    const recorded = recordingSpawn();
    const announced = 1_024;
    const endless = nodeRunning(`process.stdout.write(${JSON.stringify(encodeReportSize(announced))}); const line = "x".repeat(${String(announced)}); setInterval(() => process.stdout.write(line), 1);`);
    const reports = createDoorReports({ selfInvocation: endless, env: {}, door: DOOR, silenceMs: LONG_BOUND_MS, spawn: recorded.spawn });
    await expect(reports.doctorReport(new AbortController().signal)).rejects.toThrow(`printed more than the ${String(announced)} bytes it announced`);
    const pid = recorded.children[0]?.pid;
    if (pid === undefined) {
      throw new Error("the child did not start");
    }
    expect(await gone(pid)).toBe(true);
  });

  it("accepts a report of any size the child announced, however long", async () => {
    /** Past the fixed cap the door used to apply, so only an announced size can have admitted it. */
    const BYTES_PER_MIB = 1_048_576;
    const BIG_MIB = 40;
    const BIG_BYTES = BIG_MIB * BYTES_PER_MIB;
    const script = `const body = '{"padding":"' + "x".repeat(${String(BIG_BYTES)}) + '"}'; process.stdout.write(${JSON.stringify(REPORT_SIZE_PREFIX)} + Buffer.byteLength(body) + "\\n"); process.stdout.write(body); process.exitCode = 1;`;
    const reports = createDoorReports({ selfInvocation: nodeRunning(script), env: {}, door: DOOR });
    // The report is read whole, past what a fixed cap would allow, and then refused by its schema.
    await expect(reports.doctorReport(new AbortController().signal)).rejects.toThrow(/expected|invalid|required/i);
  });

  it("names the short read when a child exits having printed fewer bytes than it announced", async () => {
    const announced = 100;
    const partial = '{"a":1}';
    const reports = createDoorReports({ selfInvocation: nodeRunning(`process.stdout.write(${JSON.stringify(encodeReportSize(announced))}); process.stdout.write(${JSON.stringify(partial)});`), env: {}, door: DOOR });
    await expect(reports.doctorReport(new AbortController().signal)).rejects.toThrow(`exited 0 having printed ${String(partial.length)} of the ${String(announced)} bytes it announced`);
  });

  it("names the short read, the signal and what the child said, when a child is killed partway through its report", async () => {
    const announced = 100;
    const partial = '{"a":1}';
    const script = `process.stdout.write(${JSON.stringify(encodeReportSize(announced))}); process.stdout.write(${JSON.stringify(partial)}); process.stderr.write("out of memory"); setTimeout(() => process.kill(process.pid, "SIGKILL"), 20);`;
    const reports = createDoorReports({ selfInvocation: nodeRunning(script), env: {}, door: DOOR });
    await expect(reports.doctorReport(new AbortController().signal)).rejects.toThrow(`was ended by SIGKILL having printed ${String(partial.length)} of the ${String(announced)} bytes it announced: out of memory`);
  });

  it("names the short read, and what the child said, when a child announces a size and prints nothing before it dies", async () => {
    const announced = 100;
    const script = `process.stdout.write(${JSON.stringify(encodeReportSize(announced))}); process.stderr.write("could not read the keychain"); process.exitCode = 1;`;
    const reports = createDoorReports({ selfInvocation: nodeRunning(script), env: {}, door: DOOR });
    await expect(reports.doctorReport(new AbortController().signal)).rejects.toThrow(`exited 1 having printed 0 of the ${String(announced)} bytes it announced: could not read the keychain`);
  });

  it("names a short read, not an over-long one, when a child is cut off inside a multibyte character", async () => {
    const announced = 10;
    const script = `process.stdout.write(Buffer.concat([Buffer.from(${JSON.stringify(encodeReportSize(announced))}), Buffer.from("aaaaaaaa"), Buffer.from([0xc3])]));`;
    const reports = createDoorReports({ selfInvocation: nodeRunning(script), env: {}, door: DOOR });
    await expect(reports.doctorReport(new AbortController().signal)).rejects.toThrow(`exited 0 having printed 9 of the ${String(announced)} bytes it announced`);
  });

  it("accepts a healthy multibyte report the child printed in pieces", async () => {
    const report = JSON.stringify({ findings: [], ok: true, note: "é€😀" });
    const script = `const body = Buffer.from(${JSON.stringify(report)}); process.stdout.write(${JSON.stringify(encodeReportSize(Buffer.byteLength(report)))}); process.stdout.write(body.subarray(0, 25)); setTimeout(() => process.stdout.write(body.subarray(25)), 30);`;
    const reports = createDoorReports({ selfInvocation: nodeRunning(script), env: {}, door: DOOR });
    const failure = await reports.doctorReport(new AbortController().signal).then(() => "", (error: unknown) => (error instanceof Error ? error.message : String(error)));
    expect(failure).not.toContain("bytes it announced");
    expect(failure).not.toContain("not JSON");
  });

  it("still says it exited without a report when a child announced nothing and printed nothing", async () => {
    const reports = createDoorReports({ selfInvocation: nodeRunning("process.exitCode = 3;"), env: {}, door: DOOR });
    await expect(reports.doctorReport(new AbortController().signal)).rejects.toThrow("exited 3 without a report");
  });

  it("ends a child that prints without announcing a size", async () => {
    const reports = createDoorReports({ selfInvocation: nodeRunning(`process.stdout.write("{}".repeat(100));`), env: {}, door: DOOR, silenceMs: LONG_BOUND_MS });
    await expect(reports.doctorReport(new AbortController().signal)).rejects.toThrow("printed output without announcing its size");
  });

  it("names what the child wrote to stderr when its stdout is not JSON", async () => {
    const reports = createDoorReports({ selfInvocation: nodeRunning(`process.stderr.write('warning: the keychain is locked\\n'); ${printing("not json at all")}`), env: {}, door: DOOR });
    const failure = await reports.doctorReport(new AbortController().signal).catch((caught: unknown) => caught);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("agent-shim doctor --json printed output that is not JSON");
    expect((failure as Error).message).toContain("warning: the keychain is locked");
  });

  it("keeps only the end of a long stderr in what it reports", async () => {
    const reports = createDoorReports({ selfInvocation: nodeRunning("process.stderr.write('FIRST' + 'x'.repeat(100000) + 'LAST'); process.exitCode = 3;"), env: {}, door: DOOR });
    const failure = await reports.doctorReport(new AbortController().signal).catch((caught: unknown) => caught);
    expect((failure as Error).message).toContain("LAST");
    expect((failure as Error).message).not.toContain("FIRST");
  });
});
