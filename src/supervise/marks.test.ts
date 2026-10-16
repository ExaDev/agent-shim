import { describe, expect, it } from "vitest";

import { createFakeFarmFs, FAKE_NOW_MS, paths } from "../test-helpers";
import { projectDirNameOf } from "../usage/resumeContext";
import { markHooksSettings, recordMark, type MarkContext } from "./marks";
import { readSessionState, writeSessionState } from "./registry";

const POOL = "subs";
const SESSION = "66666666-6666-4666-8666-666666666666";
const CONFIG_DIR = "/state/identities/work";
const CWD = "/work/repo";
const INPUT = 90_000;
const CACHE_READ = 30_000;
const CONTEXT = INPUT + CACHE_READ;
const OLDER = 5_000;
const transcript = `${CONFIG_DIR}/projects/${projectDirNameOf(CWD)}/${SESSION}.jsonl`;
const assistant = (usage: Readonly<Record<string, number>>): string => `${JSON.stringify({ type: "assistant", message: { usage } })}\n`;
const iso = (offsetMs: number): string => new Date(FAKE_NOW_MS + offsetMs).toISOString();

function context(files: Readonly<Record<string, string>>, overrides: Readonly<Partial<MarkContext>> = {}): MarkContext {
  return { fs: createFakeFarmFs(files), paths, now: () => FAKE_NOW_MS, configDir: CONFIG_DIR, cwd: CWD, ...overrides };
}

describe("markHooksSettings", () => {
  const invocation = { command: "/usr/local/bin/node", args: ["/opt/agent shim/cli.cjs"] };

  it("marks the session busy when a prompt is submitted and idle when a turn ends, including one that ended on an error", () => {
    const settings = JSON.parse(markHooksSettings(invocation, "/state", POOL, SESSION)) as { hooks: Record<string, { hooks: { type: string; command: string; timeout: number }[] }[]> };
    expect(Object.keys(settings.hooks).sort()).toEqual(["Stop", "StopFailure", "UserPromptSubmit"]);
    const commandOf = (event: string): string => settings.hooks[event]?.[0]?.hooks[0]?.command ?? "";
    expect(commandOf("UserPromptSubmit")).toBe(`AGENT_SHIM_HOME='/state' '/usr/local/bin/node' '/opt/agent shim/cli.cjs' '__supervise-mark' 'subs' '${SESSION}' 'busy'`);
    expect(commandOf("Stop")).toMatch(/'idle'$/);
    expect(commandOf("StopFailure")).toMatch(/'idle'$/);
    expect(settings.hooks.Stop?.[0]?.hooks[0]).toMatchObject({ type: "command", timeout: expect.any(Number) as number });
  });

  it("quotes a path that holds a quote, so the command stays one command", () => {
    const settings = markHooksSettings({ command: "/it's/node", args: [] }, "/state", POOL, SESSION);
    expect(settings).toContain(String.raw`'/it'\\''s/node'`);
  });
});

describe("recordMark", () => {
  it("records busy without reading the transcript, keeping what was known of the context", () => {
    const ctx = context({});
    writeSessionState(ctx.fs, paths, POOL, SESSION, { mark: "idle", contextTokens: CONTEXT, at: iso(-1) });
    recordMark(ctx, POOL, SESSION, "busy");
    expect(readSessionState(ctx.fs, paths, POOL, SESSION)).toEqual({ mark: "busy", contextTokens: CONTEXT, at: iso(0) });
  });

  it("records idle with the context size of the turn that ended, read from the session's own transcript", () => {
    const ctx = context({ [transcript]: assistant({ input_tokens: INPUT, cache_read_input_tokens: CACHE_READ }) });
    recordMark(ctx, POOL, SESSION, "idle");
    expect(readSessionState(ctx.fs, paths, POOL, SESSION)).toEqual({ mark: "idle", contextTokens: CONTEXT, at: iso(0) });
  });

  it("keeps the last known size when the transcript has no usage yet, and records none when none was known", () => {
    const withoutUsage = context({ [transcript]: `${JSON.stringify({ type: "user" })}\n` });
    recordMark(withoutUsage, POOL, SESSION, "idle");
    expect(readSessionState(withoutUsage.fs, paths, POOL, SESSION)).toEqual({ mark: "idle", at: iso(0) });
    writeSessionState(withoutUsage.fs, paths, POOL, SESSION, { mark: "busy", contextTokens: OLDER, at: iso(-1) });
    recordMark(withoutUsage, POOL, SESSION, "idle");
    expect(readSessionState(withoutUsage.fs, paths, POOL, SESSION)?.contextTokens).toBe(OLDER);
  });

  it("keeps the compacted flag the supervisor set, across marks", () => {
    const ctx = context({});
    writeSessionState(ctx.fs, paths, POOL, SESSION, { mark: "idle", compacted: true, at: iso(-1) });
    recordMark(ctx, POOL, SESSION, "busy");
    expect(readSessionState(ctx.fs, paths, POOL, SESSION)?.compacted).toBe(true);
  });

  it("refuses to record idle when it cannot tell where the transcript is", () => {
    expect(() => {
      recordMark(context({}, { configDir: undefined }), POOL, SESSION, "idle");
    }).toThrow("CLAUDE_CONFIG_DIR is not set");
  });
});
