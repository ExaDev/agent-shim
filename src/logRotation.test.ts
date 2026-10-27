import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { realFarmFs } from "./realPorts";
import { createFakeFarmFs } from "./test-helpers";
import { rotateLogIfOver } from "./logRotation";

const LOG = "/logs/daemon.log";
const LIMITS = { maxBytes: 10, keptGenerations: 2 };

function fakeWithLog(contents: string) {
  const fake = createFakeFarmFs({});
  fake.mkdirp("/logs");
  fake.writeFileUtf8(LOG, contents);
  return fake;
}

describe("rotateLogIfOver", () => {
  it("leaves a log at or under the cap untouched", () => {
    const fake = fakeWithLog("0123456789");
    expect(rotateLogIfOver(fake, LOG, LIMITS)).toBe(false);
    expect(fake.readFileUtf8(LOG)).toBe("0123456789");
    expect(fake.lstat(`${LOG}.1`)).toBeUndefined();
  });

  it("treats an absent log as under the cap", () => {
    const fake = createFakeFarmFs({});
    expect(rotateLogIfOver(fake, LOG, LIMITS)).toBe(false);
  });

  it("moves an oversized log to the first generation and empties the live file", () => {
    const fake = fakeWithLog("01234567890");
    expect(rotateLogIfOver(fake, LOG, LIMITS)).toBe(true);
    expect(fake.readFileUtf8(`${LOG}.1`)).toBe("01234567890");
    expect(fake.readFileUtf8(LOG)).toBe("");
  });

  it("shifts each kept generation one place older and drops the oldest", () => {
    const fake = fakeWithLog("newest log text");
    fake.writeFileUtf8(`${LOG}.1`, "first generation");
    fake.writeFileUtf8(`${LOG}.2`, "second generation");
    expect(rotateLogIfOver(fake, LOG, LIMITS)).toBe(true);
    expect(fake.readFileUtf8(`${LOG}.1`)).toBe("newest log text");
    expect(fake.readFileUtf8(`${LOG}.2`)).toBe("first generation");
    expect(fake.lstat(`${LOG}.3`)).toBeUndefined();
  });

  it("keeps a single generation when asked to", () => {
    const fake = fakeWithLog("newest log text");
    fake.writeFileUtf8(`${LOG}.1`, "first generation");
    expect(rotateLogIfOver(fake, LOG, { maxBytes: 10, keptGenerations: 1 })).toBe(true);
    expect(fake.readFileUtf8(`${LOG}.1`)).toBe("newest log text");
    expect(fake.lstat(`${LOG}.2`)).toBeUndefined();
  });

  it("rotates again only once the emptied log has grown past the cap", () => {
    const fake = fakeWithLog("01234567890");
    expect(rotateLogIfOver(fake, LOG, LIMITS)).toBe(true);
    expect(rotateLogIfOver(fake, LOG, LIMITS)).toBe(false);
    fake.writeFileUtf8(LOG, "abcdefghijk");
    expect(rotateLogIfOver(fake, LOG, LIMITS)).toBe(true);
    expect(fake.readFileUtf8(`${LOG}.2`)).toBe("01234567890");
  });
});

describe("rotateLogIfOver on a real file a writer still holds open", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("lets a descriptor opened for appending keep writing into the emptied live file", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-logrotation-"));
    directories.push(directory);
    const log = path.join(directory, "daemon.log");
    const descriptor = fs.openSync(log, "a");
    try {
      fs.writeSync(descriptor, "before the rotation\n");
      expect(rotateLogIfOver(realFarmFs, log, { maxBytes: 5, keptGenerations: 2 })).toBe(true);
      fs.writeSync(descriptor, "after the rotation\n");
    } finally {
      fs.closeSync(descriptor);
    }
    expect(fs.readFileSync(`${log}.1`, "utf8")).toBe("before the rotation\n");
    expect(fs.readFileSync(log, "utf8")).toBe("after the rotation\n");
  });
});
