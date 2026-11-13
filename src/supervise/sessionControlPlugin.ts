import { lstatSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { realIsProcessRunning } from "../realPorts";

/**
 * A private, per-launch Claude Code plugin that acts inside the live session on request: the supervisor's channel into its child, and the front door's into every session the launcher loaded it into, supervised or not (`docs/rc-slash-commands.md`).
 *
 * The protocol is one file per request, so several writers (the supervisor's own compaction and the door's goal and compaction verbs) never overwrite each other: a caller writes `requests/<id>.json` (atomically, by renaming a dot-prefixed file into place, since the plugin skips dot files), the plugin writes `results/<id>.json` (first `{ kind: "running" }`, then the outcome), and the caller removes both once it has read the outcome. An id begins with the zero-padded instant the request was made (`sessionControl.ts`), and the plugin handles one request at a time in name order, so the oldest runs first whichever process made it; it never handles a request that already has a result, so a plugin reload (which a compaction can cause) does not run a request twice, and it refuses one whose `expiresAt` has passed, so a request a crashed caller left behind never runs long after the caller gave up. A compaction whose result still reads `running` when the post-compaction event fires is completed then, as the reload lost the call that would have written it.
 *
 * It also records the session it runs in, for a caller that did not launch the session under a supervisor and so has no hooks of its own naming the transcript: on every classic `SessionStart`, `UserPromptSubmit` and `Stop` event it writes `session.json`, the event's `session_id` and `transcript_path`, which is the conversation a request must name and the transcript the door joins to a Remote Control session by its `bridge-session` row. The write is scheduled after the event has been answered, so a write that fails never changes how the session handles the event.
 *
 * What it can do is what the 2.1.319 plugin API gives a plugin: `$.session.compact`, the call `/compact` makes, with optional instructions; `$.command.run`, which runs a slash command as if the person typed it, used for `/goal <condition>` and `/goal clear` only; and `$.prompt.submit` with `asUser`, which submits text as the person's own words for a turn of its own once the session is idle (the model reads it bare, and the transcript records it with `origin: { kind: "plugin", name, asUser: true }`). A bare `/goal` is refused here, because in an interactive session it opens the goal panel and waits for the person to dismiss it; the goal is read from the transcript instead (`sessionGoal.ts`).
 */
export interface SessionControlPlugin {
  readonly directory: string;
  /** Written by the plugin once Claude Code has loaded it, naming the Claude Code version the session runs. */
  readonly ready: string;
  /** Written by the plugin on the session's classic `SessionStart`, `UserPromptSubmit` and `Stop` events: the conversation the session runs and its transcript. */
  readonly session: string;
  readonly requests: string;
  readonly results: string;
  readonly release: () => void;
}

/** The control plugin's name in its manifest: the name Claude Code records as the origin of every prompt it submits (`origin: { kind: "plugin", name }`), which is how the door finds that prompt in the transcript. */
export const SESSION_CONTROL_PLUGIN_NAME = "agent-shim-control";

/** The prefix every staged plugin directory's name starts with, before the staging launcher's pid. */
const STAGED_PREFIX = "agent-shim-control-";

/**
 * Removes the staged plugin directories a launcher left when it was killed before its own release ran (SIGKILL, or a crash): every directory in `parent` named for a launcher pid that is no longer running. Only this user's own entries are touched, since a shared temporary directory holds other users' too.
 */
function removeAbandonedPlugins(parent: string, isRunning: (pid: number) => boolean): void {
  const uid = process.getuid?.();
  for (const name of readdirSync(parent)) {
    const pid = Number(/^agent-shim-control-(\d+)-/u.exec(name)?.[1]);
    if (!name.startsWith(STAGED_PREFIX) || !Number.isInteger(pid) || isRunning(pid)) {
      continue;
    }
    const entry = path.join(parent, name);
    const stat = lstatSync(entry, { throwIfNoEntry: false });
    if (stat?.isDirectory() === true && (uid === undefined || stat.uid === uid)) {
      rmSync(entry, { recursive: true, force: true });
    }
  }
}

/** Creates the in-process control plugin used by one supervised launch, named for this launcher's pid so a later launch can remove it if this one is killed before its release runs; removes the ones killed launchers left first. */
export function stageSessionControlPlugin(options: Readonly<{ parent?: string; pid?: number; isRunning?: (pid: number) => boolean }> = {}): SessionControlPlugin {
  const parent = options.parent ?? tmpdir();
  removeAbandonedPlugins(parent, options.isRunning ?? realIsProcessRunning);
  const directory = mkdtempSync(path.join(parent, `${STAGED_PREFIX}${String(options.pid ?? process.pid)}-`));
  const { ready, session, requests, results } = sessionControlPluginPaths(directory);
  try {
    mkdirSync(path.join(directory, ".claude-plugin"), { mode: 0o700 });
    mkdirSync(path.join(directory, "hooks"), { mode: 0o700 });
    mkdirSync(requests, { mode: 0o700 });
    mkdirSync(results, { mode: 0o700 });
    writeFileSync(path.join(directory, ".claude-plugin", "plugin.json"), JSON.stringify({ name: SESSION_CONTROL_PLUGIN_NAME, version: "2.1.0", description: "Compacts, sets goals and submits a person's turns in sessions agent-shim launched, in process" }), { mode: 0o600 });
    writeFileSync(path.join(directory, "hooks", "hooks.json"), JSON.stringify({ modules: ["./register.js"] }), { mode: 0o600 });
    writeFileSync(path.join(directory, "hooks", "register.js"), pluginSource(ready, session, requests, results), { mode: 0o600 });
    return { directory, ready, session, requests, results, release: () => { rmSync(directory, { recursive: true, force: true }); } };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

/** The paths a plugin staged at `directory` listens on, for a caller (the front door) that knows only the directory the registry's control record names. */
export function sessionControlPluginPaths(directory: string): Pick<SessionControlPlugin, "directory" | "ready" | "session" | "requests" | "results"> {
  return { directory, ready: path.join(directory, "ready.json"), session: path.join(directory, "session.json"), requests: path.join(directory, "requests"), results: path.join(directory, "results") };
}

/** Builds the plugin source with its per-launch paths encoded as JavaScript strings. */
function pluginSource(ready: string, session: string, requests: string, results: string): string {
  // Every helper that takes the plugin API object is declared at the module's top level: Claude Code's loader (2.1.319) refuses a module that passes it to a function declared anywhere else, and loads nothing of the module.
  return `const REQUESTS = ${JSON.stringify(requests)};
const RESULTS = ${JSON.stringify(results)};
function compacted(id, value) {
  return { id, ...(typeof value?.skip === 'string' ? { kind: 'unchanged', skip: value.skip } : { kind: 'compacted', tokensBefore: value?.tokensBefore, tokensAfter: value?.tokensAfter }) };
}
async function resultNames($) {
  return new Set((await $.fs.list(RESULTS)).map((entry) => entry.name));
}
async function recordSession($, event, next) {
  const answer = await next(event);
  if (typeof event?.session_id === 'string' && typeof event?.transcript_path === 'string') {
    const record = JSON.stringify({ conversationId: event.session_id, transcriptPath: event.transcript_path });
    $.clock.after(0, async () => {
      await $.fs.write(${JSON.stringify(session)}, record);
    });
  }
  return answer;
}
export function register(on) {
  let running = false;
  on('classic.SessionStart', recordSession);
  on('classic.UserPromptSubmit', recordSession);
  on('classic.Stop', recordSession);
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
          } else if (item.op === 'turn' && typeof item.text === 'string' && item.text.trim() !== '') {
            const submitted = await $.prompt.submit({ text: item.text, asUser: true });
            if (typeof submitted?.drop === 'string') throw new Error('a hook dropped the prompt: ' + submitted.drop);
            response = { id: item.id, kind: 'submitted', text: submitted?.text, origin: submitted?.origin };
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
