import { createRouterClient } from "@orpc/server";
import { afterEach, describe, expect, it } from "vitest";

import { UpdateChannelError, UpdateConflictError, UpdateDownloadError, type UpdateReport } from "../update/update";
import { mountRouterClient } from "./apiTestMount";
import { createLifecycleApiRouter, type LifecycleApiDeps } from "./lifecycleApi";

const CONTROL_TOKEN = "unit-control-token";
const DOOR_PID = 4_100;
const CURRENT: UpdateReport = { current: "1.0.0", latest: "1.0.0", action: "current" };

/** An update check that answers `report`, the promise-returning shape the dep demands. */
const answers = (report: UpdateReport) => async (): Promise<UpdateReport> => await Promise.resolve(report);

/** An update check that fails with `refusal`. */
const refuses = (refusal: Error) => async (): Promise<UpdateReport> => await Promise.reject(refusal);

/** The deps one test runs against: every restart is reported to `onRestart`, and the update check answers whatever the test sets. */
function makeDeps(checkForUpdate: () => Promise<UpdateReport>, onRestart: () => void): LifecycleApiDeps {
  return { expectedToken: CONTROL_TOKEN, doorPid: DOOR_PID, restartDoor: onRestart, checkForUpdate };
}

describe("the door's lifecycle API", () => {
  const closes: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const close of closes.splice(0)) {
      await close();
    }
  });

  async function mount(deps: LifecycleApiDeps, token = CONTROL_TOKEN) {
    const mounted = await mountRouterClient(createLifecycleApiRouter(deps), CONTROL_TOKEN, token);
    closes.push(mounted.close);
    return mounted;
  }

  it("answers a restart with the pid being replaced, and requests the replacement once the answer has been written", async () => {
    let restarts = 0;
    const { client } = await mount(
      makeDeps(answers(CURRENT), () => {
        restarts += 1;
      }),
    );
    const answered = await client.frontdoor.restart();
    expect(answered).toEqual({ action: "restarting", previousPid: DOOR_PID });
    // The response's `finish` event runs the action once the answer is flushed, a tick after the client holds the body at the latest.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(restarts).toBe(1);
  });

  it("hands the restart to the response's completion instead of running it inside the call", async () => {
    let restarts = 0;
    const registered: (() => void)[] = [];
    const client = createRouterClient(
      createLifecycleApiRouter(
        makeDeps(answers(CURRENT), () => {
          restarts += 1;
        }),
      ),
      {
        context: {
          headers: { authorization: `Bearer ${CONTROL_TOKEN}` },
          afterResponse: (action: () => void) => {
            registered.push(action);
          },
        },
      },
    );
    await client.frontdoor.restart();
    expect(restarts).toBe(0);
    expect(registered).toHaveLength(1);
    registered[0]?.();
    expect(restarts).toBe(1);
  });

  it("does not restart on a refused call", async () => {
    let restarts = 0;
    const { client } = await mount(
      makeDeps(answers(CURRENT), () => {
        restarts += 1;
      }),
      "not-the-token",
    );
    await expect(client.frontdoor.restart()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(restarts).toBe(0);
  });

  it("reports an update check's own report", async () => {
    const { client } = await mount(makeDeps(answers({ current: "9.5.0", latest: "9.6.0", action: "available" }), () => undefined));
    await expect(client.update.check()).resolves.toEqual({ current: "9.5.0", latest: "9.6.0", action: "available" });
  });

  it.each([
    [new UpdateChannelError("this installation updates through Homebrew"), "PRECONDITION_FAILED"],
    [new UpdateConflictError("another agent-shim update is already running"), "CONFLICT"],
    [new UpdateDownloadError("could not resolve the latest release"), "BAD_GATEWAY"],
  ] as const)("names the update path's refusal %#, carrying its message", async (refusal, code) => {
    const { client } = await mount(
      makeDeps(refuses(refusal), () => undefined),
    );
    await expect(client.update.check()).rejects.toMatchObject({ code, message: refusal.message });
  });
});
