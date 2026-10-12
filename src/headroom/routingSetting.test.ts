import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildLayoutPaths } from "../paths";
import { NO_ROUTING_SETTING, asksForHeadroom, choiceFor, createRoutingSettingReader, readRoutingSetting, withRoutingChoice, writeRoutingSetting } from "./routingSetting";

describe("the routing setting", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "routing-setting-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("is empty when no file exists", () => {
    expect(readRoutingSetting(buildLayoutPaths(root))).toEqual(NO_ROUTING_SETTING);
  });

  it("round-trips a global and a session setting through the file", () => {
    const paths = buildLayoutPaths(root);
    const global = withRoutingChoice(NO_ROUTING_SETTING, { kind: "global" }, { viaHeadroom: true, immediately: false, nowMs: 5 });
    const both = withRoutingChoice(global, { kind: "session", sessionId: "s" }, { viaHeadroom: false, immediately: true, nowMs: 9 });
    writeRoutingSetting(paths, both);
    expect(readRoutingSetting(paths)).toEqual({ schemaVersion: 1, global: { viaHeadroom: true }, sessions: { s: { viaHeadroom: false, force: 9 } } });
  });

  it("covers a session with its own choice before the global one", () => {
    const setting = withRoutingChoice(
      withRoutingChoice(NO_ROUTING_SETTING, { kind: "global" }, { viaHeadroom: true, immediately: false, nowMs: 0 }),
      { kind: "session", sessionId: "s" },
      { viaHeadroom: false, immediately: false, nowMs: 0 },
    );
    expect(choiceFor(setting, "s")).toEqual({ viaHeadroom: false });
    expect(choiceFor(setting, "t")).toEqual({ viaHeadroom: true });
    expect(choiceFor(NO_ROUTING_SETTING, "s")).toBeUndefined();
  });

  it("reports whether anything asks for headroom", () => {
    expect(asksForHeadroom(NO_ROUTING_SETTING)).toBe(false);
    expect(asksForHeadroom(withRoutingChoice(NO_ROUTING_SETTING, { kind: "session", sessionId: "s" }, { viaHeadroom: true, immediately: false, nowMs: 0 }))).toBe(true);
    expect(asksForHeadroom(withRoutingChoice(NO_ROUTING_SETTING, { kind: "global" }, { viaHeadroom: false, immediately: false, nowMs: 0 }))).toBe(false);
  });

  it("rereads the file through the cached reader only when it changes", () => {
    const paths = buildLayoutPaths(root);
    const read = createRoutingSettingReader(paths);
    expect(read()).toEqual(NO_ROUTING_SETTING);
    writeRoutingSetting(paths, withRoutingChoice(NO_ROUTING_SETTING, { kind: "global" }, { viaHeadroom: true, immediately: false, nowMs: 0 }));
    expect(read().global).toEqual({ viaHeadroom: true });
    writeRoutingSetting(paths, withRoutingChoice(NO_ROUTING_SETTING, { kind: "global" }, { viaHeadroom: false, immediately: false, nowMs: 0 }));
    expect(read().global).toEqual({ viaHeadroom: false });
    fs.rmSync(paths.headroomRoutingFile);
    expect(read()).toEqual(NO_ROUTING_SETTING);
  });
});
