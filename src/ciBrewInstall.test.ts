import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = path.join(__dirname, "..", ".github", "actions", "brew-install", "install.sh");
const EXPECTED = "12.2.0";
const SIGPIPE_STATUS = 141;

/** A `brew` that behaves as the case says, recording its calls: each subcommand's exit status and output come from the environment, and `list --versions` answers what is "installed". */
function fakeBrew(dir: string): string {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, "brew"),
    `#!/bin/sh
echo "$@" >> "$FAKE_BREW_CALLS"
case "$1" in
  tap) echo "$FAKE_TAP_OUT"; exit "\${FAKE_TAP_STATUS:-0}" ;;
  install) echo "$FAKE_INSTALL_OUT"; echo "$FAKE_INSTALL_ERR" >&2; exit "\${FAKE_INSTALL_STATUS:-0}" ;;
  list) if [ -n "$FAKE_INSTALLED" ]; then echo "agent-shim $FAKE_INSTALLED"; fi; exit 0 ;;
  --repository) echo "$FAKE_TAP_DIR"; exit 0 ;;
esac
`,
    { mode: 0o755 },
  );
  return bin;
}

describe("the Homebrew install step", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-brew-install-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Runs the step against a fake brew; `tapPresent` says whether the tap directory exists afterwards. */
  function run(env: Readonly<Record<string, string>>, tapPresent = true): { readonly status: number | null; readonly output: string; readonly calls: string } {
    const world = fs.mkdtempSync(path.join(dir, "run-"));
    const bin = fakeBrew(world);
    const tapDir = path.join(world, "tap");
    if (tapPresent) {
      fs.mkdirSync(tapDir);
    }
    const calls = path.join(world, "calls");
    fs.writeFileSync(calls, "");
    const result = spawnSync("bash", [SCRIPT, "ExaDev/agent-shim", "ExaDev/agent-shim/agent-shim", EXPECTED], {
      encoding: "utf8",
      env: { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, FAKE_BREW_CALLS: calls, FAKE_TAP_DIR: tapDir, ...env },
    });
    return { status: result.status, output: `${result.stdout}${result.stderr}`, calls: fs.readFileSync(calls, "utf8") };
  }

  it("succeeds, and prints brew's output, when tap and install succeed", () => {
    const result = run({ FAKE_TAP_OUT: "Tapped 1 formula", FAKE_INSTALL_OUT: "Installing agent-shim", FAKE_INSTALLED: EXPECTED });
    expect(result.status).toBe(0);
    expect(result.output).toContain("Tapped 1 formula");
    expect(result.output).toContain("Installing agent-shim");
  });

  it("counts an install that ended with a Ruby broken pipe as done when the expected version is installed", () => {
    const result = run({ FAKE_INSTALL_STATUS: "1", FAKE_INSTALL_ERR: "exadev/agent-shim/agent-shim: Broken pipe", FAKE_INSTALLED: EXPECTED });
    expect(result.status).toBe(0);
    expect(result.output).toContain("broken pipe");
  });

  it("fails a broken pipe that left nothing installed, or another version", () => {
    for (const installed of ["", "12.1.0"]) {
      const result = run({ FAKE_INSTALL_STATUS: "1", FAKE_INSTALL_ERR: "exadev/agent-shim/agent-shim: Broken pipe", FAKE_INSTALLED: installed });
      expect(result.status, installed).toBe(1);
      expect(result.output, installed).toContain("brew install ExaDev/agent-shim/agent-shim failed");
    }
  });

  it("never swallows another failure, even when the expected version happens to be installed", () => {
    const result = run({ FAKE_INSTALL_STATUS: "1", FAKE_INSTALL_ERR: "Error: No available formula", FAKE_INSTALLED: EXPECTED });
    expect(result.status).toBe(1);
    expect(result.output).toContain("No available formula");
  });

  it("counts a tap that ended with exit 141 as done when the tap directory exists, and fails when it does not", () => {
    const base = { FAKE_TAP_STATUS: String(SIGPIPE_STATUS), FAKE_INSTALLED: EXPECTED };
    expect(run(base, true).status).toBe(0);
    const absent = run(base, false);
    expect(absent.status).toBe(SIGPIPE_STATUS);
    expect(absent.output).toContain("brew tap ExaDev/agent-shim failed");
  });

  it("fails a tap that failed for another reason, though the directory exists", () => {
    const result = run({ FAKE_TAP_STATUS: "1", FAKE_TAP_OUT: "Error: repository not found", FAKE_INSTALLED: EXPECTED }, true);
    expect(result.status).toBe(1);
  });

  it("does not run the install when the tap failed", () => {
    const result = run({ FAKE_TAP_STATUS: "1", FAKE_TAP_OUT: "Error: repository not found" }, false);
    expect(result.calls).not.toContain("install");
  });
});
