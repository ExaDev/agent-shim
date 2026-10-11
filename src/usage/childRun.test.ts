import { describe, expect, it } from "vitest";

import { buildLayoutPaths } from "../paths";
import { runChild } from "./childRun";

const paths = buildLayoutPaths("/state");
const node = (script: string) => (): { readonly command: string; readonly args: readonly string[] } => ({ command: process.execPath, args: ["-e", script] });

describe("runChild", () => {
  it("resolves when the child exits 0", async () => {
    await expect(runChild({ paths, args: [], timeoutMs: 5000, invocation: node("process.exit(0)") })).resolves.toBeUndefined();
  });

  it("rejects with the child's standard error when it exits non-zero", async () => {
    await expect(runChild({ paths, args: [], timeoutMs: 5000, invocation: node("console.error('signed out'); process.exit(1)") })).rejects.toThrow("signed out");
  });

  it("rejects naming the exit code when the child fails silently", async () => {
    await expect(runChild({ paths, args: [], timeoutMs: 5000, invocation: node("process.exit(3)") })).rejects.toThrow("exit code 3");
  });

  it("rejects when the executable cannot be started", async () => {
    await expect(runChild({ paths, args: [], timeoutMs: 5000, invocation: () => ({ command: "/nonexistent/agent-shim", args: [] }) })).rejects.toThrow();
  });

  it("passes the state root to the child so it works on the same state as the door", async () => {
    await expect(runChild({ paths, args: [], timeoutMs: 5000, invocation: node("if (process.env.AGENT_SHIM_HOME !== '/state') { console.error('wrong root ' + process.env.AGENT_SHIM_HOME); process.exit(1) }") })).resolves.toBeUndefined();
  });
});
