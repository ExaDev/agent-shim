import { describe, expect, it } from "vitest";

import { mergeAreaTables } from "./table";

describe("the area tables", () => {
  it("merge into one table of every area's functions", () => {
    const a = (): number => 1;
    const b = (): number => 2;
    expect(mergeAreaTables([["one", { a }], ["two", { b }]])).toEqual({ a, b });
  });

  it("refuse a function two areas both define, naming both, since a case would run whichever came last", () => {
    const f = (): number => 1;
    expect(() => mergeAreaTables([["one", { f }], ["two", { f }]])).toThrow("the function f is defined by both one and two");
  });
});
