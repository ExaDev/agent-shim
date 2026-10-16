import path from "node:path";

import type { FarmFs } from "../launcher/ports";

/** What the launch's arguments say about which conversation they continue. */
type ResumeTarget = { readonly kind: "id"; readonly id: string } | { readonly kind: "latest" };

/** The directory name Claude Code keeps a working directory's conversations under: every character that is not a letter or a digit becomes a hyphen. */
export function projectDirNameOf(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/**
 * Which conversation a launch continues, from the arguments claude will receive: `--resume <id>` names one, `--continue` takes the working directory's latest. A bare `--resume` opens a picker, so no conversation is known until the person chooses. Only tokens before a `--` terminator count.
 */
export function resumeTargetOf(passthrough: readonly string[]): ResumeTarget | undefined {
  const end = passthrough.indexOf("--");
  const tokens = end === -1 ? passthrough : passthrough.slice(0, end);
  for (const [index, token] of tokens.entries()) {
    if (token === "--continue" || token === "-c") {
      return { kind: "latest" };
    }
    if (token === "--resume" || token === "-r") {
      const next = tokens[index + 1];
      return next === undefined || next.startsWith("-") ? undefined : { kind: "id", id: next };
    }
    if (token.startsWith("--resume=")) {
      const id = token.slice("--resume=".length);
      return id === "" ? undefined : { kind: "id", id };
    }
  }
  return undefined;
}

/** A token count in a transcript line's `usage`, which must be a non-negative number to count. */
function countOf(usage: object, key: string): number {
  const value: unknown = key in usage ? Reflect.get(usage, key) : undefined;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * The size, in tokens, of the context the conversation's last assistant turn was sent with: its input, cache reads and cache writes together, read from the last assistant line of the transcript that reports `usage`. Undefined when no such line exists.
 */
export function contextTokensOfTranscript(text: string): number | undefined {
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line === undefined || line === "") {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || !("type" in parsed) || parsed.type !== "assistant" || !("message" in parsed)) {
      continue;
    }
    const { message } = parsed;
    if (typeof message !== "object" || message === null || !("usage" in message) || typeof message.usage !== "object" || message.usage === null) {
      continue;
    }
    const { usage } = message;
    return countOf(usage, "input_tokens") + countOf(usage, "cache_read_input_tokens") + countOf(usage, "cache_creation_input_tokens");
  }
  return undefined;
}

/** The transcript most recently written in a project directory, or undefined when it has none. */
function newestTranscript(fs: Pick<FarmFs, "lstat" | "readdir">, projectDir: string): string | undefined {
  let newest: string | undefined;
  let newestMs = -Infinity;
  for (const name of fs.readdir(projectDir)) {
    if (!name.endsWith(".jsonl")) {
      continue;
    }
    const candidate = path.join(projectDir, name);
    const stat = fs.lstat(candidate);
    if (stat?.kind === "file" && stat.mtimeMs > newestMs) {
      newestMs = stat.mtimeMs;
      newest = candidate;
    }
  }
  return newest;
}

/** The id of the working directory's most recently written conversation, which is what `--continue` resumes, or undefined when it has none. */
export function latestConversationId(fs: Pick<FarmFs, "lstat" | "readdir">, params: { readonly claudeHome: string; readonly cwd: string }): string | undefined {
  const file = newestTranscript(fs, path.join(params.claudeHome, "projects", projectDirNameOf(params.cwd)));
  return file === undefined ? undefined : path.basename(file, ".jsonl");
}

/**
 * The context size of the conversation a launch resumes, or undefined when the arguments name none, its transcript is not found under `claudeHome`, or it reports no usage. `--continue` takes the transcript of the working directory most recently written.
 */
export function resumedContextTokens(fs: Pick<FarmFs, "lstat" | "readdir" | "readFileUtf8">, params: { readonly claudeHome: string; readonly cwd: string; readonly passthrough: readonly string[] }): number | undefined {
  const target = resumeTargetOf(params.passthrough);
  if (target === undefined) {
    return undefined;
  }
  const projectDir = path.join(params.claudeHome, "projects", projectDirNameOf(params.cwd));
  const file = target.kind === "id" ? path.join(projectDir, `${target.id}.jsonl`) : newestTranscript(fs, projectDir);
  const text = file === undefined ? undefined : fs.readFileUtf8(file);
  return text === undefined ? undefined : contextTokensOfTranscript(text);
}
