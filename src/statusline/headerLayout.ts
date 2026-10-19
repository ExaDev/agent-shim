import type { STATUSLINE_HEADER_SEGMENTS } from "../config/statusline";
import { visibleLength } from "./ansi";

/** A header segment drawn, with the name that says which it is. */
export interface HeaderPart {
  readonly name: (typeof STATUSLINE_HEADER_SEGMENTS)[number];
  readonly text: string;
}

/** The header segments as the units the layout packs: each segment alone, except that under `truncate` a vcs segment drawn straight after the project segment joins it with a space into one unit, the way claude-hud draws `project git:(main)`, so the pair is never split across lines and the client cuts the line off at the terminal's edge. Under `wrap` the two stay separate units. */
export function headerUnits(parts: readonly HeaderPart[], overflow: "truncate" | "wrap"): string[] {
  const units: string[] = [];
  parts.forEach((part, index) => {
    const before = parts[index - 1];
    if (overflow === "truncate" && part.name === "vcs" && before?.name === "project") {
      units[units.length - 1] = `${units.at(-1) ?? ""} ${part.text}`;
    } else {
      units.push(part.text);
    }
  });
  return units;
}

/** Justifies texts across the line's width: the first flush left, the last flush right, and each separator sharing the spare space evenly around its pipe. A line with no spare width, or a single text, joins plainly. */
function justify(texts: readonly string[], maxWidth: number, separator: string): string {
  if (texts.length < 2) {
    return texts.join(separator);
  }
  const separatorLength = visibleLength(separator);
  const total = texts.reduce((sum, text) => sum + visibleLength(text), 0) + separatorLength * (texts.length - 1);
  const spare = maxWidth - total;
  if (spare <= 0) {
    return texts.join(separator);
  }
  const gaps = texts.length - 1;
  const extraPerGap = Math.floor(spare / gaps);
  let remainder = spare % gaps;
  const parts: string[] = [];
  texts.forEach((text, index) => {
    if (index > 0) {
      const extra = extraPerGap + (remainder > 0 ? 1 : 0);
      if (remainder > 0) {
        remainder -= 1;
      }
      const left = Math.floor(extra / 2);
      parts.push(`${" ".repeat(left + 1)}|${" ".repeat(extra - left + 1)}`);
    }
    parts.push(text);
  });
  return parts.join("");
}

/** Packs texts onto as few lines as fit, in order, each line justified across the width: a text joins the current line when it fits beside what is there, and a text already alone on a line that is still too wide renders whole, exactly as the Antigravity statusline's own fallback does. */
export function layoutHeader(texts: readonly string[], maxWidth: number, separator: string): string {
  const separatorLength = visibleLength(separator);
  const lines: string[][] = [];
  let current: string[] = [];
  let currentWidth = 0;
  for (const text of texts) {
    const width = visibleLength(text);
    const added = current.length === 0 ? width : width + separatorLength;
    if (current.length > 0 && currentWidth + added > maxWidth) {
      lines.push(current);
      current = [text];
      currentWidth = width;
    } else {
      current.push(text);
      currentWidth += added;
    }
  }
  if (current.length > 0) {
    lines.push(current);
  }
  return lines.map((line) => justify(line, maxWidth, separator)).join("\n");
}

