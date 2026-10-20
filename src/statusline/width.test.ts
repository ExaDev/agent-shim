import { describe, expect, it } from "vitest";

import { STATUSLINE_DEFAULTS } from "../config/statusline";
import { DEFAULT_COLUMNS, terminalWidthOf } from "./width";

const PAYLOAD_WIDTH = 160;
const COLUMNS_WIDTH = 96;
const CONFIGURED_WIDTH = 120;
const NARROWER_THAN_ANY_CLIENT_WIDTH = 50;
const UNSET = STATUSLINE_DEFAULTS.layout;
const FALLBACK = { ...UNSET, maxWidth: CONFIGURED_WIDTH };
const FORCED = { ...UNSET, maxWidth: NARROWER_THAN_ANY_CLIENT_WIDTH, forceMaxWidth: true };

describe("terminalWidthOf", () => {
  it("prefers the payload's live terminal width over the environment's COLUMNS", () => {
    expect(terminalWidthOf({ terminal_width: PAYLOAD_WIDTH }, { COLUMNS: String(COLUMNS_WIDTH) }, UNSET)).toBe(PAYLOAD_WIDTH);
  });

  it("falls back to COLUMNS, then to the default, when the payload names no usable width", () => {
    expect(terminalWidthOf({}, { COLUMNS: String(COLUMNS_WIDTH) }, UNSET)).toBe(COLUMNS_WIDTH);
    expect(terminalWidthOf({ terminal_width: 0 }, { COLUMNS: String(COLUMNS_WIDTH) }, UNSET)).toBe(COLUMNS_WIDTH);
    expect(terminalWidthOf({ terminal_width: "wide" }, {}, UNSET)).toBe(DEFAULT_COLUMNS);
    expect(terminalWidthOf(undefined, { COLUMNS: "not-a-number" }, UNSET)).toBe(DEFAULT_COLUMNS);
  });

  it("uses the configured maxWidth only when the client and the environment name no width", () => {
    expect(terminalWidthOf({}, {}, FALLBACK)).toBe(CONFIGURED_WIDTH);
    expect(terminalWidthOf({ terminal_width: PAYLOAD_WIDTH }, {}, FALLBACK)).toBe(PAYLOAD_WIDTH);
    expect(terminalWidthOf({}, { COLUMNS: String(COLUMNS_WIDTH) }, FALLBACK)).toBe(COLUMNS_WIDTH);
  });

  it("uses a forced maxWidth whatever the client or the environment reports, wider or narrower", () => {
    expect(terminalWidthOf({ terminal_width: PAYLOAD_WIDTH }, { COLUMNS: String(COLUMNS_WIDTH) }, FORCED)).toBe(NARROWER_THAN_ANY_CLIENT_WIDTH);
    expect(terminalWidthOf({}, {}, FORCED)).toBe(NARROWER_THAN_ANY_CLIENT_WIDTH);
    expect(terminalWidthOf({ terminal_width: NARROWER_THAN_ANY_CLIENT_WIDTH - 1 }, {}, { ...FORCED, maxWidth: PAYLOAD_WIDTH })).toBe(PAYLOAD_WIDTH);
  });
});
