import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

import { REPLACEMENT_REASONS, exitLine, exitLoggingOnSignals, replacementLine, type DoorExitFacts } from "./replacement";

const FACTS: DoorExitFacts = { tunnels: 7, liveSessions: 3, protocol: 5, uptimeSeconds: 120 };
const DOOR_PID = 22;
const OLDER_PROTOCOL = 4;
const TUNNELS_AT_SIGNAL = 4;

describe("replacementLine", () => {
  it("is one key=value line naming the reason, both pids, both protocols and the sessions cut off", () => {
    expect(replacementLine({ reason: "protocol-older", signal: "SIGTERM", launcherPid: 11, launcherProtocol: 5, doorPid: DOOR_PID, doorProtocol: OLDER_PROTOCOL, liveSessions: 9 })).toBe(
      "launcher 11: replacing front door; reason=protocol-older signal=SIGTERM door=22 doorProtocol=4 launcherProtocol=5 liveSessions=9",
    );
  });

  it("is a single line for every reason in the closed set", () => {
    for (const reason of REPLACEMENT_REASONS) {
      expect(replacementLine({ reason, signal: "SIGKILL", launcherPid: 1, launcherProtocol: 1, doorPid: 2, doorProtocol: 0, liveSessions: 0 })).not.toContain("\n");
    }
  });
});

describe("exitLine", () => {
  it("names the signal, the tunnels the exit drops, the sessions registered, the protocol and the uptime", () => {
    expect(exitLine(DOOR_PID, "SIGTERM", FACTS)).toBe("frontdoor 22: received SIGTERM; exiting; tunnelsDropped=7 liveSessions=3 protocol=5 uptimeSeconds=120");
  });
});

describe("exitLoggingOnSignals", () => {
  it("logs the door's state and only then exits, for SIGTERM and for SIGINT", () => {
    const source = new EventEmitter();
    const events: string[] = [];
    exitLoggingOnSignals(source, {
      doorPid: DOOR_PID,
      facts: () => FACTS,
      log: (line) => {
        events.push(`log ${line}`);
      },
      exit: (code) => {
        events.push(`exit ${String(code)}`);
      },
    });
    source.emit("SIGTERM");
    source.emit("SIGINT");
    expect(events).toEqual([`log ${exitLine(DOOR_PID, "SIGTERM", FACTS)}`, "exit 0", `log ${exitLine(DOOR_PID, "SIGINT", FACTS)}`, "exit 0"]);
  });

  it("reads the facts when the signal arrives, not when the handler is installed", () => {
    const source = new EventEmitter();
    const lines: string[] = [];
    let tunnels = 0;
    exitLoggingOnSignals(source, {
      doorPid: 1,
      facts: () => ({ ...FACTS, tunnels }),
      log: (line) => {
        lines.push(line);
      },
      exit: () => undefined,
    });
    tunnels = TUNNELS_AT_SIGNAL;
    source.emit("SIGTERM");
    expect(lines[0]).toContain(`tunnelsDropped=${String(TUNNELS_AT_SIGNAL)}`);
  });
});
