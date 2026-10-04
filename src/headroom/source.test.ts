import { describe, expect, it } from "vitest";
import { isMovingGitSource, parseInstalledCommit, pinnedGitCommit } from "./source";

describe("isMovingGitSource", () => {
  it("treats a branch ref as moving", () => {
    expect(isMovingGitSource("headroom-ai[proxy] @ git+https://github.com/ExaDev/headroom@feat/per-session-savings")).toBe(true);
  });

  it("treats a tag ref as moving, since a tag can be re-pointed", () => {
    expect(isMovingGitSource("headroom-ai[proxy] @ git+https://github.com/ExaDev/headroom@v0.39.1")).toBe(true);
  });

  it("treats a full commit SHA as fixed", () => {
    expect(isMovingGitSource("headroom-ai[proxy] @ git+https://github.com/ExaDev/headroom@53525f479f2f48e8ef6b08cf729601feab7d2382")).toBe(false);
  });

  it("treats a git spec with no ref as moving, since it follows the remote's default branch", () => {
    expect(isMovingGitSource("headroom-ai[proxy] @ git+https://github.com/ExaDev/headroom")).toBe(true);
  });

  it("does not treat a registry requirement as a git source", () => {
    expect(isMovingGitSource("headroom-ai[proxy]==0.39.1")).toBe(false);
  });
});

describe("pinnedGitCommit", () => {
  it("returns the commit a spec pins, lowercased", () => {
    expect(pinnedGitCommit("headroom-ai[proxy] @ git+https://github.com/ExaDev/headroom@53525F479F2F48E8EF6B08CF729601FEAB7D2382")).toBe(
      "53525f479f2f48e8ef6b08cf729601feab7d2382",
    );
  });

  it("returns undefined for a moving ref, a missing ref and a registry requirement", () => {
    expect(pinnedGitCommit("headroom-ai[proxy] @ git+https://github.com/ExaDev/headroom@main")).toBeUndefined();
    expect(pinnedGitCommit("headroom-ai[proxy] @ git+https://github.com/ExaDev/headroom")).toBeUndefined();
    expect(pinnedGitCommit("headroom-ai[proxy]==0.39.1")).toBeUndefined();
  });
});

describe("parseInstalledCommit", () => {
  it("reads the resolved commit from a VCS install's direct_url.json", () => {
    const directUrl = JSON.stringify({ url: "https://github.com/ExaDev/headroom", vcs_info: { vcs: "git", commit_id: "53525F479F2F48E8EF6B08CF729601FEAB7D2382" } });
    expect(parseInstalledCommit(directUrl)).toBe("53525f479f2f48e8ef6b08cf729601feab7d2382");
  });

  it("returns undefined when the file records no VCS commit or is not JSON", () => {
    expect(parseInstalledCommit(JSON.stringify({ url: "file:///tmp/headroom", dir_info: {} }))).toBeUndefined();
    expect(parseInstalledCommit("not json")).toBeUndefined();
  });
});
