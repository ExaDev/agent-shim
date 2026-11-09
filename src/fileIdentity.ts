import type fs from "node:fs";

/** What identifies a file on disk: the device and the file number the filesystem gives it. */
export type FileId = Pick<fs.BigIntStats, "dev" | "ino">;

/**
 * Whether two stats are one file: equal device and file number. Read as bigints (`statSync(path, { bigint: true })`), since a file number above 2 to the 53rd power (a Windows NTFS file id whose sequence number is 32 or more) is not exact as a JavaScript number, and two neighbouring files would then compare as one.
 */
export function sameFile(first: Readonly<FileId>, second: Readonly<FileId>): boolean {
  return first.dev === second.dev && first.ino === second.ino;
}

/** A string that is equal for two stats exactly when `sameFile` holds. */
export function fileKey(stat: Readonly<FileId>): string {
  return `${String(stat.dev)}:${String(stat.ino)}`;
}

/** The file number a platform that gives none reports. */
const NO_FILE_NUMBER = BigInt(0);

/** Whether the filesystem reported a file number: a platform that gives none reads as zero, which would make every file the same one. */
export function hasFileNumber(stat: Readonly<FileId>): boolean {
  return stat.ino !== NO_FILE_NUMBER;
}
