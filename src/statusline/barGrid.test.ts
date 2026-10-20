import { describe, expect, it } from "vitest";

import { drawInline, layoutBarGrid, type BarCell } from "./barGrid";

const SEPARATOR = " | ";
const BASE_BAR_CELLS = 10;
const ROOMY = 96;
const TIGHT = 40;
/** Wide enough for the context bar and two windows to share one row. */
const ONE_ROW = 200;
const NARROWER_THAN_ANY_BAR = 10;
/** The context row, then five windows two to a row. */
const ROOMY_ROWS = 4;
const WINDOWS_ON_THE_ONE_ROW = 2;
const CONTEXT_PREFIX = "Ctx 96k/1M ";
const CONTEXT_SUFFIX = " 10.0% (Cache: 0%)";
const WINDOW_SUFFIX = " 33.6% (6d 18h)";
const SHORT_FILL_FRACTION = 0.5;

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

  it("draws a bar whole, one to a row, when even that is wider than the line", () => {
    const rows = layoutBarGrid([[CONTEXT]], NARROWER_THAN_ANY_BAR, SEPARATOR, BASE_BAR_CELLS);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain(`[${"#".repeat(BASE_BAR_CELLS * SHORT_FILL_FRACTION)}${".".repeat(BASE_BAR_CELLS * SHORT_FILL_FRACTION)}]`);
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
