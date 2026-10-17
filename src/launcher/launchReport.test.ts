import { describe, expect, it } from "vitest";

import { decisionRows, farmRow, noteRow, pinnedVersionRow, routingRows } from "./launchReport";

const FEW = 1;
const SEVERAL = 2;
const MANY = 3;
const NONE = { identity: undefined, identitySource: "none", pool: undefined, profile: undefined, provider: undefined, identityCredential: undefined } as const;

describe("decisionRows", () => {
  it("reports the identity and where it was chosen, and nothing about a profile or provider the launch has none of", () => {
    expect(decisionRows({ ...NONE, identity: "work", identitySource: "argv" })).toEqual([{ label: "identity", value: "work", detail: "argv" }]);
  });

  it("names a launch with no identity", () => {
    expect(decisionRows(NONE)).toEqual([{ label: "identity", value: "(none)", detail: "none" }]);
  });

  it("reports the pool with the pick's decisive reason, and leaves the ranking's other reasons out", () => {
    const rows = decisionRows({ ...NONE, identity: "a", pool: { name: "subs", reasons: ["used here 5m ago", "5h reset not scored"] } });
    expect(rows[1]).toEqual({ label: "pool", value: "subs", detail: "used here 5m ago" });
  });

  it("reports the member a resumed conversation left, and why, with the pick's reason under it", () => {
    const rows = decisionRows({ ...NONE, identity: "a", pool: { name: "subs", reasons: ["r1", "r2"], movedOff: { identity: "b", reason: "spent" } } });
    expect(rows[1]).toEqual({ label: "pool", value: "subs", detail: "moved off b: spent", notes: ["r1"] });
  });

  it("reports a pool with no reasons by its name alone", () => {
    expect(decisionRows({ ...NONE, identity: "a", pool: { name: "subs", reasons: [] } })[1]).toEqual({ label: "pool", value: "subs" });
  });

  it("reports the profile, the provider with where its credential comes from, and the identity's own credential", () => {
    const rows = decisionRows({
      ...NONE,
      identity: "a",
      profile: { name: "strict", source: "directory-rule" },
      provider: { name: "z", credential: "bearer from env Z" },
      identityCredential: "oauthToken from op",
    });
    expect(rows.slice(1)).toEqual([
      { label: "profile", value: "strict", detail: "directory-rule" },
      { label: "provider", value: "z", detail: "credential bearer from env Z" },
      { label: "credential", value: "oauthToken from op", detail: "the identity's own" },
    ]);
  });
});

describe("routingRows", () => {
  it("reports nothing for a launch routed through neither the door nor headroom", () => {
    expect(routingRows({ frontDoor: undefined, headroom: undefined, provider: false })).toEqual([]);
  });

  it("says how an OAuth launch reaches the door", () => {
    expect(routingRows({ frontDoor: { port: 4100, connectPort: 4200 }, headroom: undefined, provider: false })).toEqual([
      { label: "routing", value: "front door 127.0.0.1:4100", detail: "OAuth via CONNECT 127.0.0.1:4200" },
    ]);
  });

  it("says nothing about the CONNECT surface for a provider launch, and adds headroom with its project when it is on", () => {
    expect(routingRows({ frontDoor: { port: 4100, connectPort: 4200 }, headroom: { projectId: "/repo" }, provider: true })).toEqual([
      { label: "routing", value: "front door 127.0.0.1:4100" },
      { label: "headroom", value: "on", detail: "project /repo" },
    ]);
  });
});

describe("the other rows", () => {
  it("counts what a resynced farm changed, in the singular where there is one", () => {
    expect(farmRow(MANY, FEW, 0)).toEqual({ label: "farm", value: "resynced", detail: "3 links, 1 built directory" });
    expect(farmRow(FEW, SEVERAL, SEVERAL * SEVERAL)).toEqual({ label: "farm", value: "resynced", detail: "1 link, 2 built directories, 4 adopted" });
  });

  it("says where a pinned Claude Code version came from", () => {
    expect(pinnedVersionRow("2.1.5", "flag")).toEqual({ label: "claude", value: "2.1.5", detail: "pinned by flag" });
  });

  it("carries a note as its own value", () => {
    expect(noteRow("text")).toEqual({ label: "note", value: "text" });
  });
});
