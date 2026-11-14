import { afterEach, describe, expect, it } from "vitest";

import { cli, expectOk, keychain } from "./programTestWorld";

const HOST_PLATFORM = process.platform;

afterEach(() => {
  Object.defineProperty(process, "platform", { value: HOST_PLATFORM });
});

describe("the command-line harness on any host", () => {
  it.each<NodeJS.Platform>(["darwin", "linux", "win32"])("has the identity commands ask the fake Keychain, and the same, when the host is %s", async (platform) => {
    Object.defineProperty(process, "platform", { value: platform });
    expectOk(await cli(["identity", "add", "work"]));
    expect(keychain.calls.length).toBeGreaterThan(0);
  });
});
