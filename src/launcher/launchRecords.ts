import path from "node:path";
import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { FarmFs } from "./ports";

/**
 * What a launch records about itself from before it resyncs the identity's farm until its child has exited. Between the resync and the spawn the launcher holds no lock and the child does not exist yet, so nothing else says a session is about to start on the identity: a `--delay`, a `--pause`, a version search or a door and headroom start-up can each take as long as they like. A rename reads these records, so it refuses while a launch is in that window instead of moving the directory under it.
 */
const LaunchRecordSchema = z.strictObject({
  /** The launcher's process id, which is what tells a launch in progress from a record a crashed launcher left behind. */
  pid: z.number().int().positive(),
  identity: z.string().min(1),
  startedAt: z.iso.datetime(),
});

/** The filesystem operations the launch records need. */
export type LaunchRecordFs = Pick<FarmFs, "mkdirPrivate" | "writeFilePrivate" | "readFileUtf8" | "readdir" | "removeRecursive">;

/** The launch a record describes. */
export interface LaunchRecordOwner {
  readonly pid: number;
  readonly identity: string;
  readonly startedAtMs: number;
}

const RECORD_SUFFIX = ".json";

/** Each launch has its own record, even when the same process launches the same identity concurrently. */
function recordFile(directory: string, pid: number): string {
  return path.join(directory, `${String(pid)}.${randomUUID()}${RECORD_SUFFIX}`);
}

/** The record in file `name`, or undefined when it is not one: another kind of file, unparseable, or of another shape. */
function readRecord(fs: Pick<LaunchRecordFs, "readFileUtf8">, directory: string, name: string): z.infer<typeof LaunchRecordSchema> | undefined {
  if (!name.endsWith(RECORD_SUFFIX)) {
    return undefined;
  }
  const raw = fs.readFileUtf8(path.join(directory, name));
  if (raw === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const result = LaunchRecordSchema.safeParse(parsed);
  return result.success ? result.data : undefined;
}

/**
 * Records that the launcher `owner.pid` is launching `owner.identity`, and returns what removes the record, which is safe to call more than once. The records of launchers that are no longer running are removed first, so a launcher that crashed leaves nothing behind for long.
 */
export function registerLaunch(fs: LaunchRecordFs, directory: string, owner: LaunchRecordOwner, isRunning: (pid: number) => boolean): () => void {
  fs.mkdirPrivate(directory);
  for (const name of fs.readdir(directory)) {
    const record = readRecord(fs, directory, name);
    if (record !== undefined && !isRunning(record.pid)) {
      fs.removeRecursive(path.join(directory, name));
    }
  }
  const file = recordFile(directory, owner.pid);
  const record: z.infer<typeof LaunchRecordSchema> = { pid: owner.pid, identity: owner.identity, startedAt: new Date(owner.startedAtMs).toISOString() };
  fs.writeFilePrivate(file, `${JSON.stringify(record)}\n`);
  return () => {
    fs.removeRecursive(file);
  };
}

/**
 * The process ids of the launchers that are launching `identity` now: a record of that identity whose process is still running. A record whose process has gone is ignored and left where it is, so asking never changes anything.
 */
export function liveLaunchesOn(fs: Pick<LaunchRecordFs, "readFileUtf8" | "readdir">, directory: string, identity: string, isRunning: (pid: number) => boolean): readonly number[] {
  return fs
    .readdir(directory)
    .flatMap((name) => {
      const record = readRecord(fs, directory, name);
      return record?.identity === identity && isRunning(record.pid) ? [record.pid] : [];
    })
    .sort((left, right) => left - right);
}

/**
 * The identities launcher `pid` has a record for: what tells the front door which identity the launch holding a given capability runs as (the door's session registry is keyed by the same launcher pid). Empty when the launcher has no record, which is every pid that is not a launcher's.
 */
export function launchIdentitiesOf(fs: Pick<LaunchRecordFs, "readFileUtf8" | "readdir">, directory: string, pid: number): readonly string[] {
  return fs.readdir(directory).flatMap((name) => {
    if (!name.startsWith(`${String(pid)}.`)) {
      return [];
    }
    const record = readRecord(fs, directory, name);
    return record?.pid === pid ? [record.identity] : [];
  });
}
