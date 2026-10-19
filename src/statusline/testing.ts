import type { StatuslinePorts } from "./ports";

/** Ports for a test: an empty environment, a home directory that exists nowhere, no readable file and no program that runs, each replaceable. */
export function fakeStatuslinePorts(overrides: Readonly<Partial<StatuslinePorts>> = {}): StatuslinePorts {
  return {
    env: {},
    homeDirectory: "/home/test",
    readText: () => undefined,
    run: () => undefined,
    ...overrides,
  };
}
