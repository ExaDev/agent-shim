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
interface Grid {
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

function measureGrid(rows: readonly (readonly BarCell[])[], separatorLength: number, baseBarCells: number): Grid {
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

function renderGrid(grid: Grid, maxWidth: number, separator: string, baseBarCells: number): string[] {
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
 * Lays bars out in rows that share their columns. Each unit is a set of groups that may share a row; the units are drawn one after another, a group of a unit that does not fit beside the others starting a fresh row, and a unit's bars are packed as many to a row as fit.
 *
 * Every row is aligned to one grid, across units too: the bars of a column start at the same position and end at the same position, because each label is padded to the column's widest label and each bar draws the same number of cells; a row's last bar runs on across the columns the row does not use, so its end lines up with the last column's. The spare width left after the bars' base size is shared among the columns. Bars at their base size on a line too narrow for even one (a label wider than the line) are drawn whole rather than cut.
 *
 * The layout is the widest one that fits: each unit on one row when it fits, else the most bars to a row that still leaves every row within `maxWidth`, down to one. When not even that fits, the groups stop sharing columns and each is aligned within itself.
 */
export function layoutBarGrid(units: readonly BarUnit[], maxWidth: number, separator: string, baseBarCells: number): string[] {
  const nonEmpty = units.map((unit) => unit.filter((group) => group.length > 0)).filter((unit) => unit.length > 0);
  if (nonEmpty.length === 0) {
    return [];
  }
  const separatorLength = visibleLength(separator);
  const widest = Math.max(...nonEmpty.map((unit) => unit.flat().length));
  const layoutFor = (perRow: number): Grid =>
    measureGrid(
      nonEmpty.flatMap((unit) => (unit.flat().length <= perRow ? [unit.flat()] : unit.flatMap((group) => chunk(group, perRow)))),
      separatorLength,
      baseBarCells,
    );
  for (let perRow = widest; perRow >= 1; perRow -= 1) {
    const grid = layoutFor(perRow);
    if (grid.baseWidth <= maxWidth) {
      return renderGrid(grid, maxWidth, separator, baseBarCells);
    }
  }
  // One bar to a row is too wide once every group's labels and figures are padded to match, so each group keeps to its own alignment; a lone group that still does not fit is drawn whole, one bar to a row.
  const groups = nonEmpty.flat();
  if (groups.length > 1) {
    return groups.flatMap((group) => layoutBarGrid([[group]], maxWidth, separator, baseBarCells));
  }
  return renderGrid(layoutFor(1), maxWidth, separator, baseBarCells);
}
