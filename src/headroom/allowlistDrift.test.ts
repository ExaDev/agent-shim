import { describe, expect, it } from "vitest";

import { diagnoseAllowlistDrift } from "./allowlistDrift";
import { formatAllowlistFile, hashAllowlist } from "./state";

const DOOR_ORIGIN = "http://127.0.0.1:50123";
const MOVED_DOOR_ORIGIN = "http://127.0.0.1:50999";
const ANTHROPIC = "https://api.anthropic.com";
const PROVIDER = "https://api.z.ai/api/anthropic";

const allowlist = [DOOR_ORIGIN, ANTHROPIC, PROVIDER];
const movedAllowlist = [MOVED_DOOR_ORIGIN, ANTHROPIC, PROVIDER];

describe("diagnoseAllowlistDrift", () => {
  it("reports no drift when the file and the recorded hash both hold the computed allowlist", () => {
    expect(diagnoseAllowlistDrift({ allowlist, fileContent: formatAllowlistFile(allowlist), recordedHash: hashAllowlist(allowlist), earlierRelease: undefined })).toBeUndefined();
  });

  it("reports nothing when no daemon has recorded the allowlist it serves", () => {
    expect(diagnoseAllowlistDrift({ allowlist, fileContent: undefined, recordedHash: undefined, earlierRelease: undefined })).toBeUndefined();
  });

  it("names the entries the file lacks and still lists when it lags a moved front door", () => {
    expect(diagnoseAllowlistDrift({ allowlist, fileContent: formatAllowlistFile(movedAllowlist), recordedHash: hashAllowlist(movedAllowlist), earlierRelease: undefined })).toEqual({
      missingFromFile: [DOOR_ORIGIN],
      staleInFile: [MOVED_DOOR_ORIGIN],
      hashLags: false,
    });
  });

  it("treats a missing file as admitting nothing, since headroom then refuses every listed upstream", () => {
    expect(diagnoseAllowlistDrift({ allowlist, fileContent: undefined, recordedHash: hashAllowlist(allowlist), earlierRelease: undefined })).toEqual({
      missingFromFile: allowlist,
      staleInFile: [],
      hashLags: true,
    });
  });

  it("reports a recorded hash that lags a file already rewritten, so a launch's gate is still waiting", () => {
    expect(diagnoseAllowlistDrift({ allowlist, fileContent: formatAllowlistFile(allowlist), recordedHash: hashAllowlist(movedAllowlist), earlierRelease: undefined })).toEqual({
      missingFromFile: [],
      staleInFile: [],
      hashLags: true,
    });
  });

  it("reports a daemon started by an earlier release by whether its fixed allowlist admits the serving door, ignoring the file it never reads", () => {
    expect(diagnoseAllowlistDrift({ allowlist, fileContent: undefined, recordedHash: "an-earlier-hash", earlierRelease: { admitsServingDoor: false } })).toEqual({ startedByEarlierRelease: true });
    expect(diagnoseAllowlistDrift({ allowlist, fileContent: undefined, recordedHash: "an-earlier-hash", earlierRelease: { admitsServingDoor: true } })).toBeUndefined();
  });

  it("compares entries the way headroom reads them, not the file's layout", () => {
    expect(diagnoseAllowlistDrift({ allowlist, fileContent: ` ${PROVIDER},${ANTHROPIC}\n\n${DOOR_ORIGIN}\n`, recordedHash: hashAllowlist(allowlist), earlierRelease: undefined })).toBeUndefined();
  });
});
