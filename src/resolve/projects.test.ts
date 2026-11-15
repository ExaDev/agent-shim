import { describe, expect, it } from "vitest";

import * as projects from "./projects";

describe("module surface", () => {
  it("exports no decode function of any kind — the encoding is many-to-one and must never be inverted", () => {
    const decoders = Object.keys(projects).filter((name) => /decode|invert|reverse|toRealPath/i.test(name));
    expect(decoders).toEqual([]);
  });
});
