import { describe, expect, it } from "vitest";

import { mintRcSelfHostCredential, readRcSelfHostRecord } from "./rcSelfHostMint";
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
  const mint = (fs: ReturnType<typeof createFakeFarmFs>, options: Readonly<{ identity?: string; force?: boolean }> = {}) =>
    mintRcSelfHostCredential({
      fs,
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
