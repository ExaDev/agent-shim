import { describe, expect, it, vi } from "vitest";

import { holdBeforeLaunch, type HoldPort } from "./hold";

const FIVE_SECONDS_MS = 5000;
const ONE_AND_A_HALF_SECONDS_MS = 1500;

/** A hold port whose effects the test reads back, over a terminal that is watched unless the test says otherwise. */
function setup(overrides: Partial<HoldPort> = {}) {
  const sleep = vi.fn<(ms: number) => void>();
  const waitForKey = vi.fn<() => "key" | "interrupt">().mockReturnValue("key");
  const port: HoldPort = { attended: () => true, sleep, waitForKey, ...overrides };
  const infos: string[] = [];
  const log = { info: (message: string) => infos.push(message) };
  return { port, sleep, waitForKey, infos, log };
}

describe("holdBeforeLaunch", () => {
  it("goes at once, saying nothing, when the launch asks for neither a delay nor a pause", () => {
    const { port, sleep, waitForKey, infos, log } = setup();

    expect(holdBeforeLaunch({ delayMs: 0, pause: false }, port, log)).toBe("go");
    expect(sleep).not.toHaveBeenCalled();
    expect(waitForKey).not.toHaveBeenCalled();
    expect(infos).toEqual([]);
  });

  it("says it is starting after a delay, then waits for that long and goes", () => {
    const { port, sleep, infos, log } = setup();

    expect(holdBeforeLaunch({ delayMs: FIVE_SECONDS_MS, pause: false }, port, log)).toBe("go");
    expect(infos).toEqual(["agent-shim: starting in 5s"]);
    expect(sleep).toHaveBeenCalledWith(FIVE_SECONDS_MS);
  });

  it("names a delay that is not a whole number of seconds in milliseconds", () => {
    const { port, infos, log } = setup();

    holdBeforeLaunch({ delayMs: ONE_AND_A_HALF_SECONDS_MS, pause: false }, port, log);

    expect(infos).toEqual(["agent-shim: starting in 1500ms"]);
  });

  it("says it is paused and waits for a key press, then goes", () => {
    const { port, waitForKey, sleep, infos, log } = setup();

    expect(holdBeforeLaunch({ delayMs: 0, pause: true }, port, log)).toBe("go");
    expect(infos).toEqual(["agent-shim: paused before launch; press any key to start, or Ctrl-C to cancel"]);
    expect(waitForKey).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("is cancelled when the key pressed at the pause is the interrupt key", () => {
    const { port, log } = setup({ waitForKey: () => "interrupt" });

    expect(holdBeforeLaunch({ delayMs: 0, pause: true }, port, log)).toBe("cancelled");
  });

  it("lets a pause take the place of a delay when both are set", () => {
    const { port, sleep, waitForKey, log } = setup();

    holdBeforeLaunch({ delayMs: FIVE_SECONDS_MS, pause: true }, port, log);

    expect(waitForKey).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("never holds a launch nobody is watching, however it is set", () => {
    const { port, sleep, waitForKey, infos, log } = setup({ attended: () => false });

    expect(holdBeforeLaunch({ delayMs: FIVE_SECONDS_MS, pause: true }, port, log)).toBe("go");
    expect(holdBeforeLaunch({ delayMs: FIVE_SECONDS_MS, pause: false }, port, log)).toBe("go");
    expect(sleep).not.toHaveBeenCalled();
    expect(waitForKey).not.toHaveBeenCalled();
    expect(infos).toEqual([]);
  });

  it("goes when the launch has no hold port at all", () => {
    expect(holdBeforeLaunch({ delayMs: FIVE_SECONDS_MS, pause: true }, undefined, { info: () => undefined })).toBe("go");
  });
});
