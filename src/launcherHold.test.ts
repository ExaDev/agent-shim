import { describe, expect, it, vi } from "vitest";

import { prepareLaunch } from "./launcher";
import type { HoldPort } from "./launcher/hold";
import { createFakeFarmFs, discovered, fakeFarm, fakeFrontDoorPort, fakeFs, fakeLog, fakeProc, paths } from "./test-helpers";

const THREE_SECONDS_MS = 3000;
const TWO_SECONDS_MS = 2000;

/** One launch of `@work` prepared with a hold port the test reads back, and the cascade's own `launch` block when it has one. */
function prepared(argv: readonly string[], options: { readonly launch?: Parameters<typeof fakeFarm>[1]; readonly env?: Record<string, string>; readonly attended?: boolean } = {}) {
  const sleep = vi.fn<(ms: number) => void>();
  const waitForKey = vi.fn<() => "key" | "interrupt">().mockReturnValue("key");
  const hold: HoldPort = { attended: () => options.attended ?? true, sleep, waitForKey };
  const log = fakeLog();
  const plan = prepareLaunch({
    paths,
    fs: fakeFs({}),
    proc: fakeProc(options.env ?? {}, ["@work", ...argv]),
    log,
    resolveClaudeBinary: () => discovered,
    farm: fakeFarm(createFakeFarmFs({}), options.launch),
    frontdoor: fakeFrontDoorPort(),
    hold,
  });
  return { plan, sleep, waitForKey, log };
}

describe("a launch's hold", () => {
  it("waits for a key press when --pause is given, after the launcher has printed its lines", () => {
    const { plan, waitForKey, log } = prepared(["--pause", "--print"]);
    const printedBeforeHold = log.infos.length;

    expect(plan.hold()).toBe("go");

    expect(waitForKey).toHaveBeenCalledTimes(1);
    expect(log.infos.length).toBe(printedBeforeHold + 1);
    expect(log.infos.at(-1)).toContain("paused before launch");
  });

  it("waits for the time --delay names", () => {
    const { plan, sleep } = prepared(["--delay", "3s"]);

    plan.hold();

    expect(sleep).toHaveBeenCalledWith(THREE_SECONDS_MS);
  });

  it("takes its settings from the cascade, so a global config can set them", () => {
    expect(prepared([], { launch: { launch: { pause: true } } }).plan.hold()).toBe("go");
    const pausing = prepared([], { launch: { launch: { pause: true } } });
    pausing.plan.hold();
    expect(pausing.waitForKey).toHaveBeenCalledTimes(1);

    const delaying = prepared([], { launch: { launch: { delay: "2s" } } });
    delaying.plan.hold();
    expect(delaying.sleep).toHaveBeenCalledWith(TWO_SECONDS_MS);
  });

  it("lets the environment and then the flag override the cascade", () => {
    const fromEnv = prepared([], { launch: { launch: { pause: true } }, env: { AGENT_SHIM_PAUSE: "0" } });
    fromEnv.plan.hold();
    expect(fromEnv.waitForKey).not.toHaveBeenCalled();

    const fromFlag = prepared(["--pause"], { launch: { launch: { pause: false } }, env: { AGENT_SHIM_PAUSE: "0" } });
    fromFlag.plan.hold();
    expect(fromFlag.waitForKey).toHaveBeenCalledTimes(1);
  });

  it("is cancelled when the person interrupts the pause", () => {
    const { plan, waitForKey } = prepared(["--pause"]);
    waitForKey.mockReturnValue("interrupt");

    expect(plan.hold()).toBe("cancelled");
  });

  it("does nothing when no flag, environment variable or cascade value asks for it", () => {
    const { plan, sleep, waitForKey } = prepared(["--print"]);

    expect(plan.hold()).toBe("go");
    expect(sleep).not.toHaveBeenCalled();
    expect(waitForKey).not.toHaveBeenCalled();
  });

  it("does nothing when nobody is watching", () => {
    const { plan, sleep, waitForKey } = prepared(["--pause", "--delay", "3s"], { attended: false });

    expect(plan.hold()).toBe("go");
    expect(sleep).not.toHaveBeenCalled();
    expect(waitForKey).not.toHaveBeenCalled();
  });

  it("is not passed to claude", () => {
    expect(prepared(["--pause", "--delay", "3s", "--print"]).plan.args).toEqual(["--print"]);
  });
});
