import { createHash } from "node:crypto";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { cacheFileFor, saveCache } from "./cacheFile";
import { machine } from "./contextFrameTesting";
import { fakeStatuslineFilesystem, fakeStatuslinePorts } from "./testing";

const T0 = Date.parse("2026-10-27T12:00:00.000Z");
const TRANSCRIPT = "/home/test/.claude/projects/p/session.jsonl";
const OTHER_TRANSCRIPT = "/home/test/.claude/projects/p/other.jsonl";
const LAST_TRANSCRIPT = "/home/test/.claude/projects/p/last.jsonl";
/** The thirty days the cache's retention is documented as: a file last written longer ago than this is removed when a new one first appears. */
const RETENTION_DAYS = 30;
const DAY_MS = 86_400_000;
const RETENTION_MS = RETENTION_DAYS * DAY_MS;

describe("cacheFileFor", () => {
  it("names the file by its kind and the digest of the transcript path, in the `session` directory under the state directory, as the configuration model documents", () => {
    const ports = fakeStatuslinePorts();
    const digest = createHash("sha256").update(TRANSCRIPT).digest("hex");
    expect(cacheFileFor(ports, "context", TRANSCRIPT)).toBe(path.join(ports.stateDirectory, "session", `context-${digest}.json`));
  });
});

describe("saveCache", () => {
  it("returns whether no regular file was at the path before the write", () => {
    const ports = fakeStatuslinePorts(fakeStatuslineFilesystem({}).ports);
    const file = cacheFileFor(ports, "speed", TRANSCRIPT);
    expect(saveCache(ports, file, { at: T0 }, T0)).toBe(true);
    expect(saveCache(ports, file, { at: T0 + 1 }, T0 + 1)).toBe(false);
    expect(ports.readText(file)).toBe(JSON.stringify({ at: T0 + 1 }));
  });

  it("returns that no regular file was at the path when a directory or a link stands there", () => {
    const file = cacheFileFor(fakeStatuslinePorts(), "speed", TRANSCRIPT);
    const ports = fakeStatuslinePorts(fakeStatuslineFilesystem({ [`${file}/inside`]: "" }).ports);
    expect(saveCache(ports, file, { at: T0 }, T0)).toBe(true);
    const linked = fakeStatuslinePorts(fakeStatuslineFilesystem({ [OTHER_TRANSCRIPT]: "" }, { [file]: OTHER_TRANSCRIPT }).ports);
    expect(saveCache(linked, file, { at: T0 }, T0)).toBe(true);
  });

  it("returns that the path was empty when the write fails", () => {
    const ports = fakeStatuslinePorts();
    expect(saveCache(ports, cacheFileFor(ports, "speed", TRANSCRIPT), { at: T0 }, T0)).toBe(true);
  });

  it("removes the cache files last written more than thirty days before a new file appears, and keeps one written exactly thirty days before", () => {
    const box = machine();
    const at = (nowMs: number, transcript: string): string => {
      box.at(nowMs);
      const file = cacheFileFor(box.ports, "speed", transcript);
      saveCache(box.ports, file, { at: nowMs }, nowMs);
      return file;
    };
    const oldest = at(T0, TRANSCRIPT);
    const boundary = at(T0 + 1, OTHER_TRANSCRIPT);
    at(T0 + RETENTION_MS + 1, LAST_TRANSCRIPT);
    expect(box.files.has(oldest)).toBe(false);
    expect(box.files.has(boundary)).toBe(true);
  });
});
