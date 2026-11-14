import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/*
 * What this file enforces is the dial smoke script's reading of `doctor --json`, over stub binaries under pwsh: a valid report (the live provider reachable, the closed port reported unreachable) passes; the live provider reported unreachable fails; the closed port left unreported fails; no report at all fails.
 *
 * It does not guard the script's explicit `exit 0`: the stub cannot make a POSIX host's `pwsh -Command` end with a leftover non-zero status the way the Windows runner's did, so only the Windows smoke jobs show whether that line is needed.
 */

const SCRIPT = path.join(__dirname, "..", ".github", "actions", "dial-smoke", "dial-smoke.ps1");

/** The longest the script's own run (a few process starts under pwsh) takes on a loaded machine, a bound on the test and not a result. */
const RUN_BUDGET_MS = 120_000;

/** Whether `pwsh` is on the path, which every hosted runner has and a developer's machine may not. */
const HAS_PWSH = spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"], { encoding: "utf8" }).status === 0;

/**
 * A stand-in for the built binary, as a shell script: `provider add` succeeds; `doctor --json` prints a report by `STUB_MODE` and exits 1, as the real doctor does for findings unrelated to a runner; and `locked` leaves a directory the script's cleanup cannot remove, as a file Windows still holds does.
 */
const STUB = `#!/bin/sh
case "$1" in
  provider) mkdir -p "$AGENT_SHIM_HOME/locked" && : > "$AGENT_SHIM_HOME/locked/held" && chmod 500 "$AGENT_SHIM_HOME/locked"; exit 0 ;;
esac
case "$STUB_MODE" in
  valid) printf '{"findings":[{"section":"provider","severity":"pass","subject":"smoke-live","message":"ok"},{"section":"provider","severity":"fail","subject":"smoke-closed","message":"could not connect"}],"ok":false}\\n' ;;
  live-unreachable) printf '{"findings":[{"section":"provider","severity":"fail","subject":"smoke-live","message":"could not connect"},{"section":"provider","severity":"fail","subject":"smoke-closed","message":"could not connect"}],"ok":false}\\n' ;;
  closed-unreported) printf '{"findings":[{"section":"provider","severity":"pass","subject":"smoke-live","message":"ok"}],"ok":false}\\n' ;;
  none) echo "agent-shim: died before reporting" >&2 ;;
esac
exit 1
`;

describe.skipIf(process.platform === "win32" || !HAS_PWSH)("the dial smoke script's reading of the doctor report, over a stub binary under pwsh", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      // The stub leaves a directory the script's own cleanup cannot remove, so its permissions are restored before the test's.
      spawnSync("chmod", ["-R", "u+rwx", root]);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  /** Runs the script over the stub in `mode` the way the action's `shell: pwsh` does (`-command ". '<script>'"`), returning its exit status. */
  function run(mode: string): number | null {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dial-smoke-test-"));
    roots.push(root);
    const stub = path.join(root, "agent-shim-stub.sh");
    fs.writeFileSync(stub, STUB, { mode: 0o755 });
    // The script makes its own home directory under the temporary directory, which is pointed inside `root` so what the stub leaves there is the test's to remove.
    const temporary = path.join(root, "tmp");
    fs.mkdirSync(temporary);
    const result = spawnSync("pwsh", ["-NoProfile", "-Command", `. '${SCRIPT}' -Binary '${stub}'`], { encoding: "utf8", env: { ...process.env, STUB_MODE: mode, TMPDIR: temporary } });
    return result.status;
  }

  it("passes on a report that has the live provider reachable and the closed port unreachable, whatever status the stub doctor exits with", () => {
    expect(run("valid")).toBe(0);
  }, RUN_BUDGET_MS);

  it.each(["live-unreachable", "closed-unreported", "none"])("fails on the report shape %s", (mode) => {
    expect(run(mode)).not.toBe(0);
  }, RUN_BUDGET_MS);
});
