import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

import { enterProcessRole } from "../processRole";
import { MAX_TIMER_DELAY_MS } from "../config/schema";
import { DEFAULT_PROVIDER_CONNECT_TIMEOUT_MS } from "../providerReachability";
import { PROBE_WAIT_MARGIN_MS } from "./probe";
import { REPORT_STARTUP_ALLOWANCE_MS, createDoorReports, reportChildTimeoutMs } from "./doorReports";

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
  /** Longer than any bound a report that allowed a fixed multiple of the default probe bound could have. */
  const SLOWEST_PROBE_MS = DEFAULT_PROVIDER_CONNECT_TIMEOUT_MS + REPORT_STARTUP_ALLOWANCE_MS;
  const SHORT_PROBE_MS = DEFAULT_PROVIDER_CONNECT_TIMEOUT_MS / 2;

  it("covers the longest probe bound among the providers, the wait margin and the start-up allowance", () => {
    expect(reportChildTimeoutMs([httpProvider(undefined), httpProvider(SLOWEST_PROBE_MS), httpProvider(SHORT_PROBE_MS)])).toBe(SLOWEST_PROBE_MS + PROBE_WAIT_MARGIN_MS + REPORT_STARTUP_ALLOWANCE_MS);
  });

  it("covers the default probe bound when no provider names one, or none is an http provider", () => {
    expect(reportChildTimeoutMs([])).toBe(DEFAULT_PROVIDER_CONNECT_TIMEOUT_MS + PROBE_WAIT_MARGIN_MS + REPORT_STARTUP_ALLOWANCE_MS);
    expect(reportChildTimeoutMs([{ kind: "codex", displayName: "c", credential: HTTP.credential }])).toBe(DEFAULT_PROVIDER_CONNECT_TIMEOUT_MS + PROBE_WAIT_MARGIN_MS + REPORT_STARTUP_ALLOWANCE_MS);
  });

  it("never exceeds the longest delay a timer takes, past which it would fire at once", () => {
    expect(reportChildTimeoutMs([httpProvider(MAX_TIMER_DELAY_MS)])).toBe(MAX_TIMER_DELAY_MS);
  });

  it("is the bound a report child is given, read from the providers as each request arrives", async () => {
    const delays: number[] = [];
    const real = globalThis.setTimeout;
    const timers = vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: () => void, delay?: number) => {
      delays.push(delay ?? 0);
      return real(handler, delay);
    }) as typeof setTimeout);
    let providers = [httpProvider(SLOWEST_PROBE_MS)];
    const reports = createDoorReports({ selfInvocation: nodeRunning("process.stdout.write('{}');"), env: {}, providers: () => providers });
    await reports.doctorReport(new AbortController().signal).catch(() => undefined);
    providers = [httpProvider(undefined)];
    await reports.doctorReport(new AbortController().signal).catch(() => undefined);
    timers.mockRestore();
    expect(delays).toContain(reportChildTimeoutMs([httpProvider(SLOWEST_PROBE_MS)]));
    expect(delays).toContain(reportChildTimeoutMs([httpProvider(undefined)]));
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
      providers: () => [],
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
      providers: () => [],
    });
    await expect(reports.checkReport("/work", "personal", new AbortController().signal)).rejects.toThrow();
    expect(asked).toEqual([["check", "/work", "--identity", "personal", "--json"]]);
  });

  it("fails with what the child said when it printed no report", async () => {
    const reports = createDoorReports({ selfInvocation: nodeRunning("process.stderr.write('agent-shim: no identity named ghost\\n'); process.exitCode = 1;"), env: {}, providers: () => [] });
    await expect(reports.doctorReport(new AbortController().signal)).rejects.toThrow("agent-shim: no identity named ghost");
  });

  it("refuses a report that does not match its schema", async () => {
    const reports = createDoorReports({ selfInvocation: nodeRunning("process.stdout.write('{\"ok\":\"yes\"}');"), env: {}, providers: () => [] });
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
    const reports = createDoorReports({ selfInvocation: hungChild, env: {}, providers: () => [], timeoutMs: SHORT_BOUND_MS, spawn: recorded.spawn });
    await expect(reports.doctorReport(new AbortController().signal)).rejects.toThrow(`did not report within ${String(SHORT_BOUND_MS)}ms`);
    const pid = recorded.children[0]?.pid;
    if (pid === undefined) {
      throw new Error("the child did not start");
    }
    expect(await gone(pid)).toBe(true);
  });

  it("kills the child of a request whose client went away", async () => {
    const recorded = recordingSpawn();
    const reports = createDoorReports({ selfInvocation: hungChild, env: {}, providers: () => [], timeoutMs: LONG_BOUND_MS, spawn: recorded.spawn });
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
});
