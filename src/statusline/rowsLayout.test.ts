import { describe, expect, it } from "vitest";

import { type BarCell } from "./barGrid";
import { layoutRows, type DrawnRow, type RowsLayoutSettings } from "./rowsLayout";

const BASE_BAR_CELLS = 4;
const WIDE = 120;
const NARROW = 40;
const THREE_LINES = 3;
/** Too narrow for two bars and their text on a line, wide enough for one. */
const ONE_BAR_WIDE = 29;

function bars(label: string): DrawnRow["output"] {
  const cell: BarCell = { prefix: `${label} `, suffix: " 10%", draw: (cells) => `[${"#".repeat(cells)}]` };
  return { kind: "bars", cells: [cell] };
}

function text(content: string): DrawnRow["output"] {
  return { kind: "text", lines: [content] };
}

const NOTHING: DrawnRow["output"] = { kind: "bars", cells: [] };

function rows(...entries: readonly (readonly [DrawnRow["name"], DrawnRow["output"]])[]): DrawnRow[] {
  return entries.map(([name, output]) => ({ name, output }));
}

function layout(drawn: readonly DrawnRow[], settings: Partial<RowsLayoutSettings>, width = WIDE): string[] {
  return layoutRows(drawn, { merge: [], rightAlign: [], barCells: BASE_BAR_CELLS, ...settings }, width);
}

describe("layoutRows", () => {
  it("draws every row on a line of its own when nothing is merged, aligning bars across the lines", () => {
    const lines = layout(rows(["context", bars("Ctx")], ["quota", bars("5h")], ["environment", text("2 rules")]), {});
    expect(lines).toHaveLength(THREE_LINES);
    expect(lines[0]?.indexOf("[")).toBe(lines[1]?.indexOf("["));
    expect(lines[2]).toBe("2 rules");
  });

  it("puts the bars of a merge group on one line when they fit, and on lines of their own when they do not", () => {
    const drawn = rows(["context", bars("Ctx")], ["quota", bars("5h")]);
    const merge = [["context", "quota"] as const];
    expect(layout(drawn, { merge })).toHaveLength(1);
    expect(layout(drawn, { merge }, ONE_BAR_WIDE)).toHaveLength(2);
  });

  it("merges only rows that are next to each other in the order and in the same group", () => {
    const merge = [["context", "quota"] as const];
    const apart = layout(rows(["context", bars("Ctx")], ["memory", bars("Mem")], ["quota", bars("5h")]), { merge });
    expect(apart).toHaveLength(THREE_LINES);
    const crossing = layout(rows(["context", bars("Ctx")], ["quota", bars("5h")], ["memory", bars("Mem")]), { merge: [["context", "memory"], ["quota", "environment"]] });
    expect(crossing).toHaveLength(THREE_LINES);
  });

  it("merges rows of text onto one line with the separator when they fit, and keeps them apart when they do not", () => {
    const drawn = rows(["memory", text("Memory 4G")], ["environment", text("2 rules")]);
    const merge = [["memory", "environment"] as const];
    expect(layout(drawn, { merge })).toEqual(["Memory 4G | 2 rules"]);
    expect(layout(drawn, { merge }, "Memory 4G | 2 rules".length - 1)).toEqual(["Memory 4G", "2 rules"]);
  });

  it("merges bars with a row of text onto one line, and keeps a row of several lines apart", () => {
    const merge = [["context", "environment"] as const];
    expect(layout(rows(["context", bars("Ctx")], ["environment", text("2 rules")]), { merge })).toEqual([`Ctx [${"#".repeat(BASE_BAR_CELLS)}] 10% | 2 rules`]);
    const tall: DrawnRow["output"] = { kind: "text", lines: ["a", "b"] };
    expect(layout(rows(["context", bars("Ctx")], ["environment", tall]), { merge })).toHaveLength(THREE_LINES);
  });

  it("skips a row with nothing to show, leaving the others of its group merged", () => {
    const merge = [["context", "quota", "memory"] as const];
    const lines = layout(rows(["context", bars("Ctx")], ["quota", NOTHING], ["memory", bars("Mem")]), { merge });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Ctx");
    expect(lines[0]).toContain("Mem");
  });

  it("draws a group of one row that has something to show as that row alone", () => {
    expect(layout(rows(["context", bars("Ctx")], ["quota", NOTHING]), { merge: [["context", "quota"]] })).toHaveLength(1);
  });

  it("right-aligns the rows from the first one named, padding the gap with spaces", () => {
    const drawn = rows(["memory", text("Memory 4G")], ["environment", text("2 rules")]);
    const [line] = layout(drawn, { merge: [["memory", "environment"]], rightAlign: ["environment"] }, NARROW);
    expect(line).toBe(`Memory 4G${" ".repeat(NARROW - "Memory 4G".length - "2 rules".length)}2 rules`);
    expect(line?.length).toBe(NARROW);
  });

  it("right-aligns every row from the first one named to the end of the line", () => {
    const drawn = rows(["memory", text("M")], ["environment", text("E")], ["context", text("C")]);
    const [line] = layout(drawn, { merge: [["memory", "environment", "context"]], rightAlign: ["environment"] }, NARROW);
    expect(line).toBe(`M${" ".repeat(NARROW - 1 - "E | C".length)}E | C`);
  });

  it("does not align when the named row is first on the line", () => {
    const drawn = rows(["memory", text("Memory 4G")], ["environment", text("2 rules")]);
    expect(layout(drawn, { merge: [["memory", "environment"]], rightAlign: ["memory"] }, NARROW)).toEqual(["Memory 4G | 2 rules"]);
  });

  it("aligns a line that exactly fills the width by widening the separator it replaces, never by cutting", () => {
    const drawn = rows(["memory", text("Memory 4G")], ["environment", text("2 rules")]);
    const exact = "Memory 4G | 2 rules".length;
    expect(layout(drawn, { merge: [["memory", "environment"]], rightAlign: ["environment"] }, exact)).toEqual(["Memory 4G   2 rules"]);
  });

  it("ignores a right-aligned row that is not merged", () => {
    expect(layout(rows(["memory", text("Memory 4G")]), { rightAlign: ["memory"] }, NARROW)).toEqual(["Memory 4G"]);
  });

  it("right-aligns bars at their base size, since a bar that fills the line would leave no gap", () => {
    const [line] = layout(rows(["context", bars("Ctx")], ["quota", bars("5h")]), { merge: [["context", "quota"]], rightAlign: ["quota"] }, WIDE);
    expect(line?.length).toBe(WIDE);
    expect(line?.startsWith(`Ctx [${"#".repeat(BASE_BAR_CELLS)}] 10%`)).toBe(true);
    expect(line?.endsWith(`5h [${"#".repeat(BASE_BAR_CELLS)}] 10%`)).toBe(true);
  });

  it("falls back to separate bar rows when right-aligned bars do not fit on one line", () => {
    expect(layout(rows(["context", bars("Ctx")], ["quota", bars("5h")]), { merge: [["context", "quota"]], rightAlign: ["quota"] }, ONE_BAR_WIDE)).toHaveLength(2);
  });
});
