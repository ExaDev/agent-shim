import { afterEach, describe, expect, it } from "vitest";

import { KEYCHAIN_CACHE_SERVICE } from "./credentialCache";
import { cli, expectOk, keychain } from "./programTestWorld";

const HOST_PLATFORM = process.platform;

afterEach(() => {
  Object.defineProperty(process, "platform", { value: HOST_PLATFORM });
});

describe("the command-line harness on any host", () => {
  it.each<NodeJS.Platform>(["darwin", "linux", "win32"])("has the identity commands ask the fake Keychain for a login, as on macOS, when the host is %s", async (platform) => {
    Object.defineProperty(process, "platform", { value: platform });
    expectOk(await cli(["identity", "add", "work"]));
    expect(keychain.calls.length).toBeGreaterThan(0);
  });

  it.each<NodeJS.Platform>(["darwin", "linux", "win32"])("sends the credential cache's Keychain store to the fake too, so removing an identity forgets its cached credential there, when the host is %s", async (platform) => {
    Object.defineProperty(process, "platform", { value: platform });
    expectOk(await cli(["identity", "add", "work"]));
    expectOk(await cli(["identity", "remove", "work", "--yes"]));
    const forgotten = keychain.calls.filter((call) => call.command === "security" && call.args[0] === "delete-generic-password" && call.args.includes(KEYCHAIN_CACHE_SERVICE));
    expect(forgotten).toHaveLength(1);
  });
});
