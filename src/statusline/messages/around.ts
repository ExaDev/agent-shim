import type { Translate } from "./catalogues";

/** Stands in for a value while a message is written, so the words either side of it can be painted and the value left as it is. */
export const VALUE_MARK = String.fromCharCode(1);

/** `text` passed through `paint` without the spaces at either end, which are left unpainted, so that a colour never runs into the space that separates a label from its value; nothing at all is painted when only spaces are left. */
export function paintCore(text: string, paint: (text: string) => string): string {
  const core = text.trim();
  if (core === "") {
    return text;
  }
  const start = text.indexOf(core);
  return `${text.slice(0, start)}${paint(core)}${text.slice(start + core.length)}`;
}

/** `message`, written with `VALUE_MARK` exactly once where the value goes, with `value` in its place and the words before and after it painted (see `paintCore`). A message with the mark absent or repeated is a defect in the catalogue and fails here, loudly, instead of drawing the value twice or not at all. */
export function aroundValue(message: string, value: string, paint: (text: string) => string): string {
  const sides = message.split(VALUE_MARK);
  const [before, after] = sides;
  if (sides.length !== 2 || before === undefined || after === undefined) {
    throw new TypeError(`message "${message}" must hold the value mark exactly once, and holds it ${String(sides.length - 1)} times`);
  }
  return `${paintCore(before, paint)}${value}${paintCore(after, paint)}`;
}

/** The messages whose words are painted around a value that keeps its own colour: each has a placeholder for that value, exactly one in every language, and the ones that name a count (`COUNTED_AROUND_VALUE_IDS`) have a second, for the count. */
export const AROUND_VALUE_IDS = ["sessionTime.started", "sessionTime.lastReply", "addedDirs.label", "skills.label", "mcp.label"] as const;

export type AroundValueId = (typeof AROUND_VALUE_IDS)[number];

/** The messages written around a value that also name a count, which the caller supplies. */
export const COUNTED_AROUND_VALUE_IDS: readonly AroundValueId[] = ["skills.label", "mcp.label"];

/** The count a counted message names; a defect in the caller when it is missing. */
function requiredCount(id: AroundValueId, count: number | string | undefined): number | string {
  if (count === undefined) {
    throw new TypeError(`message "${id}" names a count, and none was given`);
  }
  return count;
}

/** The message `id` written with the mark where its one value goes. */
function marked(t: Translate, id: AroundValueId, count: number | string | undefined): string {
  switch (id) {
    case "sessionTime.started":
      return t(id, { time: VALUE_MARK });
    case "sessionTime.lastReply":
      return t(id, { ago: VALUE_MARK });
    case "addedDirs.label":
      return t(id, { dirs: VALUE_MARK });
    case "skills.label":
    case "mcp.label":
      return t(id, { count: requiredCount(id, count), names: VALUE_MARK });
    default:
      return id satisfies never;
  }
}

/** The message `id` with `value` where its value goes and its words painted by `paint`; a message that names a count takes it as `count`. */
export function writeAround(t: Translate, id: AroundValueId, value: string, paint: (text: string) => string, count?: number | string): string {
  return aroundValue(marked(t, id, count), value, paint);
}
