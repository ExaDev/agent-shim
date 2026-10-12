import { afterEach, describe, expect, it } from "vitest";

import { probeFrontDoorSync } from "./frontdoor/probe";
import { BlockingInEventLoopError, enterProcessRole, refuseToBlockInRole } from "./processRole";
import { realSleepSync } from "./realPorts";

/** What puts the process back to no role after a test that entered one. */
let leave: (() => void) | undefined;

afterEach(() => {
  leave?.();
  leave = undefined;
});

describe("process role", () => {
  it("lets a process with no role block, as the launcher does", () => {
    expect(() => {
      refuseToBlockInRole("a thing");
    }).not.toThrow();
    expect(() => {
      realSleepSync(0);
    }).not.toThrow();
  });

  it("refuses a synchronous sleep in the front door supervisor, naming the operation and the role", () => {
    leave = enterProcessRole("frontdoor-supervisor");
    expect(() => {
      realSleepSync(0);
    }).toThrow(BlockingInEventLoopError);
    expect(() => {
      realSleepSync(0);
    }).toThrow(/a synchronous sleep blocks the calling thread.*frontdoor-supervisor/);
  });

  it("refuses the synchronous probe before it starts a worker or touches the network", () => {
    leave = enterProcessRole("frontdoor-supervisor");
    expect(() => probeFrontDoorSync(1, "not a certificate")).toThrow(BlockingInEventLoopError);
  });

  it("puts the previous role back when the entered one is left", () => {
    leave = enterProcessRole("frontdoor-supervisor");
    leave();
    leave = undefined;
    expect(() => {
      realSleepSync(0);
    }).not.toThrow();
  });
});
