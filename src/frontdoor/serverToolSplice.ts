import { arrayElements, type Member } from "./topLevelMembers";
import { skipWhitespace } from "./topLevelModel";

/**
 * Removal of tools from a Messages request body as text edits, never a re-serialisation: every byte an edit does not remove or replace is the request's own (a number past 2^53, `1.0`, `1e400`, an escape, the spacing). The text is the body's bytes viewed one character each (`latin1`), the view the offsets of the one structural walk (`walkTopLevelMembers`) are in.
 */

/** A span `[start, end)` of the body, in bytes, and the bytes that take its place: none, for a removal. The offsets are those of the one structural walk, which are byte offsets because it looks only at ASCII structure. */
export interface TextEdit {
  readonly start: number;
  readonly end: number;
  readonly replacement?: Buffer;
}

/** What removing a body's server tools needs: nothing, a refusal, or the edits and the labels of the tools they remove. */
export type ToolRemoval =
  | { readonly kind: "unchanged" }
  | { readonly kind: "ambiguous"; readonly key: string }
  | { readonly kind: "planned"; readonly edits: readonly TextEdit[]; readonly dropped: readonly string[] };

/** The tool a parsed element is, as the record of a removal names it: its name, else its type, else "unnamed". */
function labelOf(tool: unknown): string {
  if (typeof tool === "object" && tool !== null) {
    if ("name" in tool && typeof tool.name === "string") {
      return tool.name;
    }
    if ("type" in tool && typeof tool.type === "string") {
      return tool.type;
    }
  }
  return "unnamed";
}

/** Whether a parsed tool carries no `input_schema`: a tool given by `type` alone (web search, the Anthropic-defined client tools), where a tool of the client's own always carries its schema. */
function isServerTool(tool: unknown): boolean {
  return typeof tool === "object" && tool !== null && !Array.isArray(tool) && !("input_schema" in tool);
}

/** The JSON a span of the byte view holds, parsed as the UTF-8 text it is. */
function parsedSpan(text: string, start: number, end: number): unknown {
  return JSON.parse(Buffer.from(text.slice(start, end), "latin1").toString("utf8"));
}

/**
 * Whether a parsed `tool_choice` names a tool at one of the removed positions: by the index of the tool it names among the request's own tools, the identity the removal itself used, so a kept tool sharing a removed tool's name keeps its `tool_choice`. `labels` is each tool's label in order and `removed` the positions being removed. One pass over the labels, one set lookup for each tool that carries the name, so the work grows with the number of tools and no faster.
 */
export function choiceNamesRemovedTool(choice: unknown, labels: readonly string[], removed: ReadonlySet<number>): boolean {
  if (typeof choice !== "object" || choice === null || !("name" in choice) || typeof choice.name !== "string") {
    return false;
  }
  const named = choice.name;
  let carrying = 0;
  let carryingRemoved = 0;
  labels.forEach((label, index) => {
    if (label === named) {
      carrying += 1;
      if (removed.has(index)) {
        carryingRemoved += 1;
      }
    }
  });
  return carrying > 0 && carrying === carryingRemoved;
}

/**
 * The edits that remove the tools with no `input_schema` from the body whose top-level members are `members`: each such tool's own span, and the `tool_choice` member when no tool is left (it would name no tool) or when it names a removed tool and no kept one, and the `tools` member itself when none is left. A body with none to remove and one whose `tools` is no array is `unchanged`; one that names `tools` or `tool_choice` twice is `ambiguous`, since which field a server reads differs between parsers.
 */
export function planningToolRemoval(text: string, members: readonly Member[]): ToolRemoval {
  for (const key of ["tools", "tool_choice"]) {
    if (members.filter((member) => member.key === key).length > 1) {
      return { kind: "ambiguous", key };
    }
  }
  const tools = members.find((member) => member.key === "tools");
  if (tools === undefined || text[tools.valueStart] !== "[") {
    return { kind: "unchanged" };
  }
  const elements = arrayElements(text, tools.valueStart, tools.valueEnd);
  if (elements === undefined) {
    // The strict walk accepted the body, and `arrayElements` accepts every array the walk does, so a `tools` value that starts with `[` always has elements.
    throw new Error("the strict walk accepted a tools array whose elements cannot be read");
  }
  // The walk accepts only what `JSON.parse` accepts, so a span it names always parses.
  const parsed = elements.map(([start, end]) => parsedSpan(text, start, end));
  const removedAt = parsed.flatMap((tool, index) => (isServerTool(tool) ? [index] : []));
  if (removedAt.length === 0) {
    return { kind: "unchanged" };
  }
  const labels = parsed.map(labelOf);
  const removed = new Set(removedAt);
  const dropped = labels.filter((_label, index) => removed.has(index));
  const allGone = removedAt.length === parsed.length;
  const choice = members.find((member) => member.key === "tool_choice");
  const choiceGoes = choice !== undefined && (allGone || choiceNamesRemovedTool(parsedSpan(text, choice.valueStart, choice.valueEnd), labels, removed));
  const spans: (readonly [number, number])[] = [];
  const memberSpans = members.map((member) => [member.keyStart, member.valueEnd] as const);
  const removedMembers = new Set<number>();
  if (choice !== undefined && choiceGoes) {
    removedMembers.add(members.indexOf(choice));
  }
  if (allGone) {
    removedMembers.add(members.indexOf(tools));
  } else {
    spans.push(...removalSpans(text, elements, removed));
  }
  spans.push(...removalSpans(text, memberSpans, removedMembers));
  return { kind: "planned", edits: spans.map(([start, end]) => ({ start, end })), dropped };
}

/**
 * The spans to delete from a comma-separated list so the items at the `removed` positions disappear and every other byte stays, as the items' own spans in order. A run of removed items with a kept item after it goes from its first item's start to that kept item's start (the items, their commas and the whitespace after them); a run that ends the list goes from the comma after the last kept item to its own end; a list with nothing kept goes whole.
 */
function removalSpans(text: string, items: readonly (readonly [number, number])[], removed: ReadonlySet<number>): readonly (readonly [number, number])[] {
  const spans: (readonly [number, number])[] = [];
  let at = 0;
  while (at < items.length) {
    if (!removed.has(at)) {
      at += 1;
      continue;
    }
    let last = at;
    while (last + 1 < items.length && removed.has(last + 1)) {
      last += 1;
    }
    const first = items[at];
    const final = items[last];
    const next = items[last + 1];
    const before = items[at - 1];
    if (first !== undefined && final !== undefined) {
      if (next !== undefined) {
        spans.push([first[0], next[0]]);
      } else if (before !== undefined) {
        spans.push([skipWhitespace(text, before[1]), final[1]]);
      } else {
        spans.push([first[0], final[1]]);
      }
    }
    at = last + 1;
  }
  return spans;
}

/** `body` with every edit applied, as the slices of it and the replacements in order (views of `body`, never copies of it): joined, they are the edited body, and streamed as they are they cost no copy of it. The edits are disjoint and in any order. */
export function editedSegments(body: Buffer, edits: readonly TextEdit[]): readonly Buffer[] {
  const ordered = [...edits].sort((a, b) => a.start - b.start);
  const parts: Buffer[] = [];
  let at = 0;
  for (const edit of ordered) {
    if (edit.start < at) {
      throw new RangeError("two edits of one body overlap");
    }
    parts.push(body.subarray(at, edit.start));
    if (edit.replacement !== undefined) {
      parts.push(edit.replacement);
    }
    at = edit.end;
  }
  parts.push(body.subarray(at));
  return parts;
}

/** `body` with every edit applied, joined into one buffer: the one copy a caller that needs the bytes together makes. */
export function applyingEdits(body: Buffer, edits: readonly TextEdit[]): Buffer {
  return Buffer.concat(editedSegments(body, edits));
}
