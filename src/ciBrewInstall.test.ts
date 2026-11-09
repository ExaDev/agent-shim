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
  --prefix) echo "$FAKE_PREFIX"; exit 0 ;;
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
    // The installed binary, as `$(brew --prefix)/bin/agent-shim`: it reports FAKE_REPORTS, or fails to run when that is "crash".
    const prefix = path.join(world, "prefix");
    fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });
    fs.writeFileSync(path.join(prefix, "bin", "agent-shim"), '#!/bin/sh\nif [ "$FAKE_REPORTS" = crash ]; then echo "segfault" >&2; exit 139; fi\necho "${FAKE_REPORTS-$FAKE_INSTALLED}"\n', { mode: 0o755 });
    const result = spawnSync("bash", [SCRIPT, "ExaDev/agent-shim", "ExaDev/agent-shim/agent-shim", EXPECTED], {
      encoding: "utf8",
      env: { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, FAKE_BREW_CALLS: calls, FAKE_TAP_DIR: tapDir, FAKE_PREFIX: prefix, ...env },
    });
    return { status: result.status, output: `${result.stdout}${result.stderr}`, calls: fs.readFileSync(calls, "utf8") };
  }

  const BROKEN_PIPE_LINE = "exadev/agent-shim/agent-shim: Broken pipe";

  it("succeeds, and prints brew's output, when tap and install succeed and the installed binary reports the released version", () => {
    const result = run({ FAKE_TAP_OUT: "Tapped 1 formula", FAKE_INSTALL_OUT: "Installing agent-shim", FAKE_INSTALLED: EXPECTED });
    expect(result.status).toBe(0);
    expect(result.output).toContain("Tapped 1 formula");
    expect(result.output).toContain("Installing agent-shim");
    expect(result.output).toContain(`agent-shim ${EXPECTED} is installed and reports its version`);
  });

  it("counts the failing run's own signature (exit 1 and brew's own broken pipe line) as done when the install is there at the released version", () => {
    const result = run({ FAKE_INSTALL_STATUS: "1", FAKE_INSTALL_OUT: BROKEN_PIPE_LINE, FAKE_INSTALLED: EXPECTED });
    expect(result.status).toBe(0);
    expect(result.output).toContain("broken pipe");
    expect(result.output).toContain("reports its version");
  });

  it("fails a broken pipe with no usable install: nothing installed, another version listed, or a binary that reports another version or does not run", () => {
    const cases: readonly { readonly name: string; readonly env: Record<string, string>; readonly says: string }[] = [
      { name: "nothing installed", env: { FAKE_INSTALLED: "" }, says: "expected agent-shim 12.2.0 to be installed, brew lists: nothing" },
      { name: "another version listed", env: { FAKE_INSTALLED: "12.1.0" }, says: "brew lists: agent-shim 12.1.0" },
      { name: "a binary reporting another version", env: { FAKE_INSTALLED: EXPECTED, FAKE_REPORTS: "12.1.0" }, says: "reports version 12.1.0, expected 12.2.0" },
      { name: "a binary that does not run", env: { FAKE_INSTALLED: EXPECTED, FAKE_REPORTS: "crash" }, says: "does not run" },
    ];
    for (const { name, env, says } of cases) {
      const result = run({ FAKE_INSTALL_STATUS: "1", FAKE_INSTALL_OUT: BROKEN_PIPE_LINE, ...env });
      expect(result.status, name).toBe(1);
      expect(result.output, name).toContain(says);
    }
  });

  it("fails an install that exited 0 but left a binary reporting another version, which brew's status cannot show", () => {
    const result = run({ FAKE_INSTALLED: EXPECTED, FAKE_REPORTS: "12.1.0" });
    expect(result.status).toBe(1);
    expect(result.output).toContain("reports version 12.1.0");
  });

  it("never swallows another failure, with brew's output printed, even when the expected version happens to be installed", () => {
    for (const out of ["Error: No available formula", "exadev/agent-shim/other: Broken pipe", "agent-shim: Broken pipe while fetching", "Broken pipe"]) {
      const result = run({ FAKE_INSTALL_STATUS: "1", FAKE_INSTALL_ERR: out, FAKE_INSTALLED: EXPECTED });
      expect(result.status, out).toBe(1);
      expect(result.output, out).toContain(out);
      expect(result.output, out).toContain("brew install ExaDev/agent-shim/agent-shim failed with status 1");
    }
  });

  it("does not take exit 141 from the install for the broken pipe it prints, since that is the tap's case", () => {
    const result = run({ FAKE_INSTALL_STATUS: String(SIGPIPE_STATUS), FAKE_INSTALLED: EXPECTED });
    expect(result.status).toBe(SIGPIPE_STATUS);
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
