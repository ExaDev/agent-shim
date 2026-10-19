import type { StatuslinePorts } from "./ports";

/** Ports for a test: an empty environment, a home directory that exists nowhere, no readable file, no program that runs and nothing on the file system, each replaceable. */
export function fakeStatuslinePorts(overrides: Readonly<Partial<StatuslinePorts>> = {}): StatuslinePorts {
  return {
    env: {},
    homeDirectory: "/home/test",
    readText: () => undefined,
    run: () => undefined,
    entryKind: () => undefined,
    realPath: () => undefined,
    modifiedAtMs: () => undefined,
    ...overrides,
  };
}
