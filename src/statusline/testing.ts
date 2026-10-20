import type { StatuslinePorts } from "./ports";

/** One call to a fake `readRange`: where it started and how many bytes it asked for. */
interface RangeRead {
  readonly start: number;
  readonly length: number;
}

/** Where a fake `readRange` records its calls. */
export interface ReadLog {
  readonly reads: RangeRead[];
}

/** An empty log for a fake `readRange` to record into. */
export function newReadLog(): ReadLog {
  return { reads: [] };
}

/** `readRange` over in-memory file contents, with the UTF-8 bytes of each file, for a test: every call is recorded in `log`, so a test can say how much was read. */
export function fakeRangeReader(files: Readonly<Record<string, string>>, log: ReadLog = newReadLog()): StatuslinePorts["readRange"] {
  return (path, start, length) => {
    log.reads.push({ start, length });
    const text = files[path];
    if (text === undefined) {
      return undefined;
    }
    const all = new TextEncoder().encode(text);
    return { size: all.length, bytes: all.subarray(start, start + length) };
  };
}

/** Ports for a test: an empty environment, a home directory that exists nowhere, no readable file or range of one, no program that runs and nothing on the file system, each replaceable. */
export function fakeStatuslinePorts(overrides: Readonly<Partial<StatuslinePorts>> = {}): StatuslinePorts {
  return {
    env: {},
    homeDirectory: "/home/test",
    readText: () => undefined,
    readRange: () => undefined,
    run: () => undefined,
    entryKind: () => undefined,
    realPath: () => undefined,
    modifiedAtMs: () => undefined,
    ...overrides,
  };
}
