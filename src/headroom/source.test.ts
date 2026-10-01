import { describe, expect, it } from "vitest";
import { isMovingGitSource } from "./source";

describe("isMovingGitSource", () => {
  it("treats a branch ref as moving", () => {
    expect(isMovingGitSource("headroom-ai[proxy] @ git+https://github.com/ExaDev/headroom@feat/per-session-savings")).toBe(true);
  });

  it("treats a tag ref as moving, since a tag can be re-pointed", () => {
    expect(isMovingGitSource("headroom-ai[proxy] @ git+https://github.com/ExaDev/headroom@v0.39.1")).toBe(true);
  });

  it("treats a full commit SHA as fixed", () => {
    expect(isMovingGitSource("headroom-ai[proxy] @ git+https://github.com/ExaDev/headroom@eb02fa4126450c9905a49394fdec19ae2e7c9c30")).toBe(false);
  });

  it("treats a git spec with no ref as moving, since it follows the remote's default branch", () => {
    expect(isMovingGitSource("headroom-ai[proxy] @ git+https://github.com/ExaDev/headroom")).toBe(true);
  });

  it("does not treat a registry requirement as a git source", () => {
    expect(isMovingGitSource("headroom-ai[proxy]==0.39.1")).toBe(false);
  });
});
