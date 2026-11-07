import { describe, expect, it } from "vitest";

import { KeychainLoginError, KeychainLookupError } from "../keychainLogin";
import type { RunPort } from "../launcher/ports";
import { RC_SELF_HOST_RECORD_DIR, RC_SELF_HOST_RECORD_FILE, mintRcSelfHostCredential, mintRcSelfHostLogin, readRcSelfHostRecord } from "./rcSelfHostMint";
import { RC_SELF_HOST_MINT_MARKER, isSelfHostMinted } from "../selfHostMintMarker";
import { TEST_CLAUDE_LOGIN, createFakeKeychain } from "../keychainTestWorld";
import { claudeCodeKeychainService } from "../usage/signIn";
import { createFakeFarmFs } from "../test-helpers";

/**
 * The self-hosted Remote Control credential minting's own semantics, over a fake filesystem: the files it writes, the merge it performs into an existing `.claude.json`, and the replacements it refuses and allows. Split out of `rcSelfHost.test.ts` (whose world is a loopback HTTP server for the serving surface) because the minting needs no server at all.
 */

/** Where the minting test's clock starts: any fixed epoch instant. */
const MINT_CLOCK_START_MS = 1_700_000_000_000;

/** The width of a UUID's final hyphen-separated group, so minted test ids carry the shape the protocol validates. */
const UUID_TAIL_WIDTH = 12;

/** The owner-only mode the minted files must carry, the same mode the credential store's own test asserts. */
const PRIVATE_FILE_MODE = 0o600;

describe("the self-hosted credential minting", () => {
  /** Builds the minting over a fake filesystem and returns the fs with the result. */
  /** Makes `rig` an identity, stored in the directory of its name, unless the test stored an identity there already. */
  const withRig = (fs: ReturnType<typeof createFakeFarmFs>): ReturnType<typeof createFakeFarmFs> => {
    if (fs.readFileUtf8("/state/identities/rig/identity.json") === undefined) {
      fs.seed({ "/state/identities/rig/identity.json": '{"name":"rig"}' });
    }
    return fs;
  };
  const mint = (fs: ReturnType<typeof createFakeFarmFs>, options: Readonly<{ identity?: string; force?: boolean }> = {}) =>
    mintRcSelfHostCredential({
      fs: withRig(fs),
      identitiesDir: "/state/identities",
      frontdoorDir: "/state/frontdoor",
      identity: options.identity ?? "rig",
      newUuid: (() => {
        let next = 0;
        return () => {
          next += 1;
          return `00000000-0000-4000-8000-${String(next).padStart(UUID_TAIL_WIDTH, "0")}`;
        };
      })(),
      randomToken: () => "randomtokenmaterial",
      force: options.force ?? false,
      now: () => MINT_CLOCK_START_MS,
    });

  it("mints into the directory of the identity's id, which a rename of its name keeps", () => {
    const fs = createFakeFarmFs({ "/state/identities/rig/identity.json": '{"name":"rack"}' });
    const result = mint(fs, { identity: "rack" });
    expect(result.credentialsFile).toBe("/state/identities/rig/.credentials.json");
    expect(() => mint(createFakeFarmFs({ "/state/identities/rig/identity.json": '{"name":"rack"}' }), { identity: "rig" })).toThrow('No identity named "rig"');
  });

  it("writes the credential, the account block and the feature seed, and the door's record", () => {
    const fs = createFakeFarmFs();
    const result = mint(fs);
    expect(result.identity).toBe("rig");
    expect(result.replaced).toBe(false);
    const credentials = JSON.parse(fs.readFileUtf8("/state/identities/rig/.credentials.json") ?? "{}") as { claudeAiOauth: Record<string, unknown> };
    // The access token is never part of any result or log the minting returns; the file's shape is what the assertions read.
    expect(String(credentials.claudeAiOauth.accessToken).startsWith("sk-ant-oat")).toBe(true);
    expect(credentials.claudeAiOauth.expiresAt).toBeNull();
    expect(credentials.claudeAiOauth.scopes).toEqual(["user:profile", "user:inference", "user:sessions:claude_code", "user:mcp_servers", "user:file_upload"]);
    expect(credentials.claudeAiOauth.subscriptionType).toBe("max");
    const claudeJson = JSON.parse(fs.readFileUtf8("/state/identities/rig/.claude.json") ?? "{}") as { oauthAccount: Record<string, unknown>; cachedGrowthBookFeatures: Record<string, boolean> };
    expect(claudeJson.oauthAccount.organizationUuid).toBe(result.organizationUuid);
    expect(claudeJson.cachedGrowthBookFeatures).toMatchObject({ tengu_ccr_bridge: true, tengu_bridge_repl_v2: true });
    const record = readRcSelfHostRecord(fs, "/state/frontdoor");
    expect(record?.accessToken).toBe(credentials.claudeAiOauth.accessToken);
    expect(fs.modeOf("/state/identities/rig/.credentials.json")).toBe(PRIVATE_FILE_MODE);
    expect(fs.modeOf("/state/frontdoor/rc-selfhost/credential.json")).toBe(PRIVATE_FILE_MODE);
  });

  it("merges into an existing .claude.json without disturbing its other keys", () => {
    const fs = createFakeFarmFs();
    fs.mkdirp("/state/identities/rig");
    fs.writeFileUtf8("/state/identities/rig/.claude.json", JSON.stringify({ projects: { "/work": { history: ["one"] } }, cachedGrowthBookFeatures: { unrelated_flag: true } }));
    mint(fs);
    const claudeJson = JSON.parse(fs.readFileUtf8("/state/identities/rig/.claude.json") ?? "{}") as Record<string, unknown>;
    expect((claudeJson.projects as Record<string, unknown>)["/work"]).toBeDefined();
    expect((claudeJson.cachedGrowthBookFeatures as Record<string, boolean>).unrelated_flag).toBe(true);
  });

  it("refuses to replace a real login, allows replacing its own previous mint, and forces when told", () => {
    const fs = createFakeFarmFs();
    fs.mkdirp("/state/identities/rig");
    fs.writeFileUtf8("/state/identities/rig/.credentials.json", JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat2", refreshToken: "r", expiresAt: null, scopes: ["user:profile"] } }));
    expect(() => mint(fs)).toThrow("already holds an OAuth credential");
    // A forced mint overwrites the foreign credential and records itself as the door's own.
    mint(fs, { force: true });
    expect(readRcSelfHostRecord(fs, "/state/frontdoor")?.accessToken).not.toBe("sk-ant-oat2");
    // Re-minting over this door's own previous mint needs no force.
    const again = mint(fs);
    expect(again.replaced).toBe(true);
    expect(() => mint(fs, { identity: "../escape" })).toThrow("not a valid identity name");
  });
});

describe("the self-hosted mint's marker", () => {
  it("marks the identity's directory as minted, and an unminted directory reads as not minted", () => {
    const fs = createFakeFarmFs();
    fs.seed({ "/state/identities/rig/identity.json": '{"name":"rig"}', "/state/identities/real/identity.json": '{"name":"real"}' });
    mintRcSelfHostCredential({ fs, identitiesDir: "/state/identities", frontdoorDir: "/state/frontdoor", identity: "rig", newUuid: () => "00000000-0000-4000-8000-000000000001", randomToken: () => "randomtokenmaterial", force: false, now: () => 0 });
    expect(fs.readFileUtf8(`/state/identities/rig/${RC_SELF_HOST_MINT_MARKER}`)).toBeDefined();
    expect(isSelfHostMinted(fs, "/state/identities/rig")).toBe(true);
    expect(isSelfHostMinted(fs, "/state/identities/real")).toBe(false);
  });
});

describe("the guarded self-hosted mint on macOS", () => {
  const seededFs = () => {
    const fs = createFakeFarmFs();
    fs.seed({ "/state/identities/rig/identity.json": '{"name":"rig"}' });
    return fs;
  };
  const guarded = (fs: ReturnType<typeof createFakeFarmFs>, keychain: ReturnType<typeof createFakeKeychain>, force = false) =>
    mintRcSelfHostLogin({ fs, identitiesDir: "/state/identities", frontdoorDir: "/state/frontdoor", identity: "rig", newUuid: () => "00000000-0000-4000-8000-000000000001", randomToken: () => "randomtokenmaterial", force, now: () => 0, keychain: { run: keychain.run, platform: "darwin" }, login: TEST_CLAUDE_LOGIN });

  it("asks the Keychain for the identity's directory before writing, and mints when no login is filed", () => {
    const fs = seededFs();
    const keychain = createFakeKeychain();
    guarded(fs, keychain);
    expect(keychain.calls[0]?.args).toEqual(["find-generic-password", "-s", claudeCodeKeychainService("/state/identities/rig")]);
    expect(fs.readFileUtf8("/state/identities/rig/.credentials.json")).toBeDefined();
  });

  it("refuses, writing nothing, when a login is filed for the directory, even a second mint into a directory the first one marked, and even with force", () => {
    const fs = seededFs();
    const clean = createFakeKeychain();
    guarded(fs, clean);
    expect(isSelfHostMinted(fs, "/state/identities/rig")).toBe(true);
    const credentialsAfterFirst = fs.readFileUtf8("/state/identities/rig/.credentials.json");
    // A real /login since: the CLI filed its login in the Keychain.
    const keychain = createFakeKeychain();
    keychain.seed(claudeCodeKeychainService("/state/identities/rig"), "alex", "a-made-up-real-login");
    expect(() => guarded(fs, keychain, true)).toThrow("--force does not override this");
    expect(fs.readFileUtf8("/state/identities/rig/.credentials.json")).toBe(credentialsAfterFirst);
    expect(keychain.items.has(claudeCodeKeychainService("/state/identities/rig"))).toBe(true);
    expect(keychain.calls.some((call) => call.args[0] === "delete-generic-password")).toBe(false);
  });
});

/** Failures `security` gives that are not an item it cannot find: a locked Keychain, and one it cannot reach. */
const LOCKED_KEYCHAIN_STATUS = 51;
const UNREACHABLE_KEYCHAIN_STATUS = 36;

describe("the guarded self-hosted mint on a fresh directory", () => {
  const freshFs = () => {
    const fs = createFakeFarmFs();
    fs.seed({ "/state/identities/rig/identity.json": '{"name":"rig"}' });
    return fs;
  };
  const guarded = (fs: ReturnType<typeof createFakeFarmFs>, run: RunPort) =>
    mintRcSelfHostLogin({ fs, identitiesDir: "/state/identities", frontdoorDir: "/state/frontdoor", identity: "rig", newUuid: () => "00000000-0000-4000-8000-000000000001", randomToken: () => "randomtokenmaterial", force: false, now: () => MINT_CLOCK_START_MS, keychain: { run, platform: "darwin" }, login: TEST_CLAUDE_LOGIN });
  /** Every file the mint writes: the credential, the account block, the marker and the door's own record. */
  const mintedFiles = [
    "/state/identities/rig/.credentials.json",
    "/state/identities/rig/.claude.json",
    `/state/identities/rig/${RC_SELF_HOST_MINT_MARKER}`,
    `/state/frontdoor/${RC_SELF_HOST_RECORD_DIR}/${RC_SELF_HOST_RECORD_FILE}`,
  ];

  it("writes none of the mint's four files when a login is filed for the directory", () => {
    const fs = freshFs();
    const keychain = createFakeKeychain();
    keychain.seed(claudeCodeKeychainService("/state/identities/rig"), "alex", "a-made-up-real-login");
    expect(() => guarded(fs, keychain.run)).toThrow(KeychainLoginError);
    expect(mintedFiles.map((file) => fs.readFileUtf8(file))).toEqual([undefined, undefined, undefined, undefined]);
  });

  it.each([
    ["a locked Keychain", LOCKED_KEYCHAIN_STATUS],
    ["a Keychain that cannot be reached", UNREACHABLE_KEYCHAIN_STATUS],
    ["no exit status", null],
  ])("throws a lookup failure and writes none of the mint's four files for %s, saying nothing was minted", (_name, status) => {
    const fs = freshFs();
    const run: RunPort = { run: () => ({ status, stdout: "", stderr: "" }) };
    expect(() => guarded(fs, run)).toThrow(KeychainLookupError);
    expect(() => guarded(fs, run)).toThrow('Nothing was minted into identity "rig"');
    expect(mintedFiles.map((file) => fs.readFileUtf8(file))).toEqual([undefined, undefined, undefined, undefined]);
  });
});
