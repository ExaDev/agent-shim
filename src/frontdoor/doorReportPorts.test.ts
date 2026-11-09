import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { BlockingInEventLoopError, enterProcessRole } from "../processRole";
import { DoorReportUnavailableError } from "./controlApi";
import { doorReportPorts } from "./doorReportPorts";

let leaveRole: (() => void) | undefined;

afterEach(() => {
  leaveRole?.();
  leaveRole = undefined;
});

describe("the command line door's report dependencies", () => {
  it("fail as unavailable, never as a blocking step the door's event loop refuses, whatever the configuration", () => {
    leaveRole = enterProcessRole("frontdoor-supervisor");
    // They collect nothing, so the configuration (an http provider among it, or none) is never read.
    for (const attempt of [() => doorReportPorts.checkReport("/work"), () => doorReportPorts.checkReport("/work", "personal"), () => doorReportPorts.doctorReport()]) {
      let thrown: unknown;
      try {
        attempt();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(DoorReportUnavailableError);
      expect(thrown).not.toBeInstanceOf(BlockingInEventLoopError);
    }
  });

  it("is the pair the front door's supervisor ports are built from, and the door no longer collects either report in process", () => {
    const source = fs.readFileSync(path.join(__dirname, "commands.ts"), "utf8");
    expect(source).toContain("...doorReportPorts,");
    expect(source).not.toMatch(/collectCheckReport|collectDoctorReport/u);
  });
});
