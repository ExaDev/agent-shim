import { describe, expect, it } from "vitest";

import { visibleLength } from "./ansi";
import { drawInline, layoutBarGrid, measureGrid, renderGrid, type BarCell } from "./barGrid";

const SEPARATOR = " | ";
const BASE_BAR_CELLS = 10;
const ROOMY = 96;
const TIGHT = 40;
/** Wide enough for the context bar and two windows to share one row. */
const ONE_ROW = 200;
const NARROWER_THAN_ANY_BAR = 10;
/** Wide enough for one bar to a row with every label padded to the context row's, too narrow for two bars on a row. */
const PADDED_COLUMN_FITS = 50;
/** The context row, then five windows two to a row. */
const ROOMY_ROWS = 4;
const WINDOWS_ON_THE_ONE_ROW = 2;
const WINDOWS_ON_THE_THREE_ROWS = 3;
const CONTEXT_PREFIX = "Ctx 96k/1M ";
const CONTEXT_SUFFIX = " 10% (Cache: 0%)";
/** The width of one bar to a row with the context row's label, bar and figures: its prefix, a bar and its two brackets, and its suffix, the widest. */
const ONE_BAR_TO_A_ROW_FITS = CONTEXT_PREFIX.length + BASE_BAR_CELLS + 2 + CONTEXT_SUFFIX.length;
const WINDOW_SUFFIX = " 33.6% (6d 18h)";
const SHORT_FILL_FRACTION = 0.5;
/** A label far wider than the line leaves room for beside a bar. */
const LONG_LABEL_COLUMNS = 40;

function cell(prefix: string, suffix: string): BarCell {
  return { prefix, suffix, draw: (cells) => `[${"#".repeat(Math.round(cells * SHORT_FILL_FRACTION))}${".".repeat(cells - Math.round(cells * SHORT_FILL_FRACTION))}]` };
}

function windowCell(label: string): BarCell {
  return cell(`${label} `, WINDOW_SUFFIX);
}

const CONTEXT = [cell(CONTEXT_PREFIX, CONTEXT_SUFFIX)];
const WINDOWS = ["Gem 5h", "Gem Wk", "3P 5h", "3P Wk", "Argon Wk"].map(windowCell);

/** Where each of the character's occurrences falls in the line. */
function columnsOf(line: string, character: string): number[] {
  const found: number[] = [];
  for (let index = line.indexOf(character); index !== -1; index = line.indexOf(character, index + 1)) {
    found.push(index);
  }
  return found;
}

describe("layoutBarGrid", () => {
  it("starts every row's first bar in one column and ends every row's last bar in one column, whatever the labels and figures", () => {
    const rows = layoutBarGrid([[CONTEXT, WINDOWS]], ROOMY, SEPARATOR, BASE_BAR_CELLS);
    expect(rows).toHaveLength(ROOMY_ROWS);
    const starts = rows.map((row) => columnsOf(row, "[")[0]);
    const ends = rows.map((row) => columnsOf(row, "]").at(-1));
    expect(new Set(starts).size).toBe(1);
    expect(new Set(ends).size).toBe(1);
  });

  it("puts the bars of a middle column in the same columns on every row that has one", () => {
    const rows = layoutBarGrid([[CONTEXT, WINDOWS]], ROOMY, SEPARATOR, BASE_BAR_CELLS);
    const pairs = rows.filter((row) => columnsOf(row, "[").length === 2);
    expect(pairs).toHaveLength(2);
    expect(columnsOf(pairs[0] ?? "", "[")).toEqual(columnsOf(pairs[1] ?? "", "["));
    expect(columnsOf(pairs[0] ?? "", "]")).toEqual(columnsOf(pairs[1] ?? "", "]"));
  });

  it("lets a row's last bar run on across the columns the row leaves empty", () => {
    const rows = layoutBarGrid([[CONTEXT, WINDOWS]], ROOMY, SEPARATOR, BASE_BAR_CELLS);
    const contextRow = rows[0] ?? "";
    const pairRow = rows[1] ?? "";
    expect(columnsOf(contextRow, "]")[0]).toBe(columnsOf(pairRow, "]")[1]);
    expect(columnsOf(contextRow, "[")[0]).toBe(columnsOf(pairRow, "[")[0]);
  });

  it("fills the line to its width and shares the spare cells between the columns, never more than one cell apart", () => {
    const rows = layoutBarGrid([[CONTEXT, WINDOWS]], ROOMY, SEPARATOR, BASE_BAR_CELLS);
    const pairRow = rows[1] ?? "";
    expect(rows[0]?.length).toBe(ROOMY);
    const [firstOpen, secondOpen] = columnsOf(pairRow, "[");
    const [firstClose, secondClose] = columnsOf(pairRow, "]");
    expect(Math.abs((firstClose ?? 0) - (firstOpen ?? 0) - ((secondClose ?? 0) - (secondOpen ?? 0)))).toBeLessThanOrEqual(1);
  });

  it("draws everything on one row when it fits", () => {
    const rows = layoutBarGrid([[CONTEXT, WINDOWS.slice(0, WINDOWS_ON_THE_ONE_ROW)]], ONE_ROW, SEPARATOR, BASE_BAR_CELLS);
    expect(rows).toHaveLength(1);
    expect(columnsOf(rows[0] ?? "", "[")).toHaveLength(CONTEXT.length + WINDOWS_ON_THE_ONE_ROW);
  });

  it("packs a group into as many columns as leave every row within the width", () => {
    const rows = layoutBarGrid([[CONTEXT, WINDOWS]], ROOMY, SEPARATOR, BASE_BAR_CELLS);
    for (const row of rows) {
      expect(row.length).toBeLessThanOrEqual(ROOMY);
    }
    expect(Math.max(...rows.map((row) => columnsOf(row, "[").length))).toBe(2);
  });

  it("aligns each group within itself when padding every group to match would not fit, so a narrow line is not widened by another group's labels", () => {
    const rows = layoutBarGrid([[CONTEXT, WINDOWS]], TIGHT, SEPARATOR, BASE_BAR_CELLS);
    const windowRows = rows.slice(1);
    expect(windowRows).toHaveLength(WINDOWS.length);
    for (const row of windowRows) {
      expect(row.length).toBeLessThanOrEqual(TIGHT);
    }
    expect(new Set(windowRows.map((row) => columnsOf(row, "[")[0])).size).toBe(1);
    expect(columnsOf(windowRows[0] ?? "", "[")[0]).toBe("Argon Wk ".length);
  });

  it("keeps the groups of one unit to their own alignment rather than padding them to each other's labels in a single column", () => {
    const rows = layoutBarGrid([[CONTEXT, WINDOWS.slice(0, WINDOWS_ON_THE_ONE_ROW)]], PADDED_COLUMN_FITS, SEPARATOR, BASE_BAR_CELLS);
    expect(rows).toHaveLength(1 + WINDOWS_ON_THE_ONE_ROW);
    expect(columnsOf(rows[1] ?? "", "[")[0]).toBe("Gem Wk ".length);
  });

  it("pads the labels of units of their own to each other's in a single column when that fits", () => {
    const rows = layoutBarGrid([[CONTEXT], [WINDOWS.slice(0, 1)]], PADDED_COLUMN_FITS, SEPARATOR, BASE_BAR_CELLS);
    expect(rows).toHaveLength(2);
    expect(columnsOf(rows[1] ?? "", "[")[0]).toBe(CONTEXT_PREFIX.length);
  });

  it("pads units of their own to one column when one bar to a row fits and two do not, and aligns each group within itself once it does not", () => {
    // The context bar, three quota windows and a lone bar, each a unit of its own: the widest label and figures are the context bar's, so one bar to a row needs exactly the context row's width.
    const units = [[CONTEXT], [WINDOWS.slice(0, WINDOWS_ON_THE_THREE_ROWS)], [[cell("RAM ", " 50%")]]];
    const padded = layoutBarGrid(units, ONE_BAR_TO_A_ROW_FITS, SEPARATOR, BASE_BAR_CELLS);
    expect(padded).toHaveLength(1 + WINDOWS_ON_THE_THREE_ROWS + 1);
    expect(new Set(padded.map((row) => columnsOf(row, "[")[0]))).toEqual(new Set([CONTEXT_PREFIX.length]));
    const apart = layoutBarGrid(units, ONE_BAR_TO_A_ROW_FITS - 1, SEPARATOR, BASE_BAR_CELLS);
    expect(columnsOf(apart[0] ?? "", "[")[0]).toBe(CONTEXT_PREFIX.length);
    expect(columnsOf(apart[1] ?? "", "[")[0]).toBe("Gem Wk ".length);
    expect(columnsOf(apart.at(-1) ?? "", "[")[0]).toBe("RAM ".length);
  });

  it("draws a bar whole, one to a row, when even that is wider than the line", () => {
    const rows = layoutBarGrid([[CONTEXT]], NARROWER_THAN_ANY_BAR, SEPARATOR, BASE_BAR_CELLS);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain(`[${"#".repeat(BASE_BAR_CELLS * SHORT_FILL_FRACTION)}${".".repeat(BASE_BAR_CELLS * SHORT_FILL_FRACTION)}]`);
  });

  it("aligns each row within itself once one bar to a row does not fit with the labels padded to match, so a long label widens only its own row", () => {
    const short = windowCell("5h");
    const long = windowCell("L".repeat(LONG_LABEL_COLUMNS));
    const shortRowWidth = "5h ".length + BASE_BAR_CELLS + 2 + WINDOW_SUFFIX.length;
    const width = shortRowWidth + LONG_LABEL_COLUMNS / 2;
    expect(measureGrid([[short], [long]], SEPARATOR.length, BASE_BAR_CELLS).baseWidth).toBeGreaterThan(width);
    const rows = layoutBarGrid([[[short, long]]], width, SEPARATOR, BASE_BAR_CELLS);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.startsWith("5h [")).toBe(true);
    expect(rows[0]?.length).toBeLessThanOrEqual(width);
  });

  it("leaves no trailing space after a row's last figures", () => {
    const rows = layoutBarGrid([[CONTEXT, WINDOWS]], ROOMY, SEPARATOR, BASE_BAR_CELLS);
    for (const row of rows) {
      expect(row).toBe(row.trimEnd());
    }
  });

  it("draws nothing for no bars", () => {
    expect(layoutBarGrid([], ROOMY, SEPARATOR, BASE_BAR_CELLS)).toEqual([]);
    expect(layoutBarGrid([[[], []]], ROOMY, SEPARATOR, BASE_BAR_CELLS)).toEqual([]);
  });

  it("keeps units on rows of their own while aligning their bars to one grid", () => {
    const rows = layoutBarGrid([[CONTEXT], [WINDOWS.slice(0, WINDOWS_ON_THE_ONE_ROW)]], ONE_ROW, SEPARATOR, BASE_BAR_CELLS);
    expect(rows).toHaveLength(2);
    expect(columnsOf(rows[0] ?? "", "[")).toHaveLength(CONTEXT.length);
    expect(columnsOf(rows[1] ?? "", "[")).toHaveLength(WINDOWS_ON_THE_ONE_ROW);
    expect(columnsOf(rows[0] ?? "", "[")[0]).toBe(columnsOf(rows[1] ?? "", "[")[0]);
    expect((rows[0] ?? "").length).toBeLessThanOrEqual(ONE_ROW);
  });

  it("shares a row only between the groups of one unit", () => {
    const merged = layoutBarGrid([[CONTEXT, WINDOWS.slice(0, WINDOWS_ON_THE_ONE_ROW)]], ONE_ROW, SEPARATOR, BASE_BAR_CELLS);
    const apart = layoutBarGrid([[CONTEXT], [WINDOWS.slice(0, WINDOWS_ON_THE_ONE_ROW)]], ONE_ROW, SEPARATOR, BASE_BAR_CELLS);
    expect(merged).toHaveLength(1);
    expect(apart).toHaveLength(2);
  });

  it("draws a bar at its base size on one line with the text around it", () => {
    expect(drawInline([cell("A ", " 1%"), cell("B ", " 2%")], SEPARATOR, BASE_BAR_CELLS)).toBe(`A [${"#".repeat(BASE_BAR_CELLS / 2)}${".".repeat(BASE_BAR_CELLS / 2)}] 1% | B [${"#".repeat(BASE_BAR_CELLS / 2)}${".".repeat(BASE_BAR_CELLS / 2)}] 2%`);
  });
});

/** `items` in runs of at most `size`. */
function chunksOf<T>(items: readonly T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));
}

/**
 * The layout of groups that share one unit, written out apart from the unit-based code: the whole unit on one row, else every group chunked to the most bars to a row that fits, from the largest group down to two, else each group aligned within itself, a lone group drawn a bar to a row with the labels padded to match when that fits and each row aligned within itself when it does not. Kept as the reference the unit-based layout must agree with for a single unit.
 */
function layoutOfOneUnit(groups: readonly (readonly BarCell[])[], maxWidth: number, separator: string, baseBarCells: number): string[] {
  const nonEmpty = groups.filter((group) => group.length > 0);
  if (nonEmpty.length === 0) {
    return [];
  }
  const separatorLength = visibleLength(separator);
  const widest = Math.max(...nonEmpty.map((group) => group.length));
  const layoutFor = (perRow: number): ReturnType<typeof measureGrid> => measureGrid(nonEmpty.flatMap((group) => chunksOf(group, perRow)), separatorLength, baseBarCells);
  const candidates = [measureGrid([nonEmpty.flat()], separatorLength, baseBarCells)];
  for (let perRow = widest; perRow > 1; perRow -= 1) {
    candidates.push(layoutFor(perRow));
  }
  const fitting = candidates.find((grid) => grid.baseWidth <= maxWidth);
  if (fitting !== undefined) {
    return renderGrid(fitting, maxWidth, separator, baseBarCells);
  }
  if (nonEmpty.length > 1) {
    return nonEmpty.flatMap((group) => layoutOfOneUnit([group], maxWidth, separator, baseBarCells));
  }
  const oneToARow = layoutFor(1);
  if (oneToARow.baseWidth <= maxWidth) {
    return renderGrid(oneToARow, maxWidth, separator, baseBarCells);
  }
  return oneToARow.rows.flatMap((row) => renderGrid(measureGrid([row], separatorLength, baseBarCells), maxWidth, separator, baseBarCells));
}

/** The groups of the given sizes, their cells labelled to different lengths so that padding to a shared column shows. */
function groupsOfSizes(sizes: readonly number[]): BarCell[][] {
  let labelLength = 0;
  return sizes.map((size) => Array.from({ length: size }, () => cell(`${"L".repeat((labelLength += 1))} `, " 10%")));
}

describe("layoutBarGrid for a single unit", () => {
  const SMALLEST_WIDTH = 20;
  const WIDEST_WIDTH = 140;
  const MOST_GROUPS = 4;
  const MOST_CELLS = 3;

  /** Every list of 1 to `MOST_GROUPS` group sizes of 1 to `MOST_CELLS` cells. */
  function shapes(length: number): number[][] {
    if (length === 0) {
      return [[]];
    }
    return shapes(length - 1).flatMap((shorter) => Array.from({ length: MOST_CELLS }, (_, size) => [...shorter, size + 1]));
  }
  const allShapes = Array.from({ length: MOST_GROUPS }, (_, index) => shapes(index + 1)).flat();

  it("draws groups of one bar each, each aligned within itself, when padding them to one column does not fit on a line together", () => {
    const groups = groupsOfSizes([1, 1, 1]);
    const rows = layoutBarGrid([groups], SMALLEST_WIDTH, SEPARATOR, BASE_BAR_CELLS);
    expect(rows).toEqual(layoutOfOneUnit(groups, SMALLEST_WIDTH, SEPARATOR, BASE_BAR_CELLS));
    expect(new Set(rows.map((row) => columnsOf(row, "[")[0])).size).toBe(rows.length);
  });

  it("agrees with the one-unit reference layout for every shape and width, so a unit of groups keeps its alignment", () => {
    for (const sizes of allShapes) {
      const groups = groupsOfSizes(sizes);
      for (let width = SMALLEST_WIDTH; width <= WIDEST_WIDTH; width += 1) {
        expect(layoutBarGrid([groups], width, SEPARATOR, BASE_BAR_CELLS), `${sizes.join(",")} at ${String(width)}`).toEqual(layoutOfOneUnit(groups, width, SEPARATOR, BASE_BAR_CELLS));
      }
    }
  });
});
