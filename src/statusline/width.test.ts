import { describe, expect, it } from "vitest";

import { MIN_STATUSLINE_COLUMNS, STATUSLINE_DEFAULTS } from "../config/statusline";
import { RESERVED_COLUMNS } from "./render";
import { DEFAULT_COLUMNS, widthsOf } from "./width";

const PAYLOAD_WIDTH = 160;
const COLUMNS_WIDTH = 96;
const CONFIGURED_WIDTH = 120;
const NARROWER_THAN_ANY_CLIENT_WIDTH = 50;
const UNSET = STATUSLINE_DEFAULTS.layout;
const FALLBACK = { ...UNSET, maxWidth: CONFIGURED_WIDTH };
const FORCED = { ...UNSET, maxWidth: NARROWER_THAN_ANY_CLIENT_WIDTH, forceMaxWidth: true };
const BELOW_THE_MINIMUM = MIN_STATUSLINE_COLUMNS - 1;

describe("widthsOf", () => {
  it("prefers the payload's live terminal width over the environment's COLUMNS, and draws to it less the client's reserve", () => {
    expect(widthsOf({ terminal_width: PAYLOAD_WIDTH }, { COLUMNS: String(COLUMNS_WIDTH) }, UNSET)).toEqual({ terminal: PAYLOAD_WIDTH, line: PAYLOAD_WIDTH - RESERVED_COLUMNS });
  });

  it("falls back to COLUMNS, then to the default, when the payload names no usable width", () => {
    const columns = { terminal: COLUMNS_WIDTH, line: COLUMNS_WIDTH - RESERVED_COLUMNS };
    expect(widthsOf({}, { COLUMNS: String(COLUMNS_WIDTH) }, UNSET)).toEqual(columns);
    expect(widthsOf({ terminal_width: 0 }, { COLUMNS: String(COLUMNS_WIDTH) }, UNSET)).toEqual(columns);
    const assumed = { terminal: DEFAULT_COLUMNS, line: DEFAULT_COLUMNS - RESERVED_COLUMNS };
    expect(widthsOf({ terminal_width: "wide" }, {}, UNSET)).toEqual(assumed);
    expect(widthsOf(undefined, { COLUMNS: "not-a-number" }, UNSET)).toEqual(assumed);
  });

  it("never draws a reported terminal to fewer columns than a line can be drawn in", () => {
    expect(widthsOf({ terminal_width: BELOW_THE_MINIMUM }, {}, UNSET)).toEqual({ terminal: BELOW_THE_MINIMUM, line: MIN_STATUSLINE_COLUMNS });
  });

  it("uses the configured maxWidth, exactly, only when the client and the environment name no width", () => {
    expect(widthsOf({}, {}, FALLBACK)).toEqual({ terminal: CONFIGURED_WIDTH, line: CONFIGURED_WIDTH });
    expect(widthsOf({ terminal_width: PAYLOAD_WIDTH }, {}, FALLBACK).line).toBe(PAYLOAD_WIDTH - RESERVED_COLUMNS);
    expect(widthsOf({}, { COLUMNS: String(COLUMNS_WIDTH) }, FALLBACK).line).toBe(COLUMNS_WIDTH - RESERVED_COLUMNS);
  });

  it("uses a forced maxWidth, exactly, whatever the client or the environment reports, wider or narrower", () => {
    const forced = { terminal: NARROWER_THAN_ANY_CLIENT_WIDTH, line: NARROWER_THAN_ANY_CLIENT_WIDTH };
    expect(widthsOf({ terminal_width: PAYLOAD_WIDTH }, { COLUMNS: String(COLUMNS_WIDTH) }, FORCED)).toEqual(forced);
    expect(widthsOf({}, {}, FORCED)).toEqual(forced);
    expect(widthsOf({ terminal_width: NARROWER_THAN_ANY_CLIENT_WIDTH - 1 }, {}, { ...FORCED, maxWidth: PAYLOAD_WIDTH }).line).toBe(PAYLOAD_WIDTH);
    expect(widthsOf({}, {}, { ...FORCED, maxWidth: MIN_STATUSLINE_COLUMNS }).line).toBe(MIN_STATUSLINE_COLUMNS);
  });
});
