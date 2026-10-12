import { describe, expect, it } from "vitest";

import { ProviderSchema } from "../config/schema";
import { writeFrontDoorState } from "../frontdoor/state";
import { buildLayoutPaths } from "../paths";
import { createFakeFarmFs } from "../test-helpers";
import { daemonIdentity, earlierReleaseAllowlistHash, earlierReleaseDaemon } from "./earlierRelease";
import { hashAllowlist } from "./state";

const paths = buildLayoutPaths("/home/testuser/.agent-shim");
const DOOR_DIRECT_PORT = 50123;
const DOOR_ORIGIN = `http://127.0.0.1:${String(DOOR_DIRECT_PORT)}`;
const glm = ProviderSchema.parse({ displayName: "GLM", baseUrl: "https://api.z.ai/api/anthropic", credential: { sources: [{ env: "Z" }] } });
const codex = ProviderSchema.parse({ kind: "codex", displayName: "Codex", credential: { sources: [{ literal: "x" }] } });
const DAEMON_SOCKET = "/s.sock";
const EARLIER_DAEMON = `python -m headroom.cli proxy --uds ${DAEMON_SOCKET} --no-rate-limit`;
const THIS_RELEASE_DAEMON = `python -m headroom.cli proxy --uds ${DAEMON_SOCKET} --allowed-base-urls-file /a.txt --no-rate-limit`;

describe("daemonIdentity", () => {
  const SOCKET = "/s.sock";

  it("tells this release's daemon from an earlier release's by the allowlist file flag, given the headroom proxy shape on our socket", () => {
    expect(daemonIdentity("python -m headroom.cli proxy --uds /s.sock --allowed-base-urls-file /a.txt", SOCKET)).toBe("this-release");
    expect(daemonIdentity("headroom proxy --uds=/s.sock --allowed-base-urls-file=/a.txt", SOCKET)).toBe("this-release");
    expect(daemonIdentity("headroom proxy --uds /s.sock --no-rate-limit", SOCKET)).toBe("earlier-release");
  });

  it("does not judge a process that is not a headroom proxy on our socket, such as one that reused the daemon's pid", () => {
    expect(daemonIdentity("/usr/bin/vim notes.md", SOCKET)).toBe("not-headroom");
    expect(daemonIdentity("headroom proxy --uds /other.sock", SOCKET)).toBe("not-headroom");
    expect(daemonIdentity("headroom serve --uds /s.sock", SOCKET)).toBe("not-headroom");
    expect(daemonIdentity("headroom proxy --uds /dir/--allowed-base-urls-file-lookalike.sock", "/dir/--allowed-base-urls-file-lookalike.sock")).toBe("earlier-release");
  });

  it("finds our socket path in a command line even when the path holds a space", () => {
    const spaced = "/Users/a b/.agent-shim/headroom/run/42.sock";
    expect(daemonIdentity(`headroom proxy --uds ${spaced} --no-rate-limit`, spaced)).toBe("earlier-release");
    expect(daemonIdentity(`headroom proxy --uds ${spaced} --allowed-base-urls-file /Users/a b/.agent-shim/headroom/run/allowlist.txt`, spaced)).toBe("this-release");
    expect(daemonIdentity(`headroom proxy --uds=${spaced}`, spaced)).toBe("earlier-release");
    expect(daemonIdentity(`headroom proxy --uds /Users/a b/.agent-shim/headroom/run/42.sock.old`, spaced)).toBe("not-headroom");
  });

  it("says when the command line could not be read", () => {
    expect(daemonIdentity(undefined, SOCKET)).toBe("unreadable");
  });
});

describe("earlierReleaseAllowlistHash", () => {
  it("is the hash of the sorted list that release served: Claude Code's API, every http provider's full base URL, and the door's origin while any provider exists", () => {
    expect(earlierReleaseAllowlistHash([glm, codex], DOOR_ORIGIN)).toBe(hashAllowlist([DOOR_ORIGIN, "https://api.anthropic.com", "https://api.z.ai/api/anthropic"]));
    expect(earlierReleaseAllowlistHash([], DOOR_ORIGIN)).toBe(hashAllowlist(["https://api.anthropic.com"]));
    expect(earlierReleaseAllowlistHash([codex], undefined)).toBe(hashAllowlist(["https://api.anthropic.com"]));
  });
});

describe("earlierReleaseDaemon", () => {
  function world() {
    const fs = createFakeFarmFs({});
    writeFrontDoorState(fs, paths.frontdoorStateFile, { directPort: DOOR_DIRECT_PORT });
    fs.mkdirp(paths.providersDir);
    fs.writeFileUtf8(`${paths.providersDir}/z.json`, JSON.stringify({ displayName: "GLM", baseUrl: "https://api.z.ai/api/anthropic", credential: { sources: [{ env: "Z" }] } }));
    return fs;
  }

  it("is undefined for this release's daemon, and for one whose command line could not be read", () => {
    expect(earlierReleaseDaemon(world(), paths, { commandLine: THIS_RELEASE_DAEMON, socketPath: DAEMON_SOCKET, recordedHash: "x" })).toBeUndefined();
    expect(earlierReleaseDaemon(world(), paths, { commandLine: undefined, socketPath: DAEMON_SOCKET, recordedHash: "x" })).toBeUndefined();
  });

  it("admits the serving door when the recorded hash is the one that release records for the providers and door on disk now, and not otherwise", () => {
    const fs = world();
    const current = earlierReleaseAllowlistHash([glm], DOOR_ORIGIN);
    expect(earlierReleaseDaemon(fs, paths, { commandLine: EARLIER_DAEMON, socketPath: DAEMON_SOCKET, recordedHash: current })).toEqual({ admitsServingDoor: true });
    expect(earlierReleaseDaemon(fs, paths, { commandLine: EARLIER_DAEMON, socketPath: DAEMON_SOCKET, recordedHash: earlierReleaseAllowlistHash([glm], "http://127.0.0.1:50999") })).toEqual({ admitsServingDoor: false });
  });
});
