import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

import { REPLACEMENT_REASONS, exitNowLine, replacementLine, retireLine, retireOnSignals, type DoorExitFacts } from "./replacement";

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

describe("the door's signal lines", () => {
  it("names the signal, the tunnels the door will keep running, the sessions registered, the protocol and the uptime", () => {
    expect(retireLine(DOOR_PID, "SIGTERM", FACTS)).toBe("frontdoor 22: received SIGTERM; retiring; tunnelsOpen=7 liveSessions=3 protocol=5 uptimeSeconds=120");
  });

  it("names the tunnels a second signal drops", () => {
    expect(exitNowLine(DOOR_PID, "SIGTERM", FACTS)).toBe("frontdoor 22: received SIGTERM again; exiting now; tunnelsDropped=7 liveSessions=3");
  });
});

describe("retireOnSignals", () => {
  function harness(facts: () => DoorExitFacts = () => FACTS) {
    const source = new EventEmitter();
    const events: string[] = [];
    retireOnSignals(source, {
      doorPid: DOOR_PID,
      facts,
      log: (line) => {
        events.push(`log ${line}`);
      },
      retire: () => {
        events.push("retire");
      },
      exit: (code) => {
        events.push(`exit ${String(code)}`);
      },
    });
    return { source, events };
  }

  it("logs and starts the retirement on the first signal, without exiting", () => {
    const { source, events } = harness();
    source.emit("SIGTERM");
    expect(events).toEqual([`log ${retireLine(DOOR_PID, "SIGTERM", FACTS)}`, "retire"]);
  });

  it("logs and exits at once on any further signal, whichever of the two it is", () => {
    const { source, events } = harness();
    source.emit("SIGTERM");
    source.emit("SIGINT");
    expect(events).toEqual([`log ${retireLine(DOOR_PID, "SIGTERM", FACTS)}`, "retire", `log ${exitNowLine(DOOR_PID, "SIGINT", FACTS)}`, "exit 0"]);
  });

  it("reads the facts when the signal arrives, not when the handler is installed", () => {
    let tunnels = 0;
    const { source, events } = harness(() => ({ ...FACTS, tunnels }));
    tunnels = TUNNELS_AT_SIGNAL;
    source.emit("SIGTERM");
    expect(events[0]).toContain(`tunnelsOpen=${String(TUNNELS_AT_SIGNAL)}`);
  });
});
