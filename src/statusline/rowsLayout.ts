import type { STATUSLINE_ROWS } from "../config/statusline";
import { visibleLength } from "./ansi";
import { drawInline, layoutBarGrid, type BarUnit } from "./barGrid";
import type { RowOutput } from "./elements/context";
import { SEPARATOR } from "./headerLayout";

type RowName = (typeof STATUSLINE_ROWS)[number];

/** A row as it was drawn, with the name that says which it is. */
export interface DrawnRow {
  readonly name: RowName;
  readonly output: RowOutput;
}

/** What rows lay out as: bars, which are aligned to a grid with the bars beside them, or lines of text, which are drawn as they are. */
type Item = { readonly kind: "bars"; readonly unit: BarUnit } | { readonly kind: "lines"; readonly lines: readonly string[] };

/** The settings that decide how rows are laid out: whether neighbouring bar rows share a line, the groups of rows that may share a line, and the rows that start a right-aligned part of one. */
export interface RowsLayoutSettings {
  readonly mergeBars: boolean;
  readonly merge: readonly (readonly RowName[])[];
  readonly rightAlign: readonly RowName[];
  readonly barCells: number;
}

/** An item that draws nothing and ends a run of bars. */
const BREAK: Item = { kind: "lines", lines: [] };

function isEmpty(output: RowOutput): boolean {
  return output.kind === "bars" ? output.cells.length === 0 : output.lines.length === 0;
}

/** A row on one line, or undefined when it needs more: bars at their base size with the separator between them, or a row of text that is a single line. */
function oneLineOf(output: RowOutput, barCells: number): string | undefined {
  if (output.kind === "bars") {
    return drawInline(output.cells, SEPARATOR, barCells);
  }
  return output.lines.length === 1 ? output.lines[0] : undefined;
}

/**
 * Splits rows already known to fit on one line, joined, into a left part and a right part and pads the gap between them with spaces, the right part beginning at the first row named in `rightAlign`. The gap is never narrower than the separator it replaces, because the joined line fits. Undefined when nothing is aligned: no row is named, or the first row is the one named.
 */
function alignRight(lines: readonly { readonly name: RowName; readonly text: string }[], rightAlign: ReadonlySet<RowName>, width: number): string | undefined {
  const split = lines.findIndex(({ name }) => rightAlign.has(name));
  if (split < 1) {
    return undefined;
  }
  const left = lines.slice(0, split).map(({ text }) => text).join(SEPARATOR);
  const right = lines.slice(split).map(({ text }) => text).join(SEPARATOR);
  return `${left}${" ".repeat(width - visibleLength(left) - visibleLength(right))}${right}`;
}

function itemOf(row: DrawnRow): Item {
  return row.output.kind === "bars" ? { kind: "bars", unit: [row.output.cells] } : { kind: "lines", lines: row.output.lines };
}

/** The items a sequence of rows from one merge group lays out as: one item when the rows fit on a single line together, else each row as its own item. */
function mergedItems(rows: readonly DrawnRow[], settings: RowsLayoutSettings, width: number): readonly Item[] {
  const rightAlign = new Set(settings.rightAlign);
  const aligned = rows.some((row, index) => index > 0 && rightAlign.has(row.name));
  if (!aligned && rows.every((row) => row.output.kind === "bars")) {
    // Bars alone share a grid, which fills the line and falls back to rows of their own when the line is too narrow.
    return [{ kind: "bars", unit: rows.flatMap((row) => (row.output.kind === "bars" ? [row.output.cells] : [])) }];
  }
  const lines = rows.map((row) => ({ name: row.name, text: oneLineOf(row.output, settings.barCells) }));
  const texts = lines.flatMap(({ name, text }) => (text === undefined ? [] : [{ name, text }]));
  if (texts.length === rows.length) {
    const joined = texts.map(({ text }) => text).join(SEPARATOR);
    if (visibleLength(joined) <= width) {
      return [{ kind: "lines", lines: [alignRight(texts, rightAlign, width) ?? joined] }];
    }
  }
  return rows.map(itemOf);
}

/** The run key of the bar rows that are in no group while `mergeBars` is set: they share a run with each other, but never with a group's rows. */
const BARS_RUN = -1;

/** Rows that sit next to each other and share a run key. */
interface Run {
  readonly key: number | undefined;
  readonly rows: DrawnRow[];
}

/**
 * The rows cut into runs of rows that sit next to each other and share a run key: the index of their merge group, or the bars run for bar rows outside every group when `mergeBars` is set. Any other row is a run of its own. A run of bar rows with nothing to show among them draws nothing and is left out, so the bars either side of it are as if it were not there.
 */
function runsOf(rows: readonly DrawnRow[], settings: RowsLayoutSettings): DrawnRow[][] {
  const groupOf = new Map(settings.merge.flatMap((group, index) => group.map((name) => [name, index] as const)));
  const keyOf = (row: DrawnRow): number | undefined => groupOf.get(row.name) ?? (settings.mergeBars && row.output.kind === "bars" ? BARS_RUN : undefined);
  const runs: Run[] = [];
  const add = (key: number | undefined, row: DrawnRow): void => {
    const last = runs.at(-1);
    if (last !== undefined && key !== undefined && last.key === key) {
      last.rows.push(row);
    } else {
      runs.push({ key, rows: [row] });
    }
  };
  for (const row of rows) {
    add(keyOf(row), row);
  }
  const silent = (run: Run): boolean => run.rows.every((row) => isEmpty(row.output) && row.output.kind === "bars");
  const kept: Run[] = [];
  for (const run of runs.filter((candidate) => !silent(candidate))) {
    const last = kept.at(-1);
    if (last !== undefined && run.key === BARS_RUN && last.key === BARS_RUN) {
      last.rows.push(...run.rows);
    } else {
      kept.push(run);
    }
  }
  return kept.map((run) => run.rows);
}

/**
 * The lines of the rows below the header. Rows that sit next to each other in the order and belong to one merge group, and bar rows outside every group while `mergeBars` is set, are joined onto a line when they fit together (bars sharing a grid, other rows as one line of text), else each is drawn on its own. Bars of consecutive items keep one grid, so their columns line up whether they share a line or not, and a row of text, even one with nothing to show, ends the run, as does a merge group of which no row has anything to show but one is a row of text.
 */
export function layoutRows(rows: readonly DrawnRow[], settings: RowsLayoutSettings, width: number): string[] {
  const items = runsOf(rows, settings).flatMap((run): readonly Item[] => {
    const present = run.filter((row) => !isEmpty(row.output));
    if (present.length === 0) {
      // Runs of bar rows alone with nothing to show were left out, so what is left is a row of text, or a merge group with one, that has nothing to show. It still ends a run of bars, as any row of text does, so the bars either side of it keep grids of their own.
      return [BREAK];
    }
    return present.length > 1 ? mergedItems(present, settings, width) : present.map(itemOf);
  });
  const lines: string[] = [];
  let units: BarUnit[] = [];
  const flushBars = (): void => {
    lines.push(...layoutBarGrid(units, width, SEPARATOR, settings.barCells));
    units = [];
  };
  for (const item of items) {
    if (item.kind === "bars") {
      units.push(item.unit);
    } else {
      flushBars();
      lines.push(...item.lines);
    }
  }
  flushBars();
  return lines;
}

/** What the rows contribute to the compact layout, in order: each bar at its base size, and each line of text, as units of one line apiece. */
export function compactUnits(rows: readonly DrawnRow[], barCells: number): string[] {
  return rows.flatMap(({ output }) => (output.kind === "bars" ? output.cells.map((cell) => drawInline([cell], SEPARATOR, barCells)) : [...output.lines]));
}
