import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = path.join(__dirname, "..", ".github", "actions", "brew-install", "install.sh");
const EXPECTED = "12.2.0";
const SIGPIPE_STATUS = 141;

/**
 * The two real failing lines, as the runner printed them, so a fake brew's transcript is taken from a real failure and the next real signature is a one-line fixture. The runner shows brew's `::error::<message>` annotation as `##[error]<message>`.
 * Install: run 42461478176 (the v12.2.0 release commit), job "Verify Homebrew install (Linux, ubuntu-24.04-arm)": `##[error]exadev/agent-shim/agent-shim: Broken pipe`, exit 1.
 * Tap: run 42736184177 (the v14.0.2 release), same job: `Tapped 1 formula (16 files, 365.8KB).` then `##[error]Broken pipe`, exit 1, with the tap cloned.
 */
const REAL_INSTALL_LINE = "##[error]exadev/agent-shim/agent-shim: Broken pipe";
const REAL_TAP_LINE = "##[error]Broken pipe";
const REAL_TAP_PRECEDING_LINE = "Tapped 1 formula (16 files, 365.8KB).";
/** The message inside the runner's `##[error]` rendering, which is what brew's `onoe` was given. */
const messageOf = (runnerLine: string): string => runnerLine.replace(/^##\[error\]/, "");

/** A `brew` that behaves as the case says, recording its calls: each subcommand's exit status and output come from the environment, and `list --versions` answers what is "installed". */
function fakeBrew(dir: string): string {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, "brew"),
    `#!/bin/sh
echo "$@" >> "$FAKE_BREW_CALLS"
case "$1" in
  tap)
    echo "$FAKE_TAP_OUT"
    # brew's onoe line for the tap, rendered as brew renders it: an Actions annotation under Actions, "Error: " elsewhere.
    if [ -n "$FAKE_TAP_OFAIL" ]; then
      if [ "$GITHUB_ACTIONS" = true ]; then echo "::error::$FAKE_TAP_OFAIL" >&2
      elif [ -n "$HOMEBREW_COLOR" ]; then printf '\\033[31mError:\\033[0m %s\\n' "$FAKE_TAP_OFAIL" >&2
      else echo "Error: $FAKE_TAP_OFAIL" >&2; fi
    fi
    exit "\${FAKE_TAP_STATUS:-0}" ;;
  install)
    echo "$FAKE_INSTALL_OUT"
    echo "$FAKE_INSTALL_ERR" >&2
    # brew's ofail line, as brew renders it: an Actions annotation under Actions, "Error: " elsewhere.
    if [ -n "$FAKE_OFAIL" ]; then
      if [ "$GITHUB_ACTIONS" = true ]; then echo "::error::$FAKE_OFAIL" >&2
      elif [ -n "$HOMEBREW_COLOR" ]; then printf '\\033[31mError:\\033[0m %s\\n' "$FAKE_OFAIL" >&2
      else echo "Error: $FAKE_OFAIL" >&2; fi
    fi
    exit "\${FAKE_INSTALL_STATUS:-0}" ;;
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
  function run(env: Readonly<Record<string, string>>, tap: "complete" | "absent" | "no-commit" | "no-formula" = "complete"): { readonly status: number | null; readonly output: string; readonly calls: string } {
    const world = fs.mkdtempSync(path.join(dir, "run-"));
    const bin = fakeBrew(world);
    const tapDir = path.join(world, "tap");
    if (tap !== "absent") {
      fs.mkdirSync(path.join(tapDir, "Formula"), { recursive: true });
      const git = (...args: readonly string[]): void => {
        spawnSync("git", ["-C", tapDir, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: world } });
      };
      git("init", "-q");
      if (tap !== "no-formula") {
        fs.writeFileSync(path.join(tapDir, "Formula", "agent-shim.rb"), "class AgentShim < Formula\nend\n");
      }
      if (tap !== "no-commit") {
        git("add", "-A");
        git("commit", "-q", "--allow-empty", "-m", "tap");
      }
    }
    const calls = path.join(world, "calls");
    fs.writeFileSync(calls, "");
    // The installed binary, as `$(brew --prefix)/bin/agent-shim`: it reports FAKE_REPORTS, or fails to run when that is "crash".
    const prefix = path.join(world, "prefix");
    fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });
    fs.writeFileSync(path.join(prefix, "bin", "agent-shim"), '#!/bin/sh\nif [ "$FAKE_REPORTS" = crash ]; then echo "segfault" >&2; exit 139; fi\nif [ -n "$FAKE_WARNING" ]; then echo "$FAKE_WARNING" >&2; fi\necho "${FAKE_REPORTS-$FAKE_INSTALLED}"\n', { mode: 0o755 });
    const result = spawnSync("bash", [SCRIPT, "ExaDev/agent-shim", "ExaDev/agent-shim/agent-shim"], {
      encoding: "utf8",
      env: { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, FAKE_BREW_CALLS: calls, FAKE_TAP_DIR: tapDir, FAKE_PREFIX: prefix, RELEASE_TAG: `v${EXPECTED}`, ...env },
    });
    return { status: result.status, output: `${result.stdout}${result.stderr}`, calls: fs.readFileSync(calls, "utf8") };
  }

  const OFAIL = "exadev/agent-shim/agent-shim: Broken pipe";
  const ENVIRONMENTS: readonly { readonly name: string; readonly env: Record<string, string> }[] = [
    { name: "under Actions, where brew writes ::error::", env: { GITHUB_ACTIONS: "true", CI: "true" } },
    { name: "outside Actions, where brew writes Error: ", env: { GITHUB_ACTIONS: "", CI: "" } },
    { name: "outside Actions with colour on, where brew writes Error: in red", env: { GITHUB_ACTIONS: "", CI: "", HOMEBREW_COLOR: "1" } },
  ];

  it("counts the failing run's own signature as done in each of brew's two renderings, when the install is there at the released version", () => {
    for (const { name, env } of ENVIRONMENTS) {
      const result = run({ ...env, FAKE_INSTALL_STATUS: "1", FAKE_OFAIL: OFAIL, FAKE_INSTALLED: EXPECTED });
      expect(result.status, name).toBe(0);
      expect(result.output, name).toContain("broken pipe");
      expect(result.output, name).toContain("reports its version");
    }
  });

  it("fails a broken pipe with no usable install, in each rendering: nothing installed, another version listed, a binary reporting another version or not running", () => {
    const cases: readonly { readonly name: string; readonly env: Record<string, string>; readonly says: string }[] = [
      { name: "nothing installed", env: { FAKE_INSTALLED: "" }, says: "expected agent-shim 12.2.0 to be installed, brew lists: nothing" },
      { name: "another version listed", env: { FAKE_INSTALLED: "12.1.0" }, says: "brew lists: agent-shim 12.1.0" },
      { name: "a binary reporting another version", env: { FAKE_INSTALLED: EXPECTED, FAKE_REPORTS: "12.1.0" }, says: "reports version 12.1.0, expected 12.2.0" },
      { name: "a binary that does not run", env: { FAKE_INSTALLED: EXPECTED, FAKE_REPORTS: "crash" }, says: "does not run" },
    ];
    for (const rendering of ENVIRONMENTS) {
      for (const { name, env, says } of cases) {
        const result = run({ ...rendering.env, FAKE_INSTALL_STATUS: "1", FAKE_OFAIL: OFAIL, ...env });
        expect(result.status, `${rendering.name}: ${name}`).toBe(1);
        expect(result.output, `${rendering.name}: ${name}`).toContain(says);
      }
    }
  });

  it("does not take a near miss for the signature, with the expected version installed: another formula, another prefix, trailing text, a bare Broken pipe, or the line inside other text", () => {
    const nearMisses = [
      "::error::exadev/agent-shim/other: Broken pipe",
      "Warning: exadev/agent-shim/agent-shim: Broken pipe",
      "##[error]exadev/agent-shim/agent-shim: Broken pipe",
      "::error::exadev/agent-shim/agent-shim: Broken pipe while fetching",
      "Error: exadev/agent-shim/agent-shim: Broken pipe.",
      "agent-shim: Broken pipe",
      "saw exadev/agent-shim/agent-shim: Broken pipe in the output",
      "Error: No available formula",
      "\u001B[31mError:\u001B[0m exadev/agent-shim/other: Broken pipe",
      "\u001B[31mWarning:\u001B[0m exadev/agent-shim/agent-shim: Broken pipe",
      "\u001B[31mError:\u001B[0m exadev/agent-shim/agent-shim: Broken pipe now",
      "\u001B[Error: exadev/agent-shim/agent-shim: Broken pipe",
    ];
    for (const line of nearMisses) {
      const result = run({ FAKE_INSTALL_STATUS: "1", FAKE_INSTALL_ERR: line, FAKE_INSTALLED: EXPECTED });
      expect(result.status, line).toBe(1);
      expect(result.output, line).toContain(line);
      expect(result.output, line).toContain("brew install ExaDev/agent-shim/agent-shim failed with status 1");
    }
  });

  it("accepts the signature among other lines of output, and only with exit status 1", () => {
    const among = run({ GITHUB_ACTIONS: "true", FAKE_INSTALL_STATUS: "1", FAKE_INSTALL_OUT: "==> Installing agent-shim\nsome other line", FAKE_OFAIL: OFAIL, FAKE_INSTALLED: EXPECTED });
    expect(among.status).toBe(0);
    const another = run({ GITHUB_ACTIONS: "true", FAKE_INSTALL_STATUS: "2", FAKE_OFAIL: OFAIL, FAKE_INSTALLED: EXPECTED });
    expect(another.status).toBe(2);
  });

  it("compares the version from standard output alone, so a warning on standard error does not fail the step, and prints it when the version is wrong", () => {
    const warned = run({ FAKE_INSTALLED: EXPECTED, FAKE_WARNING: "(node:1) [DEP0040] DeprecationWarning: The punycode module is deprecated" });
    expect(warned.status).toBe(0);
    const wrong = run({ FAKE_INSTALLED: EXPECTED, FAKE_REPORTS: "12.1.0", FAKE_WARNING: "(node:1) DeprecationWarning: something" });
    expect(wrong.status).toBe(1);
    expect(wrong.output).toContain("DeprecationWarning: something");
  });

  it("needs the released tag in RELEASE_TAG, and takes a bare version too", () => {
    const missing = run({ RELEASE_TAG: "", FAKE_INSTALLED: EXPECTED });
    expect(missing.status).not.toBe(0);
    const bare = run({ RELEASE_TAG: EXPECTED, FAKE_INSTALLED: EXPECTED });
    expect(bare.status).toBe(0);
  });

  it("fails an install that exited 0 but left a binary reporting another version, which brew's status cannot show", () => {
    const result = run({ FAKE_INSTALLED: EXPECTED, FAKE_REPORTS: "12.1.0" });
    expect(result.status).toBe(1);
    expect(result.output).toContain("reports version 12.1.0");
  });

  it("does not take exit 141 from the install for the broken pipe it prints, since that is the tap's case", () => {
    const result = run({ FAKE_INSTALL_STATUS: String(SIGPIPE_STATUS), FAKE_INSTALLED: EXPECTED });
    expect(result.status).toBe(SIGPIPE_STATUS);
  });

  it("counts a tap that ended with exit 141 as done when the tap is in place, and fails when it is not", () => {
    const base = { FAKE_TAP_STATUS: String(SIGPIPE_STATUS), FAKE_INSTALLED: EXPECTED };
    expect(run(base).status).toBe(0);
    const absent = run(base, "absent");
    expect(absent.status).toBe(SIGPIPE_STATUS);
    expect(absent.output).toContain("brew tap ExaDev/agent-shim failed");
  });

  const TAP_MESSAGE = messageOf(REAL_TAP_LINE);
  const TAP_ENV = { FAKE_TAP_STATUS: "1", FAKE_TAP_OUT: REAL_TAP_PRECEDING_LINE, FAKE_TAP_OFAIL: TAP_MESSAGE, FAKE_INSTALLED: EXPECTED };

  it("counts the tap's own failing signature as done in each of brew's renderings, when the tap is in place", () => {
    for (const { name, env } of ENVIRONMENTS) {
      const result = run({ ...env, ...TAP_ENV });
      expect(result.status, name).toBe(0);
      expect(result.output, name).toContain("brew tap ended with a broken pipe");
      expect(result.calls, name).toContain("install");
    }
  });

  it("takes the install's real failing line and the tap's, each as the runner printed it, from the fixtures", () => {
    expect(REAL_INSTALL_LINE).toBe(`##[error]${OFAIL}`);
    expect(REAL_TAP_LINE).toBe(`##[error]${TAP_MESSAGE}`);
    expect(TAP_MESSAGE).toBe("Broken pipe");
  });

  it("fails the tap's signature when what the tap was for is not in place: no directory, no commit, no formula file", () => {
    for (const state of ["absent", "no-commit", "no-formula"] as const) {
      const result = run({ GITHUB_ACTIONS: "true", CI: "true", ...TAP_ENV }, state);
      expect(result.status, state).toBe(1);
      expect(result.output, state).toContain("brew tap ExaDev/agent-shim failed with status 1");
      expect(result.calls, state).not.toContain("install");
    }
  });

  it("does not take a near miss for the tap's signature, with the tap in place", () => {
    const nearMisses = [
      "::error::Broken pipe while cloning",
      "Error: Broken pipe.",
      "::error::broken pipe",
      "Warning: Broken pipe",
      "##[error]Broken pipe",
      "saw Broken pipe in the output",
      "Error: repository not found",
      "::error::exadev/agent-shim/agent-shim: Broken pipe",
      "\u001B[31mError:\u001B[0m Broken pipe now",
    ];
    for (const line of nearMisses) {
      const result = run({ FAKE_TAP_STATUS: "1", FAKE_TAP_OUT: line, FAKE_INSTALLED: EXPECTED });
      expect(result.status, line).toBe(1);
      expect(result.output, line).toContain(line);
      expect(result.calls, line).not.toContain("install");
    }
  });

  it("takes the message as a whole line without brew's prefix too, for the tap and for the install", () => {
    const tap = run({ FAKE_TAP_STATUS: "1", FAKE_TAP_OUT: TAP_MESSAGE, FAKE_INSTALLED: EXPECTED });
    expect(tap.status).toBe(0);
    const install = run({ FAKE_INSTALL_STATUS: "1", FAKE_INSTALL_OUT: OFAIL, FAKE_INSTALLED: EXPECTED });
    expect(install.status).toBe(0);
  });

  it("takes the bare message for the install too, in each rendering, since the top-level rescue prints it for any command, and still only another formula's prefix is a near miss", () => {
    for (const { name, env } of ENVIRONMENTS) {
      const bare = run({ ...env, FAKE_INSTALL_STATUS: "1", FAKE_OFAIL: TAP_MESSAGE, FAKE_INSTALLED: EXPECTED });
      expect(bare.status, name).toBe(0);
      expect(bare.output, name).toContain("brew install ended with a broken pipe");
    }
    const other = run({ GITHUB_ACTIONS: "true", FAKE_INSTALL_STATUS: "1", FAKE_OFAIL: "exadev/agent-shim/other: Broken pipe", FAKE_INSTALLED: EXPECTED });
    expect(other.status).toBe(1);
    const noInstall = run({ GITHUB_ACTIONS: "true", FAKE_INSTALL_STATUS: "1", FAKE_OFAIL: TAP_MESSAGE, FAKE_INSTALLED: "" });
    expect(noInstall.status).toBe(1);
    const statusTwo = run({ GITHUB_ACTIONS: "true", FAKE_INSTALL_STATUS: "2", FAKE_OFAIL: TAP_MESSAGE, FAKE_INSTALLED: EXPECTED });
    expect(statusTwo.status).toBe(2);
  });

  it("takes only exit status 1, or 141 for the tap, for the tap's signature", () => {
    for (const status of ["2", "127", "130"]) {
      const result = run({ GITHUB_ACTIONS: "true", ...TAP_ENV, FAKE_TAP_STATUS: status });
      expect(result.status, status).toBe(Number(status));
    }
  });

  it("accepts the tap's signature among other lines, and fails the tap's bare line under a status of 1 only when it is not a whole line", () => {
    const among = run({ GITHUB_ACTIONS: "true", ...TAP_ENV, FAKE_TAP_OUT: "==> Tapping exadev/agent-shim\nTapped 1 formula" });
    expect(among.status).toBe(0);
    const inside = run({ FAKE_TAP_STATUS: "1", FAKE_TAP_OUT: "the error was: Broken pipe", FAKE_INSTALLED: EXPECTED });
    expect(inside.status).toBe(1);
  });

  it("fails a tap that failed for another reason, though the tap is in place", () => {
    const result = run({ FAKE_TAP_STATUS: "1", FAKE_TAP_OUT: "Error: repository not found", FAKE_INSTALLED: EXPECTED });
    expect(result.status).toBe(1);
  });

  it("does not run the install when the tap failed", () => {
    const result = run({ FAKE_TAP_STATUS: "1", FAKE_TAP_OUT: "Error: repository not found" }, "absent");
    expect(result.calls).not.toContain("install");
  });
});
