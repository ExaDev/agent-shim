import { SESSION_CONTROL_PLUGIN_NAME } from "./sessionControlPlugin";

/**
 * The turns the control plugin submitted as the person's words, as a supervised session's transcript records them: the one place a process outside the session can confirm that such a turn entered the conversation, and how.
 *
 * The 2.1.319 CLI writes a prompt a plugin submitted with `$.prompt.submit({ text, asUser: true })` as a user row (`{"type":"user","origin":{"kind":"plugin","name":<plugin>,"asUser":true},"message":{"role":"user","content":<text>},...}`), the text bare, as the model reads it. A row with any other origin (the person's own Enter, a peer session, another plugin, a framed plugin prompt) is not one of these.
 */

/** The latest turn the control plugin submitted, and how many the transcript records in all. */
export interface PluginTurns {
  readonly count: number;
  readonly last: { readonly uuid: string; readonly text: string } | undefined;
}

/** The facts of a transcript that records none. */
export const NO_PLUGIN_TURNS: PluginTurns = { count: 0, last: undefined };

/** The guard every row narrowing goes through, per the codebase's `unknown` discipline. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The turns after one transcript line, given the turns before it: one more when the line is a user row the control plugin submitted as the person's words, the same otherwise (including a line that is not JSON, such as one still being written). */
export function pluginTurnsAfterLine(turns: PluginTurns, line: string): PluginTurns {
  if (!line.includes(SESSION_CONTROL_PLUGIN_NAME)) {
    return turns;
  }
  let row: unknown;
  try {
    row = JSON.parse(line);
  } catch {
    return turns;
  }
  if (!isRecord(row) || row.type !== "user" || typeof row.uuid !== "string" || !isRecord(row.origin) || row.origin.kind !== "plugin" || row.origin.name !== SESSION_CONTROL_PLUGIN_NAME || row.origin.asUser !== true || !isRecord(row.message) || typeof row.message.content !== "string") {
    return turns;
  }
  return { count: turns.count + 1, last: { uuid: row.uuid, text: row.message.content } };
}
