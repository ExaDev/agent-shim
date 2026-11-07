import { describe, expect, it } from "vitest";

import { isSelfHostMinted } from "./selfHostMintMarker";
import { createFakeFarmFs } from "./test-helpers";

describe("the mint's marker contents", () => {
  it("counts only a marker naming when it minted, not an empty or foreign file", () => {
    const fs = createFakeFarmFs();
    fs.seed({ "/a/.agent-shim-selfhost-mint": "", "/b/.agent-shim-selfhost-mint": "{}", "/c/.agent-shim-selfhost-mint": '{"mintedAt":"not a date"}', "/d/.agent-shim-selfhost-mint": '{"mintedAt":"2026-01-01T00:00:00.000Z"}' });
    expect(["/a", "/b", "/c", "/d"].map((dir) => isSelfHostMinted(fs, dir))).toEqual([false, false, false, true]);
  });
});
