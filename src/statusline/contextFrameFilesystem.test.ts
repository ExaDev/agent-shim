import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveStatusline } from "../config/statusline";
import { cacheFileFor } from "./cacheFile";
import { CONTEXT_WRITE_INTERVAL_MS, contextFrameOf, MAX_CONTEXT_RECORDS } from "./contextFrame";
import { parseClientPayload, viewOf, type ContextWindowFrame } from "./payload";
import { realStatuslinePorts, type StatuslinePorts } from "./ports";
import { GOOD, GOOD_PERCENT, POST_TOKENS, SECOND, stripAnsi, ZERO } from "./contextFrameTesting";
import { renderStatuslineBlock } from "./render";
import { fakeStatuslineSummary } from "./testing";

/** How long before the clock the oldest of the records filling the cap was written; the rest follow a second apart, all of them before the record a test writes. */
const SEED_AGE_SECONDS = 1_000;
const SEED_AGE_MS = SEED_AGE_SECONDS * SECOND;
/** How far before the oldest record, or after the newest, an entry named like a record is stamped. */
const ODD_ENTRY_MARGIN_SECONDS = 10;
const ODD_ENTRY_MARGIN_MS = ODD_ENTRY_MARGIN_SECONDS * SECOND;

let directory: string;
let ports: StatuslinePorts;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "statusline-context-"));
  ports = realStatuslinePorts({}, path.join(directory, "state"));
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true });
});

/** Sets a path's access and modification times, a final link followed, to `ms` since the epoch. */
function stamp(target: string, ms: number): void {
  fs.utimesSync(target, ms / SECOND, ms / SECOND);
}

/** The record file of `transcript` in the session state. */
function recordOf(transcript: string): string {
  return cacheFileFor(ports, "context", transcript);
}

/** Writes `count` records for transcripts of their own, a second apart, the first `SEED_AGE_MS` before `nowMs`, and returns their files, oldest first. */
function seedRecords(count: number, nowMs: number): string[] {
  return Array.from({ length: count }, (_, index) => {
    const file = recordOf(`/seed/${String(index)}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{}");
    stamp(file, nowMs - SEED_AGE_MS + index * SECOND);
    return file;
  });
}

/** The regular files named like a context record in the session state. */
function regularRecords(): string[] {
  const session = path.dirname(recordOf("/any.jsonl"));
  return fs
    .readdirSync(session, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.startsWith("context-") && entry.name.endsWith(".json"))
    .map((entry) => path.join(session, entry.name));
}

function draw(transcriptPath: string, frame: ContextWindowFrame, nowMs: number): ContextWindowFrame | undefined {
  return contextFrameOf({ ports, transcriptPath, frame, drawsPercent: false, nowMs, compaction: () => undefined });
}

/** Puts a directory holding a file, or a link to a file outside the session state, at `at`, stamped `ms`. */
function oddEntry(kind: "directory" | "link", at: string, ms: number): void {
  fs.mkdirSync(path.dirname(at), { recursive: true });
  if (kind === "directory") {
    fs.mkdirSync(at);
    fs.writeFileSync(path.join(at, "inside"), "x");
    stamp(at, ms);
    return;
  }
  const target = path.join(directory, "elsewhere.json");
  fs.writeFileSync(target, "{}");
  stamp(target, ms);
  fs.symlinkSync(target, at);
}

describe("the record cap on the file system", () => {
  it.each([
    ["directory", "oldest"],
    ["directory", "newest"],
    ["link", "oldest"],
    ["link", "newest"],
  ] as const)("neither counts nor removes a %s named like a record, stamped as the %s, as claude-hud's sweep takes only regular files", (kind, position) => {
    const nowMs = Date.now();
    const seeds = seedRecords(MAX_CONTEXT_RECORDS, nowMs);
    const odd = recordOf("/odd.jsonl");
    oddEntry(kind, odd, position === "oldest" ? nowMs - SEED_AGE_MS - ODD_ENTRY_MARGIN_MS : nowMs - ODD_ENTRY_MARGIN_MS);
    draw("/new.jsonl", GOOD, nowMs);
    expect(fs.lstatSync(odd).isDirectory()).toBe(kind === "directory");
    expect(fs.existsSync(kind === "directory" ? path.join(odd, "inside") : path.join(directory, "elsewhere.json"))).toBe(true);
    expect(regularRecords().sort()).toEqual([...seeds.slice(1), recordOf("/new.jsonl")].sort());
  });

  it.each(["directory", "link"] as const)("scans for the cap when a %s, not a regular file, is at the record's own path, whether or not the write over it succeeds", (kind) => {
    const nowMs = Date.now();
    const seeds = seedRecords(MAX_CONTEXT_RECORDS + 1, nowMs);
    const own = recordOf("/new.jsonl");
    if (kind === "directory") {
      // Stamped before the write interval, which a directory's time counts towards as a file's does.
      oddEntry("directory", own, nowMs - SEED_AGE_MS - ODD_ENTRY_MARGIN_MS);
    } else {
      fs.symlinkSync(path.join(directory, "missing.json"), own);
    }
    draw("/new.jsonl", GOOD, nowMs);
    // A write over the directory fails and leaves it; one over the dangling link replaces the link with the record.
    const written = kind === "link" ? [own] : [];
    const kept = MAX_CONTEXT_RECORDS - written.length;
    expect(regularRecords().sort()).toEqual([...seeds.slice(seeds.length - kept), ...written].sort());
  });

  it.each(["directory", "link"] as const)("neither writes nor scans for the cap when a %s at the record's own path was modified within the write interval, as claude-hud's gate reads the time of whatever the path names", (kind) => {
    const nowMs = Date.now();
    const seeds = seedRecords(MAX_CONTEXT_RECORDS + 1, nowMs);
    const own = recordOf("/new.jsonl");
    oddEntry(kind, own, nowMs - SECOND);
    draw("/new.jsonl", GOOD, nowMs);
    expect(fs.lstatSync(own).isDirectory()).toBe(kind === "directory");
    expect(fs.lstatSync(own).isSymbolicLink()).toBe(kind === "link");
    expect(regularRecords().sort()).toEqual([...seeds].sort());
  });

  it("counts and removes a record modified at the epoch as the oldest, with the clock close enough after the epoch that the retention of the session state does not remove it first", () => {
    // Any later clock leaves the record past `CACHE_RETENTION_MS`, so the sweep a new file's write runs removes it before the cap counts.
    const nowMs = 2 * SEED_AGE_MS;
    const seeds = seedRecords(MAX_CONTEXT_RECORDS, nowMs);
    const [epoch, ...rest] = seeds;
    if (epoch === undefined) {
      throw new Error("no record was seeded");
    }
    stamp(epoch, 0);
    draw("/new.jsonl", GOOD, nowMs);
    expect(regularRecords().sort()).toEqual([...rest, recordOf("/new.jsonl")].sort());
  });
});

describe("the record read on the file system", () => {
  it("is read through a final symbolic link to a regular file", () => {
    const nowMs = Date.now();
    draw("/kept.jsonl", GOOD, nowMs);
    const own = recordOf("/linked.jsonl");
    fs.symlinkSync(recordOf("/kept.jsonl"), own);
    expect(draw("/linked.jsonl", ZERO, nowMs + SECOND)?.used_percentage).toBe(GOOD_PERCENT);
  });

  it.skipIf(process.platform === "win32")("is read as none, without being opened, when a FIFO is at the record's path", () => {
    const nowMs = Date.now();
    const own = recordOf("/fifo.jsonl");
    fs.mkdirSync(path.dirname(own), { recursive: true });
    fs.writeFileSync(path.join(directory, "record.json"), JSON.stringify({ savedAtMs: nowMs - SECOND, observedAtMs: nowMs - SECOND, usedPercentage: GOOD_PERCENT }));
    execFileSync("mkfifo", [own]);
    // A writer that writes a record and exits once a reader opens the FIFO keeps a regression from blocking this test: one that opens the FIFO restores that record, where the FIFO must be read as none.
    const writer = spawn("/bin/sh", ["-c", 'cat "$0" > "$1"', path.join(directory, "record.json"), own], { stdio: "ignore" });
    try {
      expect(draw("/fifo.jsonl", ZERO, nowMs)).toBe(ZERO);
    } finally {
      writer.kill("SIGKILL");
    }
  });
});

describe("the record write on the file system", () => {
  it.skipIf(process.platform === "win32")("replaces a FIFO at the record's path, modified longer ago than the write interval, with the record of a good frame, without opening it, where claude-hud writes into the FIFO", () => {
    const nowMs = Date.now();
    const own = recordOf("/fifo.jsonl");
    fs.mkdirSync(path.dirname(own), { recursive: true });
    execFileSync("mkfifo", [own]);
    stamp(own, nowMs - CONTEXT_WRITE_INTERVAL_MS - SECOND);
    // A reader that drains the FIFO keeps a regression from blocking this test: one that opens the FIFO for writing writes the record into it and leaves the FIFO in place, where the record must replace it.
    const reader = spawn("/bin/sh", ["-c", 'cat "$0" > /dev/null', own], { stdio: "ignore" });
    try {
      expect(draw("/fifo.jsonl", GOOD, nowMs)).toBe(GOOD);
    } finally {
      reader.kill("SIGKILL");
    }
    expect(fs.lstatSync(own).isFile()).toBe(true);
    expect(draw("/fifo.jsonl", ZERO, nowMs + SECOND)?.used_percentage).toBe(GOOD_PERCENT);
  });
});

describe("the record key on the file system", () => {
  it("is the path as written, resolved without following links, so a transcript reached through a linked directory keeps a record of its own, as claude-hud keys it", () => {
    const real = path.join(directory, "real");
    fs.mkdirSync(real);
    fs.writeFileSync(path.join(real, "t.jsonl"), "");
    fs.symlinkSync(real, path.join(directory, "linked"));
    const nowMs = Date.now();
    draw(path.join(directory, "linked", "t.jsonl"), GOOD, nowMs);
    expect(draw(path.join(real, "t.jsonl"), ZERO, nowMs + CONTEXT_WRITE_INTERVAL_MS)).toBe(ZERO);
  });
});

describe("the compaction of a transcript on the file system", () => {
  it("is read through a final symbolic link to the transcript, as claude-hud reads the path as sent", () => {
    const transcript = path.join(directory, "t.jsonl");
    const nowMs = Date.now();
    fs.writeFileSync(transcript, `${JSON.stringify({ type: "system", subtype: "compact_boundary", timestamp: new Date(nowMs - SECOND).toISOString(), compactMetadata: { postTokens: POST_TOKENS } })}\n`);
    const link = path.join(directory, "link.jsonl");
    fs.symlinkSync(transcript, link);
    const payload = parseClientPayload({ transcript_path: link, context_window: ZERO });
    const line = renderStatuslineBlock({ summary: fakeStatuslineSummary(), view: viewOf(payload), payload, terminalWidth: 200, nowMs, settings: resolveStatusline({ layout: { header: [], rows: ["context"] }, bar: { width: 10 } }), ports });
    expect(stripAnsi(line)).toMatch(/^Ctx 0\/200k \[.*\] 15%$/);
  });
});
