import path from "node:path";

import { resolveStatusline } from "../config/statusline";
import type { RenderContext } from "./elements/context";
import type { StatuslineSummary } from "./enrich";
import { createPalette } from "./palette";
import { parseClientPayload } from "./payload";
import type { FileRange, StatuslinePorts } from "./ports";

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
  return (file, start, length) => {
    log.reads.push({ start, length });
    const text = files[file];
    if (text === undefined) {
      return undefined;
    }
    const all = new TextEncoder().encode(text);
    const range: FileRange = { size: all.length, bytes: all.subarray(start, start + length) };
    return range;
  };
}

/** The width a fake render context is as wide as. */
const FAKE_TERMINAL_WIDTH = 120;

/** A summary of a session the door knows nothing about, with any field replaceable. */
export function fakeStatuslineSummary(overrides: Readonly<Partial<StatuslineSummary>> = {}): StatuslineSummary {
  return {
    identity: undefined,
    provider: undefined,
    providerAccountEmail: undefined,
    providerAccountSub: undefined,
    providerPlan: undefined,
    loginAccountEmail: undefined,
    loginRateLimitTier: undefined,
    loginOrganizationName: undefined,
    loginOrganizationType: undefined,
    loginSeatTier: undefined,
    loginPlan: undefined,
    fiveHourUsed: undefined,
    fiveHourResetAt: undefined,
    sevenDayUsed: undefined,
    sevenDayResetAt: undefined,
    providerQuotaWindows: [],
    quotaFamilies: [],
    headroom: undefined,
    ...overrides,
  };
}

/** What an element is given, for a test: a session the door knows nothing about, an empty client payload, default settings, no colour and ports that read nothing, with any part replaceable. `payload` is the raw JSON the client would send. */
export function fakeRenderContext(overrides: Readonly<Partial<Omit<RenderContext, "payload">>> & { readonly payload?: unknown } = {}): RenderContext {
  const settings = overrides.settings ?? resolveStatusline(undefined);
  return {
    summary: fakeStatuslineSummary(),
    view: { modelDisplayName: undefined, contextUsedPercentage: undefined, contextTotalTokens: undefined, contextWindowTokens: undefined, cacheHitRatio: undefined, cacheReadTokens: undefined, freshInputTokens: undefined },
    nowMs: 0,
    terminalWidth: FAKE_TERMINAL_WIDTH,
    width: FAKE_TERMINAL_WIDTH,
    palette: createPalette(settings.colours, false),
    ports: fakeStatuslinePorts(),
    transcriptIdentity: () => ({ model: undefined, advisor: undefined }),
    ...overrides,
    settings,
    payload: parseClientPayload(overrides.payload ?? {}),
  };
}

/** Ports for a test: an empty environment, a home directory that exists nowhere, a 24-hour British clock in UTC, no readable file or range of one, no listable directory, no program that runs, nothing on the file system and no memory figure, each replaceable. */
export function fakeStatuslinePorts(overrides: Readonly<Partial<StatuslinePorts>> = {}): StatuslinePorts {
  return {
    env: {},
    homeDirectory: "/home/test",
    stateDirectory: "/state/test",
    clock: { locale: "en-GB", timeZone: "UTC" },
    readText: () => undefined,
    readRange: () => undefined,
    listDirectory: () => undefined,
    writeText: () => undefined,
    removePath: () => undefined,
    run: () => undefined,
    entryKind: () => undefined,
    realPath: () => undefined,
    modifiedAtMs: () => undefined,
    memoryUse: () => undefined,
    ...overrides,
  };
}

/** The filesystem ports of an in-memory tree, with the tree itself: `initial` maps absolute paths to their text, a directory exists wherever a file lies beneath it, `links` maps a path to the path it resolves to, and every write lands in `files`. */
export interface FakeStatuslineFilesystem {
  readonly ports: Pick<StatuslinePorts, "readText" | "readRange" | "entryKind" | "listDirectory" | "realPath" | "writeText" | "removePath">;
  readonly files: Map<string, string>;
}

export function fakeStatuslineFilesystem(initial: Readonly<Record<string, string>>, links: Readonly<Record<string, string>> = {}): FakeStatuslineFilesystem {
  const files = new Map(Object.entries(initial));
  const resolve = (target: string): string => {
    const linked = Object.entries(links).find(([from]) => target === from || target.startsWith(`${from}/`));
    return linked === undefined ? target : `${linked[1]}${target.slice(linked[0].length)}`;
  };
  const beneath = (directory: string): string[] => [...files.keys()].filter((file) => file.startsWith(`${directory}/`));
  return {
    files,
    ports: {
      readText: (target) => files.get(resolve(target)),
      readRange: (target, start, length) => {
        const text = files.get(resolve(target));
        if (text === undefined) {
          return undefined;
        }
        const all = new TextEncoder().encode(text);
        return { size: all.length, bytes: all.subarray(start, start + length) };
      },
      entryKind: (target) => {
        // Like lstat: a path that is itself a link is `other`, whatever it points at.
        if (target in links) {
          return "other";
        }
        const resolved = resolve(target);
        if (files.has(resolved)) {
          return "other";
        }
        return beneath(resolved).length > 0 ? "directory" : undefined;
      },
      listDirectory: (target) => {
        const resolved = resolve(target);
        const below = beneath(resolved);
        return below.length === 0 ? undefined : [...new Set(below.map((file) => file.slice(resolved.length + 1).split("/")[0] ?? ""))];
      },
      realPath: (target) => {
        const resolved = resolve(target);
        return files.has(resolved) || beneath(resolved).length > 0 ? resolved : undefined;
      },
      writeText: (target, text) => {
        files.set(path.normalize(target), text);
      },
      removePath: (target) => {
        const normalised = path.normalize(target);
        for (const file of [...files.keys()]) {
          if (file === normalised || file.startsWith(`${normalised}/`)) {
            files.delete(file);
          }
        }
      },
    },
  };
}
