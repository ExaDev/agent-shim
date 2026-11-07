/**
 * A session's `/goal` as its transcript records it, read with no effect on the session: Claude Code keeps no goal state anywhere a process outside it can ask, so the transcript is the one source a reader has.
 *
 * Every goal change is a `goal_status` attachment row (`{"type":"attachment","attachment":{"type":"goal_status",...}}`), as the 2.1.319 CLI writes them and as its own resume restores a goal from them: setting a goal writes `{ met: false, sentinel: true, condition }`; clearing it writes `{ met: true, sentinel: true, condition }`; each evaluation the goal check makes and finds not yet met writes `{ met: false, condition, reason }`; a met goal writes `met: true` and a failed one `failed: true`, both ending it. The rows are read in order, so the last change wins.
 */

/** One goal as the transcript records it: the condition, how many turns the goal check has evaluated it on, and the check's last stated reason when it has given one. */
export interface TranscriptGoal {
  readonly condition: string;
  readonly iterations: number;
  readonly lastCheck?: string;
}

/** The guard every row narrowing goes through, per the codebase's `unknown` discipline. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The `goal_status` attachment one transcript line carries, or undefined for any other line (including one that is not JSON, such as a line still being written). */
function goalStatusOf(line: string): Record<string, unknown> | undefined {
  if (!line.includes("goal_status")) {
    return undefined;
  }
  let row: unknown;
  try {
    row = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(row) || row.type !== "attachment" || !isRecord(row.attachment) || row.attachment.type !== "goal_status" || typeof row.attachment.condition !== "string") {
    return undefined;
  }
  return row.attachment;
}

/** The goal after one transcript line, given the goal before it: the change a `goal_status` row makes, or the same goal for any other line. */
export function goalAfterLine(goal: TranscriptGoal | null, line: string): TranscriptGoal | null {
  const status = goalStatusOf(line);
  if (status === undefined || typeof status.condition !== "string") {
    return goal;
  }
  if (status.sentinel === true) {
    return status.met === true ? null : { condition: status.condition, iterations: 0 };
  }
  if (status.met === true || status.failed === true) {
    return null;
  }
  if (goal !== null && goal.condition === status.condition) {
    return { condition: goal.condition, iterations: goal.iterations + 1, ...(typeof status.reason === "string" ? { lastCheck: status.reason } : {}) };
  }
  return goal;
}

/** The goal active at the end of a transcript's text, or null when none is. */
export function activeGoalOfTranscript(text: string): TranscriptGoal | null {
  return text.split("\n").reduce<TranscriptGoal | null>(goalAfterLine, null);
}
