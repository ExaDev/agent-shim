import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

import { REPLACEMENT_REASONS, alreadyHandingOverLine, alreadyRetiringLine, exitNowLine, handOverOnSignal, handoverLine, replacementLine, retireLine, retireOnSignals, type DoorExitFacts } from "./replacement";

const FACTS: DoorExitFacts = { tunnels: 7, liveSessions: 3, protocol: 5, uptimeSeconds: 120 };
const DOOR_PID = 22;
const OLDER_PROTOCOL = 4;
const TUNNELS_AT_SIGNAL = 4;
/** The log line and the exit that a second interrupt produces. */
const EXIT_NOW_EVENTS = 2;

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

  it("names the tunnels a second interrupt drops", () => {
    expect(exitNowLine(DOOR_PID, FACTS)).toBe("frontdoor 22: received SIGINT again; exiting now; tunnelsDropped=7 liveSessions=3");
  });

  it("names a handover request with the same counts as a retirement", () => {
    expect(handoverLine(DOOR_PID, FACTS)).toBe("frontdoor 22: received SIGUSR2; handing the listeners to a successor; tunnelsOpen=7 liveSessions=3 protocol=5 uptimeSeconds=120");
  });

  it("says a repeated handover request changed nothing", () => {
    expect(alreadyHandingOverLine(DOOR_PID)).toBe("frontdoor 22: received SIGUSR2 again; already handing over or retiring");
  });

  it("says a repeated SIGTERM changed nothing", () => {
    expect(alreadyRetiringLine(DOOR_PID)).toBe("frontdoor 22: received SIGTERM again; already retiring");
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

  it("ignores a repeated SIGTERM, since two launchers that read the state before it changed each send one", () => {
    const { source, events } = harness();
    source.emit("SIGTERM");
    source.emit("SIGTERM");
    source.emit("SIGTERM");
    expect(events).toEqual([`log ${retireLine(DOOR_PID, "SIGTERM", FACTS)}`, "retire", `log ${alreadyRetiringLine(DOOR_PID)}`, `log ${alreadyRetiringLine(DOOR_PID)}`]);
  });

  it("exits at once on an interrupt after the retirement began, whichever signal began it", () => {
    for (const first of ["SIGTERM", "SIGINT"]) {
      const { source, events } = harness();
      source.emit(first);
      source.emit("SIGINT");
      expect(events.slice(events.length - EXIT_NOW_EVENTS)).toEqual([`log ${exitNowLine(DOOR_PID, FACTS)}`, "exit 0"]);
    }
  });

  it("reads the facts when the signal arrives, not when the handler is installed", () => {
    let tunnels = 0;
    const { source, events } = harness(() => ({ ...FACTS, tunnels }));
    tunnels = TUNNELS_AT_SIGNAL;
    source.emit("SIGTERM");
    expect(events[0]).toContain(`tunnelsOpen=${String(TUNNELS_AT_SIGNAL)}`);
  });
});

describe("handOverOnSignal", () => {
  function harness() {
    const source = new EventEmitter();
    const events: string[] = [];
    handOverOnSignal(source, {
      doorPid: DOOR_PID,
      facts: () => FACTS,
      log: (line) => {
        events.push(`log ${line}`);
      },
      handOver: () => {
        events.push("hand over");
      },
    });
    return { source, events };
  }

  it("logs and starts the handover on the first SIGUSR2", () => {
    const { source, events } = harness();
    source.emit("SIGUSR2");
    expect(events).toEqual([`log ${handoverLine(DOOR_PID, FACTS)}`, "hand over"]);
  });

  it("starts one handover however many requests arrive, since two launchers that read the state before the successor rewrote it each send one", () => {
    const { source, events } = harness();
    source.emit("SIGUSR2");
    source.emit("SIGUSR2");
    expect(events).toEqual([`log ${handoverLine(DOOR_PID, FACTS)}`, "hand over", `log ${alreadyHandingOverLine(DOOR_PID)}`]);
  });
});
