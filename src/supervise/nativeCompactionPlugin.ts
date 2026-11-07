import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** A private, per-launch Claude plugin and its request and result files. */
export interface NativeCompactionPlugin {
  readonly directory: string;
  readonly ready: string;
  readonly request: string;
  readonly result: string;
  readonly release: () => void;
}

/** Creates the in-process compaction plugin used by one supervised launch. */
export function stageNativeCompactionPlugin(): NativeCompactionPlugin {
  const directory = mkdtempSync(path.join(tmpdir(), "agent-shim-compact-"));
  const ready = path.join(directory, "ready.json");
  const request = path.join(directory, "request.json");
  const result = path.join(directory, "result.json");
  try {
    mkdirSync(path.join(directory, ".claude-plugin"), { mode: 0o700 });
    mkdirSync(path.join(directory, "hooks"), { mode: 0o700 });
    writeFileSync(path.join(directory, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "agent-shim-compaction", version: "1.0.0", description: "Compacts supervised sessions in process" }), { mode: 0o600 });
    writeFileSync(path.join(directory, "hooks", "hooks.json"), JSON.stringify({ modules: ["./register.js"] }), { mode: 0o600 });
    writeFileSync(path.join(directory, "hooks", "register.js"), pluginSource(ready, request, result), { mode: 0o600 });
    writeFileSync(request, "{}", { mode: 0o600 });
    writeFileSync(result, "{}", { mode: 0o600 });
    return { directory, ready, request, result, release: () => { rmSync(directory, { recursive: true, force: true }); } };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Builds the plugin source with its per-launch file names encoded as JavaScript strings. */
function pluginSource(ready: string, request: string, result: string): string {
  return `export function register(on) {
  let running = false;
  let lastRequest;
  function outcome(id, compacted) {
    return { id, ...(typeof compacted?.skip === 'string' ? { kind: 'unchanged', skip: compacted.skip } : { kind: 'compacted', tokensBefore: compacted?.tokensBefore, tokensAfter: compacted?.tokensAfter }) };
  }
  on('classic.PostCompact', async ($, event, next) => {
    const answer = await next(event);
    $.clock.after(0, async () => {
      const text = await $.fs.read(${JSON.stringify(result)});
      if (typeof text !== 'string') return;
      const current = JSON.parse(text);
      if (current.kind === 'running' && typeof current.id === 'string') {
        await $.fs.write(${JSON.stringify(result)}, JSON.stringify({ id: current.id, kind: 'compacted' }));
      }
    });
    return answer;
  });
  on('session.start', async ($, event, next) => {
    const answer = await next(event);
    await $.fs.write(${JSON.stringify(ready)}, JSON.stringify({ ready: true }));
    $.clock.every(1000, async () => {
      if (running) return;
      running = true;
      try {
        const text = await $.fs.read(${JSON.stringify(request)});
        if (typeof text !== 'string') return;
        const item = JSON.parse(text);
        if (typeof item.id !== 'string' || typeof item.conversationId !== 'string' || item.id === lastRequest) return;
        const priorText = await $.fs.read(${JSON.stringify(result)});
        if (typeof priorText === 'string') {
          const prior = JSON.parse(priorText);
          if (prior.id === item.id) { lastRequest = item.id; return; }
        }
        lastRequest = item.id;
        let response;
        await $.fs.write(${JSON.stringify(result)}, JSON.stringify({ id: item.id, kind: 'running' }));
        try {
          if (await $.session.id() !== item.conversationId) throw new Error('the conversation changed before compaction');
          const compacted = await $.session.compact({});
          response = outcome(item.id, compacted);
        } catch (error) {
          response = { id: item.id, error: String(error) };
        }
        await $.fs.write(${JSON.stringify(result)}, JSON.stringify(response));
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
export function withNativeCompactionPlugin(args: readonly string[], directory: string): readonly string[] {
  const end = args.indexOf("--");
  const result = [...args];
  result.splice(end === -1 ? result.length : end, 0, "--plugin-dir", directory);
  return result;
}
