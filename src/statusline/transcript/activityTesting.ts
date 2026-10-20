import { activityFactsOf, EMPTY_ACTIVITY_STATE, foldActivity, BASH_MAX_TIMEOUT_MS, MAX_STORED_TEXT_CHARS, type ActivityState } from "./activity";
import { parseTranscriptRecord } from "./record";

export const T0 = Date.parse("2026-10-20T09:00:00.000Z");

export const SECOND = 1_000;

const SECONDS_PER_MINUTE = 60;

export const MINUTE = SECONDS_PER_MINUTE * SECOND;

/** Times after T0 that records are stamped, named by their order and not by how long they are. */
export const STEP = { third: 3, fourth: 4, fifth: 5, sixth: 6, ninth: 9 } as const;

export const MANY_TIMES_THE_LIMIT = 10;

export const EXTRA_CALLS = 5;

export const BYTES_PER_KIBIBYTE = 1024;

/** The quotes and comma a string takes in a JSON array. */
export const QUOTES_AND_COMMA_BYTES = 3;

/** The room each list of names of one kind has in the cache file: the budget the production constant states. */
export const NAME_MEMORY_KIBIBYTES = 16;

/** More names of the longest length than the room for names has, even at one byte to the character. */
export const NAMES_THAT_OVERFILL = Math.floor((NAME_MEMORY_KIBIBYTES * BYTES_PER_KIBIBYTE) / MAX_STORED_TEXT_CHARS) + 1;

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export const at = (ms: number): string => new Date(T0 + ms).toISOString();

export const use = (id: string, name: string, input: Record<string, unknown> = {}, ms = 0, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ type: "assistant", timestamp: at(ms), message: { content: [{ type: "tool_use", id, name, input }] }, ...extra });

export const result = (id: string, ms: number, isError = false, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ type: "user", timestamp: at(ms), message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: "done" }] }, ...extra });

export function fold(records: readonly Record<string, unknown>[], from: ActivityState = EMPTY_ACTIVITY_STATE): ActivityState {
  return records.reduce<ActivityState>((state, record) => {
    const parsed = parseTranscriptRecord(JSON.stringify(record));
    return parsed === undefined ? state : foldActivity(state, parsed);
  }, from);
}

export const LIMITS = { bashMs: BASH_MAX_TIMEOUT_MS };

export const factsAt = (records: readonly Record<string, unknown>[], nowMs = T0 + SECOND) => activityFactsOf(fold(records), nowMs, LIMITS);
