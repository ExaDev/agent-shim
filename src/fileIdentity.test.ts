import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { fileKey, hasFileNumber, sameFile } from "./fileIdentity";
import { directoryKey, sameDirectory } from "./sameDirectory";

/** Two file numbers an NTFS volume can give neighbouring directories: past 2 to the 53rd power, differing only in the lowest bits, so that as JavaScript numbers they are one value. */
const WELL_PAST_FACTOR = 8;
const EXACT_LIMIT = BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1);
const WELL_PAST_LIMIT = EXACT_LIMIT * BigInt(WELL_PAST_FACTOR);
const FIRST_INO = WELL_PAST_LIMIT + BigInt(1);
const SECOND_INO = WELL_PAST_LIMIT + BigInt(2);
const DEVICE_NUMBER = 3;
const DEV = BigInt(DEVICE_NUMBER);
const NO_INO = BigInt(0);
const SMALL_INO = BigInt(1);

const statOf = (ino: bigint, dev: bigint = DEV): fs.BigIntStats => ({ dev, ino }) as unknown as fs.BigIntStats;

describe("file identity above the exact range of a number", () => {
  it("is where the two file numbers are one number and so would have been one file", () => {
    expect(Number(FIRST_INO)).toBe(Number(SECOND_INO));
  });

  it("tells neighbouring files apart, and a file from itself", () => {
    expect(sameFile(statOf(FIRST_INO), statOf(SECOND_INO))).toBe(false);
    expect(sameFile(statOf(FIRST_INO), statOf(FIRST_INO))).toBe(true);
    expect(sameFile(statOf(FIRST_INO), statOf(FIRST_INO, DEV + SMALL_INO))).toBe(false);
    expect(fileKey(statOf(FIRST_INO))).not.toBe(fileKey(statOf(SECOND_INO)));
    expect(fileKey(statOf(FIRST_INO))).toBe(fileKey(statOf(FIRST_INO)));
  });

  it("gives two directories whose numbers differ in the low bits different keys, and is not one directory", () => {
    const reached: Record<string, fs.BigIntStats> = { "/a": statOf(FIRST_INO), "/b": statOf(SECOND_INO), "/a-again": statOf(FIRST_INO) };
    const stat = (target: string): fs.BigIntStats | undefined => reached[target];
    expect(directoryKey("/a", stat)).not.toBe(directoryKey("/b", stat));
    expect(directoryKey("/a", stat)).toBe(directoryKey("/a-again", stat));
    expect(directoryKey("/missing", stat)).toBeUndefined();
    expect(sameDirectory("/a", "/b", stat)).toBe(false);
    expect(sameDirectory("/a", "/a-again", stat)).toBe(true);
    expect(sameDirectory("/a", "/missing", stat)).toBe(false);
  });

  it("reads a platform that gives no file number as having none", () => {
    expect(hasFileNumber(statOf(NO_INO))).toBe(false);
    expect(hasFileNumber(statOf(SMALL_INO))).toBe(true);
  });

  it("is true of a real directory and of a symlink to it", () => {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR ?? "/tmp"), "file-identity-"));
    try {
      const link = path.join(directory, "link");
      fs.mkdirSync(path.join(directory, "real"));
      fs.symlinkSync(path.join(directory, "real"), link);
      expect(sameDirectory(path.join(directory, "real"), link)).toBe(true);
      expect(directoryKey(link)).toBe(directoryKey(path.join(directory, "real")));
      expect(directoryKey(directory)).not.toBe(directoryKey(path.join(directory, "real")));
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

/**
 * The files that may read a file number: this module's own (through bigint stats) and the sites that use it as a number for something other than identity. Every other `.ino` is a comparison of numbers that loses precision above 2 to the 53rd power, so it is added here only with the reason.
 */
const MAY_READ_INO = new Set([
  // A cache key beside the modification time and size of a file the same process just stat-ed: a hit needs all three to match, so no neighbouring file can be taken for it.
  "identityStore.ts",
  // The replacement signal of the serving binary: a tuple of device, inode, size and modification time, any of which differing is a replacement.
  "supervisor.ts",
  "commands.ts",
  "fileIdentity.ts",
  // Reads its own bigint stat for a revision string, never comparing numbers.
  "realPorts.ts",
]);

describe("reading file numbers", () => {
  it("is done through bigint stats in every file that compares them for identity", () => {
    const sourceDirectory = path.join(__dirname);
    const offenders: string[] = [];
    const visit = (directory: string): void => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          visit(full);
        } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !MAY_READ_INO.has(entry.name)) {
          const text = fs.readFileSync(full, "utf8");
          if (/\.ino\b/u.test(text)) {
            offenders.push(path.relative(sourceDirectory, full));
          }
        }
      }
    };
    visit(sourceDirectory);
    expect(offenders).toEqual([]);
  });
});
