import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * A private, per-launch Claude Code plugin that acts inside the live session on request: the supervisor's channel into its child, which the front door also uses for the sessions a supervisor advertises it for.
 *
 * The protocol is one file per request, so several writers (the supervisor's own compaction and the door's goal and compaction verbs) never overwrite each other: a caller writes `requests/<id>.json` (atomically, by renaming a dot-prefixed file into place, since the plugin skips dot files), the plugin writes `results/<id>.json` (first `{ kind: "running" }`, then the outcome), and the caller removes both once it has read the outcome. An id begins with the zero-padded instant the request was made (`sessionControl.ts`), and the plugin handles one request at a time in name order, so the oldest runs first whichever process made it; it never handles a request that already has a result, so a plugin reload (which a compaction can cause) does not run a request twice, and it refuses one whose `expiresAt` has passed, so a request a crashed caller left behind never runs long after the caller gave up. A compaction whose result still reads `running` when the post-compaction event fires is completed then, as the reload lost the call that would have written it.
 *
 * What it can do is what the 2.1.319 plugin API gives a plugin: `$.session.compact`, the call `/compact` makes, with optional instructions; and `$.command.run`, which runs a slash command as if the person typed it, used for `/goal <condition>` and `/goal clear` only. A bare `/goal` is refused here, because in an interactive session it opens the goal panel and waits for the person to dismiss it; the goal is read from the transcript instead (`sessionGoal.ts`).
 */
export interface SessionControlPlugin {
  readonly directory: string;
  /** Written by the plugin once Claude Code has loaded it, naming the Claude Code version the session runs. */
  readonly ready: string;
  readonly requests: string;
  readonly results: string;
  readonly release: () => void;
}

/** Creates the in-process control plugin used by one supervised launch. */
export function stageSessionControlPlugin(): SessionControlPlugin {
  const directory = mkdtempSync(path.join(tmpdir(), "agent-shim-control-"));
  const { ready, requests, results } = sessionControlPluginPaths(directory);
  try {
    mkdirSync(path.join(directory, ".claude-plugin"), { mode: 0o700 });
    mkdirSync(path.join(directory, "hooks"), { mode: 0o700 });
    mkdirSync(requests, { mode: 0o700 });
    mkdirSync(results, { mode: 0o700 });
    writeFileSync(path.join(directory, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "agent-shim-control", version: "2.0.0", description: "Compacts and sets goals in supervised sessions in process" }), { mode: 0o600 });
    writeFileSync(path.join(directory, "hooks", "hooks.json"), JSON.stringify({ modules: ["./register.js"] }), { mode: 0o600 });
    writeFileSync(path.join(directory, "hooks", "register.js"), pluginSource(ready, requests, results), { mode: 0o600 });
    return { directory, ready, requests, results, release: () => { rmSync(directory, { recursive: true, force: true }); } };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

/** The paths a plugin staged at `directory` listens on, for a caller (the front door) that knows only the directory the registry's control record names. */
export function sessionControlPluginPaths(directory: string): Pick<SessionControlPlugin, "directory" | "ready" | "requests" | "results"> {
  return { directory, ready: path.join(directory, "ready.json"), requests: path.join(directory, "requests"), results: path.join(directory, "results") };
}

/** Builds the plugin source with its per-launch paths encoded as JavaScript strings. */
function pluginSource(ready: string, requests: string, results: string): string {
  // Every helper that takes the plugin API object is declared at the module's top level: Claude Code's loader (2.1.319) refuses a module that passes it to a function declared anywhere else, and loads nothing of the module.
  return `const REQUESTS = ${JSON.stringify(requests)};
const RESULTS = ${JSON.stringify(results)};
function compacted(id, value) {
  return { id, ...(typeof value?.skip === 'string' ? { kind: 'unchanged', skip: value.skip } : { kind: 'compacted', tokensBefore: value?.tokensBefore, tokensAfter: value?.tokensAfter }) };
}
async function resultNames($) {
  return new Set((await $.fs.list(RESULTS)).map((entry) => entry.name));
}
export function register(on) {
  let running = false;
  on('classic.PostCompact', async ($, event, next) => {
    const answer = await next(event);
    $.clock.after(0, async () => {
      for (const name of await resultNames($)) {
        const text = await $.fs.read(RESULTS + '/' + name);
        if (typeof text !== 'string') continue;
        const current = JSON.parse(text);
        if (current.kind === 'running' && current.op === 'compact' && typeof current.id === 'string') {
          await $.fs.write(RESULTS + '/' + name, JSON.stringify({ id: current.id, kind: 'compacted' }));
        }
      }
    });
    return answer;
  });
  on('session.start', async ($, event, next) => {
    const answer = await next(event);
    const version = await $.session.version();
    await $.fs.write(${JSON.stringify(ready)}, JSON.stringify({ ready: true, version: version.version }));
    $.clock.every(1000, async () => {
      if (running) return;
      running = true;
      try {
        const done = await resultNames($);
        const names = (await $.fs.list(REQUESTS)).map((entry) => entry.name).filter((name) => !name.startsWith('.') && name.endsWith('.json') && !done.has(name)).sort();
        const name = names[0];
        if (name === undefined) return;
        const text = await $.fs.read(REQUESTS + '/' + name);
        if (typeof text !== 'string') return;
        const item = JSON.parse(text);
        if (typeof item.id !== 'string' || name !== item.id + '.json') {
          await $.fs.write(RESULTS + '/' + name, JSON.stringify({ id: name.slice(0, -5), error: 'the request is not one this plugin reads' }));
          return;
        }
        await $.fs.write(RESULTS + '/' + name, JSON.stringify({ id: item.id, kind: 'running', op: item.op }));
        let response;
        try {
          if (typeof item.expiresAt !== 'number' || await $.clock.now() >= item.expiresAt) throw new Error('the request expired before the session could run it, so it was not run');
          if (typeof item.conversationId !== 'string' || await $.session.id() !== item.conversationId) throw new Error('the conversation changed before the request ran');
          if (item.op === 'compact') {
            response = compacted(item.id, await $.session.compact(typeof item.instructions === 'string' ? { instructions: item.instructions } : {}));
          } else if (item.op === 'goal' && typeof item.args === 'string' && item.args.trim() !== '') {
            const ran = await $.command.run({ command: 'goal', args: item.args });
            response = { id: item.id, kind: 'ran', ...(typeof ran?.text === 'string' ? { text: ran.text } : {}) };
          } else {
            throw new Error('the request names no operation this plugin performs');
          }
        } catch (error) {
          response = { id: item.id, error: error instanceof Error ? error.message : String(error) };
        }
        await $.fs.write(RESULTS + '/' + name, JSON.stringify(response));
      } finally {
        running = false;
      }
    });
    return answer;
  });
}
`;
}

/** Adds this launch's plugin without replacing caller-supplied plugin options or crossing an option terminator. */
export function withSessionControlPlugin(args: readonly string[], directory: string): readonly string[] {
  const end = args.indexOf("--");
  const result = [...args];
  result.splice(end === -1 ? result.length : end, 0, "--plugin-dir", directory);
  return result;
}
