import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { enterProcessRole } from "../processRole";
import { MAX_TIMER_DELAY_MS } from "../config/schema";
import { DEFAULT_PROVIDER_CONNECT_TIMEOUT_MS } from "../providerReachability";
import { PROBE_TIMEOUT_MS, PROBE_WAIT_MARGIN_MS, PROBE_WORKER_START_LIMIT_MS } from "./probe";
import { createDoorReports, reportChildTimeoutMs } from "./doorReports";

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

const HTTP = { displayName: "p", credential: { sources: [{ env: "T" }] } };
/** An http provider with the given bound, standing in for a provider file. */
function httpProvider(connectTimeoutMs: number | undefined) {
  return { ...HTTP, baseUrl: "http://127.0.0.1:1", ...(connectTimeoutMs === undefined ? {} : { connectTimeoutMs }) };
}

describe("the bound on a report child", () => {
  const SLOW_PROBE_FACTOR = 5;
  const GROWTH_IDENTITIES = 3;
  const SHORT_PROBE_MS = DEFAULT_PROVIDER_CONNECT_TIMEOUT_MS / 2;
  /** Longer than any provider probe bound the other phases could have been mistaken for. */
  const SLOW_PROBE_MS = DEFAULT_PROVIDER_CONNECT_TIMEOUT_MS * SLOW_PROBE_FACTOR;
  /** One probe phase: the worker's start limit, the bound, and the margin the caller waits past it. */
  const phase = (boundMs: number) => PROBE_WORKER_START_LIMIT_MS + boundMs + PROBE_WAIT_MARGIN_MS;
  /** The doctor report's two listener probes at the default bound, one after the other. */
  const LISTENER_PHASES_MS = 2 * phase(PROBE_TIMEOUT_MS);
  /** The start-up and git query of a report, each allowed a whole default probe bound. */
  const FIXED_LOCAL_MS = 2 * DEFAULT_PROVIDER_CONNECT_TIMEOUT_MS;

  it("covers the provider probe at the longest bound among the providers, both listener probes, and the local steps, each probe with its start limit and margin", () => {
    expect(reportChildTimeoutMs([httpProvider(undefined), httpProvider(SLOW_PROBE_MS), httpProvider(SHORT_PROBE_MS)], 0)).toBe(phase(SLOW_PROBE_MS) + LISTENER_PHASES_MS + FIXED_LOCAL_MS);
  });

  it("covers the default probe bound when no provider names one, or none is an http provider", () => {
    const expected = phase(DEFAULT_PROVIDER_CONNECT_TIMEOUT_MS) + LISTENER_PHASES_MS + FIXED_LOCAL_MS;
    expect(reportChildTimeoutMs([], 0)).toBe(expected);
    expect(reportChildTimeoutMs([{ kind: "codex", displayName: "c", credential: HTTP.credential }], 0)).toBe(expected);
  });

  it("grows by one default probe bound for each identity doctor reads the keychain for", () => {
    expect(reportChildTimeoutMs([], GROWTH_IDENTITIES) - reportChildTimeoutMs([], 0)).toBe(GROWTH_IDENTITIES * DEFAULT_PROVIDER_CONNECT_TIMEOUT_MS);
  });

  it("never exceeds the longest delay a timer takes, past which it would fire at once", () => {
    expect(reportChildTimeoutMs([httpProvider(MAX_TIMER_DELAY_MS)], 0)).toBe(MAX_TIMER_DELAY_MS);
  });

  it("is the bound a report child is given, read from the providers as each request arrives", async () => {
    const delays: number[] = [];
    const real = globalThis.setTimeout;
    const timers = vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: () => void, delay?: number) => {
      delays.push(delay ?? 0);
      return real(handler, delay);
    }) as typeof setTimeout);
    const IDENTITIES = 2;
    let providers = [httpProvider(SLOW_PROBE_MS)];
    const reports = createDoorReports({ selfInvocation: nodeRunning("process.stdout.write('{}');"), env: {}, identityCount: () => IDENTITIES, providers: () => providers });
    await reports.doctorReport(new AbortController().signal).catch(() => undefined);
    providers = [httpProvider(undefined)];
    await reports.doctorReport(new AbortController().signal).catch(() => undefined);
    timers.mockRestore();
    expect(delays).toContain(reportChildTimeoutMs([httpProvider(SLOW_PROBE_MS)], IDENTITIES));
    expect(delays).toContain(reportChildTimeoutMs([httpProvider(undefined)], IDENTITIES));
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
      identityCount: () => 0, providers: () => [],
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
      identityCount: () => 0, providers: () => [],
    });
    await expect(reports.checkReport("/work", "personal", new AbortController().signal)).rejects.toThrow();
    expect(asked).toEqual([["check", "/work", "--identity", "personal", "--json"]]);
  });

  it("fails with what the child said when it printed no report", async () => {
    const reports = createDoorReports({ selfInvocation: nodeRunning("process.stderr.write('agent-shim: no identity named ghost\\n'); process.exitCode = 1;"), env: {}, identityCount: () => 0, providers: () => [] });
    await expect(reports.doctorReport(new AbortController().signal)).rejects.toThrow("agent-shim: no identity named ghost");
  });

  it("refuses a report that does not match its schema", async () => {
    const reports = createDoorReports({ selfInvocation: nodeRunning("process.stdout.write('{\"ok\":\"yes\"}');"), env: {}, identityCount: () => 0, providers: () => [] });
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
    const reports = createDoorReports({ selfInvocation: hungChild, env: {}, identityCount: () => 0, providers: () => [], timeoutMs: SHORT_BOUND_MS, spawn: recorded.spawn });
    await expect(reports.doctorReport(new AbortController().signal)).rejects.toThrow(`did not report within ${String(SHORT_BOUND_MS)}ms`);
    const pid = recorded.children[0]?.pid;
    if (pid === undefined) {
      throw new Error("the child did not start");
    }
    expect(await gone(pid)).toBe(true);
  });

  it("kills the child of a request whose client went away", async () => {
    const recorded = recordingSpawn();
    const reports = createDoorReports({ selfInvocation: hungChild, env: {}, identityCount: () => 0, providers: () => [], timeoutMs: LONG_BOUND_MS, spawn: recorded.spawn });
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
      const reports = createDoorReports({ selfInvocation: hungChild, env: {}, identityCount: () => 0, providers: () => [], timeoutMs: abort ? LONG_BOUND_MS : SHORT_BOUND_MS, spawn: recorded.spawn });
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
    const reports = createDoorReports({ selfInvocation: spawnsGrandchild, env: {}, identityCount: () => 0, providers: () => [], timeoutMs: LONG_BOUND_MS });
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
    const reports = createDoorReports({ selfInvocation: endless, env: {}, identityCount: () => 0, providers: () => [], timeoutMs: LONG_BOUND_MS, stdoutLimitBytes: limit, spawn: recorded.spawn });
    await expect(reports.doctorReport(new AbortController().signal)).rejects.toThrow(`printed more than ${String(limit)} bytes`);
    const pid = recorded.children[0]?.pid;
    if (pid === undefined) {
      throw new Error("the child did not start");
    }
    expect(await gone(pid)).toBe(true);
  });

  it("names what the child wrote to stderr when its stdout is not JSON", async () => {
    const reports = createDoorReports({ selfInvocation: nodeRunning("process.stderr.write('warning: the keychain is locked\\n'); process.stdout.write('not json at all');"), env: {}, identityCount: () => 0, providers: () => [] });
    const failure = await reports.doctorReport(new AbortController().signal).catch((caught: unknown) => caught);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("agent-shim doctor --json printed output that is not JSON");
    expect((failure as Error).message).toContain("warning: the keychain is locked");
  });

  it("keeps only the end of a long stderr in what it reports", async () => {
    const reports = createDoorReports({ selfInvocation: nodeRunning("process.stderr.write('FIRST' + 'x'.repeat(100000) + 'LAST'); process.exitCode = 3;"), env: {}, identityCount: () => 0, providers: () => [] });
    const failure = await reports.doctorReport(new AbortController().signal).catch((caught: unknown) => caught);
    expect((failure as Error).message).toContain("LAST");
    expect((failure as Error).message).not.toContain("FIRST");
  });
});
