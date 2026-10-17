import { describe, expect, it } from "vitest";

import type { StyleText } from "../logStyle";
import { renderReport } from "./report";

const plain: StyleText = (_formats, text) => text;
const visible: StyleText = (formats, text) => `<${formats.join("+")}>${text}</>`;

describe("renderReport", () => {
  it("prints nothing for a launch with nothing to report", () => {
    expect(renderReport([], plain)).toEqual([]);
  });

  it("introduces the rows with a heading and lines their labels up in one column", () => {
    expect(
      renderReport(
        [
          { label: "identity", value: "work", detail: "argv" },
          { label: "routing", value: "front door 127.0.0.1:4100" },
        ],
        plain,
      ),
    ).toEqual(["agent-shim", "  identity  work (argv)", "  routing   front door 127.0.0.1:4100"]);
  });

  it("puts a row's notes under its value, one to a line", () => {
    expect(renderReport([{ label: "pool", value: "main", notes: ["used here 5m ago", "cache warm"] }, { label: "farm", value: "resynced" }], plain)).toEqual([
      "agent-shim",
      "  pool  main",
      "        used here 5m ago",
      "        cache warm",
      "  farm  resynced",
    ]);
  });

  it("dims labels, details and notes, makes the heading bold and leaves values as they are", () => {
    expect(renderReport([{ label: "pool", value: "main", detail: "moved", notes: ["why"] }], visible)).toEqual([
      "<bold>agent-shim</>",
      "  <dim>pool</>  main <dim>(moved)</>",
      "        <dim>why</>",
    ]);
  });

  it("pads each label to the longest one before styling it, so the column holds when the style adds codes", () => {
    const [, short, long] = renderReport([{ label: "a", value: "1" }, { label: "longer", value: "2" }], visible);
    expect(short).toBe("  <dim>a     </>  1");
    expect(long).toBe("  <dim>longer</>  2");
  });
});
