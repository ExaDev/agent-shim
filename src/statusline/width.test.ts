import { describe, expect, it } from "vitest";

import { DEFAULT_COLUMNS, terminalWidthOf } from "./width";

const PAYLOAD_WIDTH = 160;
const COLUMNS_WIDTH = 96;

describe("terminalWidthOf", () => {
  it("prefers the payload's live terminal width over the environment's COLUMNS", () => {
    expect(terminalWidthOf({ terminal_width: PAYLOAD_WIDTH }, { COLUMNS: String(COLUMNS_WIDTH) })).toBe(PAYLOAD_WIDTH);
  });

  it("falls back to COLUMNS, then to the default, when the payload names no usable width", () => {
    expect(terminalWidthOf({}, { COLUMNS: String(COLUMNS_WIDTH) })).toBe(COLUMNS_WIDTH);
    expect(terminalWidthOf({ terminal_width: 0 }, { COLUMNS: String(COLUMNS_WIDTH) })).toBe(COLUMNS_WIDTH);
    expect(terminalWidthOf({ terminal_width: "wide" }, {})).toBe(DEFAULT_COLUMNS);
    expect(terminalWidthOf(undefined, { COLUMNS: "not-a-number" })).toBe(DEFAULT_COLUMNS);
  });
});
