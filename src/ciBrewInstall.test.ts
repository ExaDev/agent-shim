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
      "Broken pipe",
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
