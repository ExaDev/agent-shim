import { visibleLength } from "./ansi";

/** The brackets a drawn bar wraps its cells in. */
const BRACKET_COLUMNS = 2;

/** One bar with the text around it: a label before it and the figures after it. */
export interface BarCell {
  readonly prefix: string;
  readonly suffix: string;
  /** Draws the bar, brackets included, with `cells` fill positions between the brackets. */
  readonly draw: (cells: number) => string;
}

/** The measurements every row of a layout shares, one entry per column. */
export interface Grid {
  readonly rows: readonly (readonly BarCell[])[];
  readonly columns: number;
  /** The widest prefix of any cell that starts in the column. */
  readonly prefixWidths: readonly number[];
  /** The widest suffix of any cell that ends in the column. */
  readonly suffixWidths: readonly number[];
  /** The width of every row with each bar at its base size. */
  readonly baseWidth: number;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size));
  }
  return chunks;
}

/** The column a cell's bar ends in: a row's last cell runs on to the final column, so that every row's last bar ends where every other row's does. */
function lastColumnOf(index: number, rowLength: number, columns: number): number {
  return index === rowLength - 1 ? columns - 1 : index;
}

/** The measurements of `rows` as one grid, for `renderGrid` to draw. */
export function measureGrid(rows: readonly (readonly BarCell[])[], separatorLength: number, baseBarCells: number): Grid {
  const columns = Math.max(...rows.map((row) => row.length));
  const prefixWidths = Array.from({ length: columns }, () => 0);
  const suffixWidths = Array.from({ length: columns }, () => 0);
  for (const row of rows) {
    row.forEach((cell, index) => {
      const last = lastColumnOf(index, row.length, columns);
      prefixWidths[index] = Math.max(prefixWidths[index] ?? 0, visibleLength(cell.prefix));
      suffixWidths[last] = Math.max(suffixWidths[last] ?? 0, visibleLength(cell.suffix));
    });
  }
  const fixed = [...prefixWidths, ...suffixWidths].reduce((total, width) => total + width, 0) + columns * (baseBarCells + BRACKET_COLUMNS);
  return { rows, columns, prefixWidths, suffixWidths, baseWidth: fixed + separatorLength * (columns - 1) };
}

function padTo(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleLength(text)));
}

/** `grid` drawn to `maxWidth`, one string a row. */
export function renderGrid(grid: Grid, maxWidth: number, separator: string, baseBarCells: number): string[] {
  const separatorLength = visibleLength(separator);
  const spare = Math.max(0, maxWidth - grid.baseWidth);
  const barCells = Array.from({ length: grid.columns }, (_, column) => baseBarCells + Math.floor(spare / grid.columns) + (column < spare % grid.columns ? 1 : 0));
  const blockWidths = barCells.map((cells) => cells + BRACKET_COLUMNS);
  return grid.rows.map((row) =>
    row
      .map((cell, index) => {
        const last = lastColumnOf(index, row.length, grid.columns);
        // A bar that runs on past its own column takes the space of every column it covers, up to where the final column's figures begin.
        let blockWidth = blockWidths[index] ?? 0;
        for (let column = index + 1; column <= last; column += 1) {
          blockWidth += separatorLength + (grid.suffixWidths[column - 1] ?? 0) + (grid.prefixWidths[column] ?? 0) + (blockWidths[column] ?? 0);
        }
        const prefix = padTo(cell.prefix, grid.prefixWidths[index] ?? 0);
        const bar = cell.draw(blockWidth - BRACKET_COLUMNS);
        // A row's final cell carries no padding after its figures, since nothing follows to keep in line.
        const suffix = index === row.length - 1 ? cell.suffix : padTo(cell.suffix, grid.suffixWidths[last] ?? 0);
        return `${prefix}${bar}${suffix}`;
      })
      .join(separator),
  );
}

/** A run of related bars (the context window's, or the quota windows') that starts a fresh row. */
export type BarGroup = readonly BarCell[];

/** Groups that may share a row, as the rows merged into one line are: they are drawn on one row when that fits, and on rows of their own when it does not. */
export type BarUnit = readonly BarGroup[];

/** A bar drawn at its base size on one line with the text around it, with `separator` between a group's bars, for a row that is joined to others on a single line. */
export function drawInline(group: BarGroup, separator: string, baseBarCells: number): string {
  return group.map((cell) => `${cell.prefix}${cell.draw(baseBarCells)}${cell.suffix}`).join(separator);
}

/**
 * Lays bars out in rows, sharing columns between rows as far as the layouts below allow. Each unit is a set of groups that may share a row, and the units are drawn one after another.
 *
 * Every row of a shared grid is aligned to it, across units too: the bars of a column start at the same position and end at the same position, because each label is padded to the column's widest label and each bar draws the same number of cells; a row's last bar runs on across the columns the row does not use, so its end lines up with the last column's. The spare width left after the bars' base size is shared among the columns. Bars at their base size on a line too narrow for even one (a label wider than the line) are drawn whole rather than cut.
 *
 * The layout is the first of these that fits `maxWidth`: every unit on a row of its own in one shared grid; every group chunked into rows of at most the same number of bars, the most that fit, down to one bar to a row for several units (which are meant to line up) and to two for a single unit (whose groups are not padded to match one another a bar to a row); each group laid out on its own as the only group of a unit, whether it came from one unit or several. A group laid out on its own is tried the same way: its bars the most to a row that fits, down to two, else one to a row with its labels and figures padded to match when that fits, else one to a row with each row aligned within itself, where a row that fits the line has its bar widened to take the line's spare width.
 */
export function layoutBarGrid(units: readonly BarUnit[], maxWidth: number, separator: string, baseBarCells: number): string[] {
  const nonEmpty = units.map((unit) => unit.filter((group) => group.length > 0)).filter((unit) => unit.length > 0);
  if (nonEmpty.length === 0) {
    return [];
  }
  const separatorLength = visibleLength(separator);
  const groups = nonEmpty.flat();
  // Each unit on a single row, then every group chunked to `perRow` bars, a group of a unit never sharing a row with another.
  const candidates: Grid[] = [measureGrid(nonEmpty.map((unit) => unit.flat()), separatorLength, baseBarCells)];
  const chunked = (perRow: number): Grid => measureGrid(groups.flatMap((group) => chunk(group, perRow)), separatorLength, baseBarCells);
  // One bar to a row pads every group's labels and figures to match, which a single unit's groups do not accept (they keep to their own alignment instead); units of their own are meant to line up, so they may.
  const fewest = nonEmpty.length > 1 ? 1 : 2;
  for (let perRow = Math.max(...groups.map((group) => group.length)); perRow >= fewest; perRow -= 1) {
    candidates.push(chunked(perRow));
  }
  const fitting = candidates.find((grid) => grid.baseWidth <= maxWidth);
  if (fitting !== undefined) {
    return renderGrid(fitting, maxWidth, separator, baseBarCells);
  }
  // None of the shared grids measured above fits, so each group is laid out on its own, as the only group of a unit: with several units that is where their groups stop being padded to one another, and with one unit it is where the groups of that unit stop sharing columns.
  if (groups.length > 1) {
    return groups.flatMap((group) => layoutBarGrid([[group]], maxWidth, separator, baseBarCells));
  }
  // A lone group that has not fitted at two to a row is drawn one bar to a row with its labels and figures padded to match when that fits.
  const oneToARow = chunked(1);
  if (oneToARow.baseWidth <= maxWidth) {
    return renderGrid(oneToARow, maxWidth, separator, baseBarCells);
  }
  // Padding the labels and figures to match would make the rows wider than the line, so each row keeps to its own alignment and a long label widens only its own row.
  return oneToARow.rows.flatMap((row) => renderGrid(measureGrid([row], separatorLength, baseBarCells), maxWidth, separator, baseBarCells));
}
