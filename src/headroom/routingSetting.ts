import fs from "node:fs";

import { z } from "zod";

import { readJson, writeJsonAtomic } from "../config/store";
import type { LayoutPaths } from "../paths";

/** What one setting says: whether the sessions it covers go through headroom, and, when set, the moment the person asked for it to apply at once rather than at each session's next cache boundary. */
const RoutingChoiceSchema = z.strictObject({
  viaHeadroom: z.boolean(),
  /** A token that changes with every `--now` request (the moment it was made). A session applies it once, immediately, and then goes back to waiting for a boundary. */
  force: z.number().optional(),
});
export type RoutingChoice = z.infer<typeof RoutingChoiceSchema>;

const RoutingSettingSchema = z.strictObject({
  schemaVersion: z.literal(1),
  /** Every session with no setting of its own. Absent means each session's launch flag decides. */
  global: RoutingChoiceSchema.optional(),
  /** One session's own setting, by launch session id, outranking the global one. */
  sessions: z.record(z.string(), RoutingChoiceSchema),
});
export type RoutingSetting = z.infer<typeof RoutingSettingSchema>;

/** What no file means: every session's launch flag decides. */
export const NO_ROUTING_SETTING: RoutingSetting = { schemaVersion: 1, sessions: {} };

/** Reads the setting: the empty one when the file does not exist. A file that exists but is not valid throws `ConfigValidationError`, so a damaged file fails loudly instead of silently reverting every session to its launch flag. */
export function readRoutingSetting(paths: LayoutPaths): RoutingSetting {
  return readJson(paths.headroomRoutingFile, RoutingSettingSchema) ?? NO_ROUTING_SETTING;
}

/** Writes the setting atomically. */
export function writeRoutingSetting(paths: LayoutPaths, setting: RoutingSetting): void {
  writeJsonAtomic(paths.headroomRoutingFile, setting);
}

/** Which sessions a change covers. */
export type RoutingScope = { readonly kind: "global" } | { readonly kind: "session"; readonly sessionId: string };

/** The setting after one change. `nowMs` is the force token when `immediately` is set. */
export function withRoutingChoice(setting: RoutingSetting, scope: RoutingScope, change: { readonly viaHeadroom: boolean; readonly immediately: boolean; readonly nowMs: number }): RoutingSetting {
  const choice: RoutingChoice = { viaHeadroom: change.viaHeadroom, ...(change.immediately ? { force: change.nowMs } : {}) };
  return scope.kind === "global" ? { ...setting, global: choice } : { ...setting, sessions: { ...setting.sessions, [scope.sessionId]: choice } };
}

/** The setting that covers a session: its own, else the global one, else none (its launch flag decides). */
export function choiceFor(setting: RoutingSetting, sessionId: string | undefined): RoutingChoice | undefined {
  return (sessionId === undefined ? undefined : setting.sessions[sessionId]) ?? setting.global;
}

/** Whether any setting asks for headroom, which is what keeps the daemon wanted by the door itself. */
export function asksForHeadroom(setting: RoutingSetting): boolean {
  return setting.global?.viaHeadroom === true || Object.values(setting.sessions).some((choice) => choice.viaHeadroom);
}

/**
 * A reader of the setting for a process that consults it on every request: the file is re-read only when its modification time or size changes, so the per-request cost is one `stat`. A missing file is the empty setting.
 */
export function createRoutingSettingReader(paths: LayoutPaths): () => RoutingSetting {
  let cachedKey: string | undefined;
  let cached: RoutingSetting = NO_ROUTING_SETTING;
  return () => {
    let key: string;
    try {
      const stat = fs.statSync(paths.headroomRoutingFile);
      key = `${String(stat.mtimeMs)}:${String(stat.size)}`;
    } catch {
      cachedKey = undefined;
      cached = NO_ROUTING_SETTING;
      return cached;
    }
    if (key !== cachedKey) {
      cached = readRoutingSetting(paths);
      cachedKey = key;
    }
    return cached;
  };
}
