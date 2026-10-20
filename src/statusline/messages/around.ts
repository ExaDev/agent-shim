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

/** The messages whose words are painted around a value that keeps its own colour. */
export const AROUND_VALUE_IDS = ["sessionTime.started", "sessionTime.lastReply", "addedDirs.label", "skills.label", "mcp.label"] as const;

export type AroundValueId = (typeof AROUND_VALUE_IDS)[number];

/** How a message that has a value in it is written: the placeholders it holds (one for the value, which is `mark` here, and a second for the count when it names one), so what is counted is stated once, with the message that has it. */
interface AroundMessage {
  readonly counted: boolean;
  readonly write: (t: Translate, mark: string, count: number | string) => string;
}

const AROUND_MESSAGES: Readonly<Record<AroundValueId, AroundMessage>> = {
  "sessionTime.started": { counted: false, write: (t, mark) => t("sessionTime.started", { time: mark }) },
  "sessionTime.lastReply": { counted: false, write: (t, mark) => t("sessionTime.lastReply", { ago: mark }) },
  "addedDirs.label": { counted: false, write: (t, mark) => t("addedDirs.label", { dirs: mark }) },
  "skills.label": { counted: true, write: (t, mark, count) => t("skills.label", { count, names: mark }) },
  "mcp.label": { counted: true, write: (t, mark, count) => t("mcp.label", { count, names: mark }) },
};

/** Whether the message `id` names a count, which its caller then supplies. */
export function namesCount(id: AroundValueId): boolean {
  return AROUND_MESSAGES[id].counted;
}

/** The message `id` with `value` where its value goes and its words painted by `paint`; a message that names a count takes it as `count`, which is a defect in the caller when it is missing. */
export function writeAround(t: Translate, id: AroundValueId, value: string, paint: (text: string) => string, count?: number | string): string {
  const message = AROUND_MESSAGES[id];
  if (message.counted && count === undefined) {
    throw new TypeError(`message "${id}" names a count, and none was given`);
  }
  return aroundValue(message.write(t, VALUE_MARK, count ?? ""), value, paint);
}
