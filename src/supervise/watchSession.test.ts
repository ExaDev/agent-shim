import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { buildLayoutPaths, type LayoutPaths } from "../paths";
import { realFarmFs } from "../realPorts";
import { fakeLog } from "../test-helpers";
import { announceHook } from "./hookGuard";
import { realWatchDirectory, realWatchExistingDirectory } from "./realPorts";
import { stateDirOf, writeSessionState } from "./registry";
import { watchSessionFiles } from "./watchSession";

const POOL = "pool";
const SESSION = "11111111-1111-4111-8111-111111111111";
const SIBLING = "22222222-2222-4222-8222-222222222222";
const FIRST_CONVERSATION = "33333333-3333-4333-8333-333333333333";
const CLEARED_CONVERSATION = "44444444-4444-4444-8444-444444444444";
const HOOK_PID = 4001;
/** Bounded by the hang guard in vitest.config.ts: event delivery on a machine with far more runnable processes than cores can take longer than a few seconds, and a wait that is satisfied returns at once. */
const WAIT_TIMEOUT_MS = 60_000;
const WAIT_INTERVAL_MS = 10;
/** The names no watch accepts, written last so that the watch has seen every earlier write when one is reported. */
let sentinels = 0;

let root: string;
let paths: LayoutPaths;
let transcripts: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-watch-session-"));
  paths = buildLayoutPaths(root);
  transcripts = path.join(root, "projects", "checkout");
  fs.mkdirSync(transcripts, { recursive: true });
  fs.mkdirSync(stateDirOf(paths, POOL), { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** The names a watch was offered, by directory, and what it did about them: the real watch ports with their `accepts` observed. */
function observedPorts(): { readonly ports: Parameters<typeof watchSessionFiles>[0]["watch"]; readonly offered: Map<string, string[]> } {
  const offered = new Map<string, string[]>();
  const observe = (directory: string, accepts: (filename: string) => boolean): ((filename: string) => boolean) => (filename) => {
    offered.set(directory, [...(offered.get(directory) ?? []), filename]);
    return accepts(filename);
  };
  return {
    offered,
    ports: {
      directory: (directory, accepts, what, log) => realWatchDirectory(directory, observe(directory, accepts), what, log),
      existingDirectory: (directory, accepts, what, log) => realWatchExistingDirectory(directory, observe(directory, accepts), what, log),
    },
  };
}

/** Runs `write` until the watch has called `onChange`. Only for a watch created after `startWatching` returned: the platform's event stream for such a directory may start after the watch is, and drops what is written before it does. A warm watch is written once, since repeated writes leave late events that a later `mockClear` would miss. */
async function expectChange(watching: Watching, write: () => void): Promise<void> {
  await vi.waitFor(() => {
    write();
    expect(watching.onChange).toHaveBeenCalled();
  }, { timeout: WAIT_TIMEOUT_MS, interval: WAIT_INTERVAL_MS });
}

function stateOf(transcript: string | undefined, conversationId?: string): void {
  writeSessionState(realFarmFs, paths, POOL, SESSION, {
    mark: "idle",
    ...(conversationId === undefined ? {} : { conversationId }),
    ...(transcript === undefined ? {} : { transcriptPath: path.join(transcripts, transcript) }),
    at: new Date().toISOString(),
  });
}

/** A started watch. `waitForSentinel` returns once the watch on `directory` has been offered every write made there before the call. */
interface Watching {
  readonly onChange: Mock<() => void>;
  readonly offered: Map<string, string[]>;
  readonly stop: () => void;
  readonly waitForSentinel: (directory: string) => Promise<void>;
}

/** Starts the watch and discards the calls caused by the writes that set the scene before it, which the platform may deliver late. */
async function startWatching(watchTranscript: boolean): Promise<Watching> {
  const { ports, offered } = observedPorts();
  const onChange = vi.fn<() => void>();
  const stop = watchSessionFiles({ paths, pool: POOL, sessionId: SESSION, watchTranscript, fs: realFarmFs, log: fakeLog(), watch: ports })(onChange);
  const watching: Watching = {
    onChange,
    offered,
    stop,
    waitForSentinel: async (directory) => {
      sentinels += 1;
      const name = `sentinel-${String(sentinels)}.tmp`;
      fs.writeFileSync(path.join(directory, name), "");
      await vi.waitFor(() => { expect(offered.get(directory)).toContain(name); }, { timeout: WAIT_TIMEOUT_MS, interval: WAIT_INTERVAL_MS });
    },
  };
  // The platform's event stream may start after `fs.watch` returns and drop what is written before it does, so a warm-up writes until one of its names is offered.
  const warmUp = async (directory: string): Promise<void> => {
    await vi.waitFor(() => {
      sentinels += 1;
      fs.writeFileSync(path.join(directory, `warm-up-${String(sentinels)}.tmp`), "");
      expect(offered.get(directory)?.some((name) => name.startsWith("warm-up-"))).toBe(true);
    }, { timeout: WAIT_TIMEOUT_MS, interval: WAIT_INTERVAL_MS });
    await watching.waitForSentinel(directory);
  };
  await warmUp(stateDirOf(paths, POOL));
  if (watchTranscript) {
    await warmUp(transcripts);
  }
  onChange.mockClear();
  return watching;
}

describe("watchSessionFiles", () => {
  it("does not call onChange for a sibling session's state file or hook announcement", async () => {
    stateOf(undefined);
    const watching = await startWatching(false);
    try {
      const stateDir = stateDirOf(paths, POOL);
      fs.writeFileSync(path.join(stateDir, `${SIBLING}.json`), "{}\n");
      fs.writeFileSync(path.join(stateDir, `${SIBLING}.hook.4001.json`), "{}\n");
      await watching.waitForSentinel(stateDir);
      expect(watching.offered.get(stateDir)).toContain(`${SIBLING}.json`);
      expect(watching.onChange).not.toHaveBeenCalled();
    } finally {
      watching.stop();
    }
  });

  it("calls onChange for the session's own state file and hook announcement", async () => {
    stateOf(undefined);
    const watching = await startWatching(false);
    try {
      stateOf(undefined, FIRST_CONVERSATION);
      await vi.waitFor(() => { expect(watching.onChange).toHaveBeenCalled(); }, { timeout: WAIT_TIMEOUT_MS, interval: WAIT_INTERVAL_MS });
      watching.onChange.mockClear();
      announceHook({ fs: realFarmFs, paths, pid: HOOK_PID, now: Date.now, isRunning: () => true, sleep: () => undefined }, POOL, SESSION);
      const marker = path.join(stateDirOf(paths, POOL), `${SESSION}.hook.${String(HOOK_PID)}.json`);
      await expectChange(watching, () => { fs.writeFileSync(marker, "{}\n"); });
    } finally {
      watching.stop();
    }
  });

  it("does not call onChange for a sibling session's transcript", async () => {
    stateOf("own.jsonl");
    const watching = await startWatching(true);
    try {
      fs.writeFileSync(path.join(transcripts, "sibling.jsonl"), "{}\n");
      await watching.waitForSentinel(transcripts);
      expect(watching.offered.get(transcripts)).toContain("sibling.jsonl");
      expect(watching.onChange).not.toHaveBeenCalled();
    } finally {
      watching.stop();
    }
  });

  it("calls onChange for the transcript the state names", async () => {
    stateOf("own.jsonl");
    const watching = await startWatching(true);
    try {
      await expectChange(watching, () => { fs.writeFileSync(path.join(transcripts, "own.jsonl"), "{}\n"); });
    } finally {
      watching.stop();
    }
  });

  it("follows the transcript a /clear re-points the state to, in the same directory", async () => {
    stateOf("before.jsonl", FIRST_CONVERSATION);
    const watching = await startWatching(true);
    try {
      stateOf("after.jsonl", CLEARED_CONVERSATION);
      await vi.waitFor(() => { expect(watching.onChange).toHaveBeenCalled(); }, { timeout: WAIT_TIMEOUT_MS, interval: WAIT_INTERVAL_MS });
      watching.onChange.mockClear();
      fs.writeFileSync(path.join(transcripts, "before.jsonl"), "{}\n");
      await watching.waitForSentinel(transcripts);
      expect(watching.onChange).not.toHaveBeenCalled();
      await expectChange(watching, () => { fs.writeFileSync(path.join(transcripts, "after.jsonl"), "{}\n"); });
    } finally {
      watching.stop();
    }
  });

  it("moves the transcript watch to the directory a new state names", async () => {
    stateOf("own.jsonl");
    const watching = await startWatching(true);
    const elsewhere = path.join(root, "projects", "elsewhere");
    fs.mkdirSync(elsewhere, { recursive: true });
    try {
      writeSessionState(realFarmFs, paths, POOL, SESSION, { mark: "idle", transcriptPath: path.join(elsewhere, "own.jsonl"), at: new Date().toISOString() });
      await vi.waitFor(() => { expect(watching.onChange).toHaveBeenCalled(); }, { timeout: WAIT_TIMEOUT_MS, interval: WAIT_INTERVAL_MS });
      watching.onChange.mockClear();
      await expectChange(watching, () => { fs.writeFileSync(path.join(elsewhere, "own.jsonl"), "{}\n"); });
    } finally {
      watching.stop();
    }
  });

  it("watches no transcript for a pool that does not compact", async () => {
    stateOf("own.jsonl");
    const watching = await startWatching(false);
    try {
      fs.writeFileSync(path.join(transcripts, "own.jsonl"), "{}\n");
      await watching.waitForSentinel(stateDirOf(paths, POOL));
      expect(watching.offered.has(transcripts)).toBe(false);
      expect(watching.onChange).not.toHaveBeenCalled();
    } finally {
      watching.stop();
    }
  });
});
