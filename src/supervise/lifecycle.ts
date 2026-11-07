import path from "node:path";

import { z } from "zod";

import type { FarmFs, LogPort } from "../launcher/ports";

const SignalSchema = z.string().regex(/^SIG[A-Z0-9]+$/);
const ChildPidSchema = z.number().int().positive().nullable();

/** Only non-content lifecycle facts may be persisted. */
const LifecycleEventSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("child_started"), childPid: ChildPidSchema }),
  z.strictObject({ kind: z.literal("departure"), reason: z.enum(["quota", "model"]) }),
  z.strictObject({ kind: z.literal("child_signal"), childPid: ChildPidSchema, signal: SignalSchema }),
  z.strictObject({ kind: z.literal("child_exited"), childPid: ChildPidSchema, status: z.number().int().nullable(), signal: SignalSchema.nullable(), spawnFailed: z.boolean() }),
  z.strictObject({ kind: z.literal("compaction"), phase: z.enum(["live", "after_move"]), outcome: z.enum(["compacted", "unchanged", "failed", "interrupted", "not_attempted"]) }),
]);
export type LifecycleEvent = z.infer<typeof LifecycleEventSchema>;

/** Creates a private, per-supervisor log containing only validated lifecycle metadata. */
export function createLifecycleRecorder(params: {
  readonly fs: Pick<FarmFs, "mkdirPrivate" | "appendFilePrivate">;
  readonly logsDir: string;
  readonly fileId: string;
  readonly sessionId: string;
  readonly supervisorPid: number;
  readonly supervisorVersion: string;
  readonly entrypointSha256AtStart: string | null;
  readonly now: () => number;
  readonly log: LogPort;
}): (event: LifecycleEvent) => void {
  const directory = path.join(params.logsDir, "supervisor");
  const file = path.join(directory, `${params.fileId}.jsonl`);
  let warned = false;
  return (event) => {
    try {
      const safeEvent = LifecycleEventSchema.parse(event);
      params.fs.mkdirPrivate(directory);
      params.fs.appendFilePrivate(file, `${JSON.stringify({ schemaVersion: 1, at: new Date(params.now()).toISOString(), sessionId: params.sessionId, supervisorPid: params.supervisorPid, supervisorVersion: params.supervisorVersion, entrypointSha256AtStart: params.entrypointSha256AtStart, ...safeEvent })}\n`);
    } catch {
      if (!warned) {
        warned = true;
        params.log.warn("agent-shim: could not record supervisor lifecycle diagnostics");
      }
    }
  };
}
