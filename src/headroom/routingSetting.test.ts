import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildLayoutPaths } from "../paths";
import { errorWithCode } from "../test-helpers";
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

  it("keeps the setting last read through a stat that fails for the moment, and reads the file as it is once the stat succeeds", () => {
    const paths = buildLayoutPaths(root);
    const read = createRoutingSettingReader(paths);
    writeRoutingSetting(paths, withRoutingChoice(NO_ROUTING_SETTING, { kind: "global" }, { viaHeadroom: true, immediately: false, nowMs: 0 }));
    expect(read().global).toEqual({ viaHeadroom: true });
    const realStat = fs.statSync.bind(fs);
    let failing = true;
    const spy = vi.spyOn(fs, "statSync").mockImplementation(((target: fs.PathLike) => {
      if (failing && target === paths.headroomRoutingFile) throw errorWithCode("EMFILE: too many open files", "EMFILE");
      return realStat(target);
    }));
    try {
      expect(read().global).toEqual({ viaHeadroom: true });
      failing = false;
      writeRoutingSetting(paths, withRoutingChoice(NO_ROUTING_SETTING, { kind: "global" }, { viaHeadroom: false, immediately: false, nowMs: 0 }));
      expect(read().global).toEqual({ viaHeadroom: false });
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps the setting last read through a read of a changed file that fails for the moment, and reads the file again at the next request", () => {
    const paths = buildLayoutPaths(root);
    const read = createRoutingSettingReader(paths);
    writeRoutingSetting(paths, withRoutingChoice(NO_ROUTING_SETTING, { kind: "global" }, { viaHeadroom: true, immediately: false, nowMs: 0 }));
    expect(read().global).toEqual({ viaHeadroom: true });
    writeRoutingSetting(paths, withRoutingChoice(NO_ROUTING_SETTING, { kind: "session", sessionId: "s" }, { viaHeadroom: false, immediately: false, nowMs: 0 }));
    const realRead = fs.readFileSync.bind(fs);
    let failing = true;
    const failingRead = (target: fs.PathOrFileDescriptor, encoding: BufferEncoding): string => {
      if (failing && target === paths.headroomRoutingFile) throw errorWithCode("EMFILE: too many open files", "EMFILE");
      return realRead(target, encoding);
    };
    // `readFileSync` is overloaded and a mock must take its whole type, which no one-signature function has; the setting is read as text only.
    const spy = vi.spyOn(fs, "readFileSync").mockImplementation(failingRead as typeof fs.readFileSync);
    try {
      expect(read().global).toEqual({ viaHeadroom: true });
      failing = false;
      expect(read()).toEqual({ schemaVersion: 1, sessions: { s: { viaHeadroom: false } } });
    } finally {
      spy.mockRestore();
    }
  });
});
