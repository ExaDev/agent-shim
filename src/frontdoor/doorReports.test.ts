import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { enterProcessRole } from "../processRole";
import { MAX_TIMER_DELAY_MS } from "../config/schema";
import { DEFAULT_PROVIDER_CONNECT_TIMEOUT_MS } from "../providerReachability";
import { PROBE_WAIT_MARGIN_MS } from "./probe";
import { REPORT_PROGRESS_FD, REPORT_PROGRESS_FD_ENV, REPORT_QUIET_MS } from "./reportProgress";
import { createDoorReports } from "./doorReports";

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

/** What a child writes to the progress descriptor to announce a blocking step that may take `boundMs`, then a hang: a stuck step. */
function announcingThenHanging(announcements: string): (args: readonly string[]) => { readonly command: string; readonly args: readonly string[] } {
  return nodeRunning(`require("node:fs").writeSync(Number(process.env.${REPORT_PROGRESS_FD_ENV}), ${JSON.stringify(announcements)}); setInterval(() => undefined, ${String(HOLD_MS)});`);
}

describe("the bound on a report child", () => {
  /** How many quiet bounds a test waits inside a long step to show the quiet bound does not apply there. */
  const QUIET_BOUNDS_WAITED = 3;

  it("is quiet bound of two default probe bounds, which the margin of a blocking step is not part of", () => {
    expect(REPORT_QUIET_MS).toBe(2 * DEFAULT_PROVIDER_CONNECT_TIMEOUT_MS);
  });

  it("gives a child inside an announced step the step's bound and margin, not the quiet bound", async () => {
    const reports = createDoorReports({ selfInvocation: announcingThenHanging(`begin ${String(HOLD_MS)}\n`), env: {}, quietMs: SHORT_BOUND_MS });
    const controller = new AbortController();
    const answered = reports.doctorReport(controller.signal);
    const settled = expect(answered).rejects.toMatchObject({ name: "AbortError" });
    // Well past the quiet bound: a child killed by it would have rejected with the progress message already.
    await new Promise<void>((resolve) => { setTimeout(resolve, SHORT_BOUND_MS * QUIET_BOUNDS_WAITED); });
    controller.abort();
    await settled;
  });

  it("kills a child that stays inside a step past its announced bound and the margin", async () => {
    const reports = createDoorReports({ selfInvocation: announcingThenHanging(`begin ${String(SHORT_BOUND_MS)}\n`), env: {}, quietMs: LONG_BOUND_MS });
    await expect(reports.doctorReport(new AbortController().signal)).rejects.toThrow(`made no progress within ${String(SHORT_BOUND_MS + PROBE_WAIT_MARGIN_MS)}ms`);
  });

  it("holds a child to the quiet bound again once it announces the end of a step", async () => {
    const reports = createDoorReports({ selfInvocation: announcingThenHanging(`begin ${String(HOLD_MS)}\nend\n`), env: {}, quietMs: SHORT_BOUND_MS });
    await expect(reports.doctorReport(new AbortController().signal)).rejects.toThrow(`made no progress within ${String(SHORT_BOUND_MS)}ms`);
  });

  it("keeps a child that announces local work alive past the quiet bound, for as long as it announces", async () => {
    const WORK_ROUNDS = 8;
    const reports = createDoorReports({
      selfInvocation: nodeRunning(`const fs = require("node:fs"); const fd = Number(process.env.${REPORT_PROGRESS_FD_ENV}); let rounds = 0; const timer = setInterval(() => { fs.writeSync(fd, "work\\n"); rounds += 1; if (rounds === ${String(WORK_ROUNDS)}) { clearInterval(timer); process.stdout.write(JSON.stringify(${JSON.stringify(DOCTOR)})); } }, ${String(SHORT_BOUND_MS / 2)});`),
      env: {},
      quietMs: SHORT_BOUND_MS,
    });
    await expect(reports.doctorReport(new AbortController().signal)).resolves.toMatchObject({ ok: false });
  });

  it("holds a child that announces nothing to the quiet bound from its start", async () => {
    const reports = createDoorReports({ selfInvocation: nodeRunning(`setInterval(() => undefined, ${String(HOLD_MS)});`), env: {}, quietMs: SHORT_BOUND_MS });
    await expect(reports.doctorReport(new AbortController().signal)).rejects.toThrow(`made no progress within ${String(SHORT_BOUND_MS)}ms`);
  });

  it("never sets a timer past the longest delay a timer takes", async () => {
    const delays: number[] = [];
    const real = globalThis.setTimeout;
    const timers = vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: () => void, delay?: number) => {
      delays.push(delay ?? 0);
      return real(handler, delay);
    }) as typeof setTimeout);
    const reports = createDoorReports({ selfInvocation: announcingThenHanging(`begin ${String(MAX_TIMER_DELAY_MS * 2)}\n`), env: {}, quietMs: SHORT_BOUND_MS });
    const controller = new AbortController();
    const answered = reports.doctorReport(controller.signal).catch(() => undefined);
    await new Promise<void>((resolve) => { real(resolve, SHORT_BOUND_MS); });
    controller.abort();
    await answered;
    timers.mockRestore();
    expect(Math.max(...delays)).toBeLessThanOrEqual(MAX_TIMER_DELAY_MS);
  });

  it("starts its child with the descriptor its progress is announced on", async () => {
    const reports = createDoorReports({ selfInvocation: nodeRunning(`process.stdout.write(JSON.stringify({ fd: process.env.${REPORT_PROGRESS_FD_ENV} }));`), env: {} });
    await expect(reports.doctorReport(new AbortController().signal)).rejects.toThrow();
    const seen = createDoorReports({ selfInvocation: nodeRunning(`process.stderr.write(process.env.${REPORT_PROGRESS_FD_ENV} ?? "none"); process.exitCode = 1;`), env: {} });
    await expect(seen.doctorReport(new AbortController().signal)).rejects.toThrow(String(REPORT_PROGRESS_FD));
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
        return nodeRunning(`process.stdout.write(${JSON.stringify(JSON.stringify(DOCTOR))}); process.exitCode = 1;`)(args);
      },
      env: {},
    });
    expect(await reports.doctorReport(new AbortController().signal)).toEqual(DOCTOR);
    expect(asked).toEqual([["doctor", "--json"]]);
  });

  it("asks check for the directory and the identity it was given", async () => {
    const asked: (readonly string[])[] = [];
    const reports = createDoorReports({
      selfInvocation: (args) => {
        asked.push(args);
        return nodeRunning("process.stdout.write('{}');")(args);
      },
      env: {},
    });
    await expect(reports.checkReport("/work", "personal", new AbortController().signal)).rejects.toThrow();
    expect(asked).toEqual([["check", "/work", "--identity", "personal", "--json"]]);
  });

  it("fails with what the child said when it printed no report", async () => {
    const reports = createDoorReports({ selfInvocation: nodeRunning("process.stderr.write('agent-shim: no identity named ghost\\n'); process.exitCode = 1;"), env: {} });
    await expect(reports.doctorReport(new AbortController().signal)).rejects.toThrow("agent-shim: no identity named ghost");
  });

  it("refuses a report that does not match its schema", async () => {
    const reports = createDoorReports({ selfInvocation: nodeRunning("process.stdout.write('{\"ok\":\"yes\"}');"), env: {} });
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
    const reports = createDoorReports({ selfInvocation: hungChild, env: {}, quietMs: SHORT_BOUND_MS, spawn: recorded.spawn });
    await expect(reports.doctorReport(new AbortController().signal)).rejects.toThrow(`made no progress within ${String(SHORT_BOUND_MS)}ms`);
    const pid = recorded.children[0]?.pid;
    if (pid === undefined) {
      throw new Error("the child did not start");
    }
    expect(await gone(pid)).toBe(true);
  });

  it("kills the child of a request whose client went away", async () => {
    const recorded = recordingSpawn();
    const reports = createDoorReports({ selfInvocation: hungChild, env: {}, quietMs: LONG_BOUND_MS, spawn: recorded.spawn });
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
      const reports = createDoorReports({ selfInvocation: hungChild, env: {}, quietMs: abort ? LONG_BOUND_MS : SHORT_BOUND_MS, spawn: recorded.spawn });
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
    const reports = createDoorReports({ selfInvocation: spawnsGrandchild, env: {}, quietMs: LONG_BOUND_MS });
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

  it("stops reading a child that prints more than the limit and fails naming it", async () => {
    const recorded = recordingSpawn();
    const limit = 1_024;
    const endless = nodeRunning(`const line = "x".repeat(${String(limit)}); setInterval(() => process.stdout.write(line), 1);`);
    const reports = createDoorReports({ selfInvocation: endless, env: {}, quietMs: LONG_BOUND_MS, stdoutLimitBytes: limit, spawn: recorded.spawn });
    await expect(reports.doctorReport(new AbortController().signal)).rejects.toThrow(`printed more than ${String(limit)} bytes`);
    const pid = recorded.children[0]?.pid;
    if (pid === undefined) {
      throw new Error("the child did not start");
    }
    expect(await gone(pid)).toBe(true);
  });

  it("names what the child wrote to stderr when its stdout is not JSON", async () => {
    const reports = createDoorReports({ selfInvocation: nodeRunning("process.stderr.write('warning: the keychain is locked\\n'); process.stdout.write('not json at all');"), env: {} });
    const failure = await reports.doctorReport(new AbortController().signal).catch((caught: unknown) => caught);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("agent-shim doctor --json printed output that is not JSON");
    expect((failure as Error).message).toContain("warning: the keychain is locked");
  });

  it("keeps only the end of a long stderr in what it reports", async () => {
    const reports = createDoorReports({ selfInvocation: nodeRunning("process.stderr.write('FIRST' + 'x'.repeat(100000) + 'LAST'); process.exitCode = 3;"), env: {} });
    const failure = await reports.doctorReport(new AbortController().signal).catch((caught: unknown) => caught);
    expect((failure as Error).message).toContain("LAST");
    expect((failure as Error).message).not.toContain("FIRST");
  });
});
