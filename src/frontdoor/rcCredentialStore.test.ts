import { describe, expect, it } from "vitest";

import { createFakeFarmFs } from "../test-helpers";
import { createRcCredentialStore } from "./rcCredentialStore";

/** A made-up session id of the protocol's shape, and the directory the tests build the store over. */
const SESSION_ID = "cse_00000000-0000-4000-8000-000000000001";
const DIR = "/state/frontdoor/rc-credentials";
/** The owner-only modes the store's directory and files must carry: they hold a bearer the identity's own store protects the same way. */
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

describe("the Remote Control credential store", () => {
  it("writes one owner-only JSON file per session and reads the credential back", () => {
    const fs = createFakeFarmFs();
    const store = createRcCredentialStore(fs, DIR);
    store.write(SESSION_ID, { authorization: "Bearer sk-ant-oat", anthropicVersion: "2023-06-01", anthropicClientPlatform: "desktop_app" });
    expect(fs.modeOf(`${DIR}/${SESSION_ID}.json`)).toBe(PRIVATE_FILE_MODE);
    expect(fs.modeOf(DIR)).toBe(PRIVATE_DIR_MODE);
    expect(store.read(SESSION_ID)).toEqual({ authorization: "Bearer sk-ant-oat", anthropicVersion: "2023-06-01", anthropicClientPlatform: "desktop_app" });
  });

  it("replaces the held credential on a later write, and forgets the session on remove", () => {
    const fs = createFakeFarmFs();
    const store = createRcCredentialStore(fs, DIR);
    store.write(SESSION_ID, { authorization: "Bearer sk-ant-oat", anthropicVersion: undefined, anthropicClientPlatform: undefined });
    store.write(SESSION_ID, { authorization: "Bearer sk-ant-oat2", anthropicVersion: "2023-06-01", anthropicClientPlatform: undefined });
    expect(store.read(SESSION_ID)?.authorization).toBe("Bearer sk-ant-oat2");
    store.remove(SESSION_ID);
    expect(store.read(SESSION_ID)).toBeUndefined();
    // Removing a session nothing was persisted for is a no-op, not a failure.
    store.remove(SESSION_ID);
  });

  it("answers undefined for a file that does not parse, one that is not an object, and one with no usable authorization", () => {
    const fs = createFakeFarmFs();
    const store = createRcCredentialStore(fs, DIR);
    fs.writeFileUtf8(`${DIR}/cse_a.json`, "not json at all");
    fs.writeFileUtf8(`${DIR}/cse_b.json`, JSON.stringify(["an", "array"]));
    fs.writeFileUtf8(`${DIR}/cse_c.json`, JSON.stringify({ authorization: "" }));
    fs.writeFileUtf8(`${DIR}/cse_d.json`, JSON.stringify({ authorization: "Bearer sk-ant-oat", anthropicVersion: 7 }));
    expect(store.read("cse_a")).toBeUndefined();
    expect(store.read("cse_b")).toBeUndefined();
    expect(store.read("cse_c")).toBeUndefined();
    // A field of the wrong kind is dropped rather than trusted; the credential itself still reads.
    expect(store.read("cse_d")).toEqual({ authorization: "Bearer sk-ant-oat", anthropicVersion: undefined, anthropicClientPlatform: undefined });
  });

  it("refuses session ids that could escape the store's directory, answering undefined and writing nothing", () => {
    const fs = createFakeFarmFs();
    const store = createRcCredentialStore(fs, DIR);
    expect(store.read("../escape")).toBeUndefined();
    store.write("../escape", { authorization: "Bearer sk-ant-oat", anthropicVersion: undefined, anthropicClientPlatform: undefined });
    store.remove("../escape");
    expect(fs.readdir(DIR)).toEqual([]);
  });
});
