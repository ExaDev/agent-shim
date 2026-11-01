import type { StyleText } from "../logStyle";
import type { ReportRow } from "./ports";

/** The line that introduces a launch's report, so a row read from a terminal's history still says where it came from. */
const REPORT_HEADING = "agent-shim";

/** The gap between a row's label column and its value. */
const COLUMN_GAP = "  ";
/** How a notice row's label and value are set apart from the dimmed labels and plain values of the facts around it. */
const NOTICE_FORMATS = ["yellow", "bold"] as const;

/**
 * The lines of a launch's report: a heading, then one row for each fact with its labels in a column, so the eye can run down the labels to the fact it wants. Nothing is returned for a launch with nothing to report. `style` applies the terminal formatting (or none, for plain text): the heading bold, labels, details and notes dimmed, values as they are.
 */
export function renderReport(rows: readonly ReportRow[], style: StyleText): readonly string[] {
  if (rows.length === 0) {
    return [];
  }
  const labelWidth = Math.max(...rows.map((row) => row.label.length));
  const indent = " ".repeat(COLUMN_GAP.length);
  const lines = [style(["bold"], REPORT_HEADING)];
  for (const row of rows) {
    const detail = row.detail === undefined ? "" : ` ${style(["dim"], `(${row.detail})`)}`;
    const label = row.label.padEnd(labelWidth);
    lines.push(
      row.notice === true
        ? `${indent}${style(NOTICE_FORMATS, label)}${COLUMN_GAP}${style(NOTICE_FORMATS, row.value)}${detail}`
        : `${indent}${style(["dim"], label)}${COLUMN_GAP}${row.value}${detail}`,
    );
    for (const note of row.notes ?? []) {
      lines.push(`${indent}${" ".repeat(labelWidth)}${COLUMN_GAP}${style(["dim"], note)}`);
    }
  }
  return lines;
}
