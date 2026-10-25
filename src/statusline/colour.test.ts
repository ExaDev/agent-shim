import { describe, expect, it } from "vitest";

import { MAX_STATUSLINE_PALETTE_INDEX } from "../config/statusline";
import { blendRgb, rgbOfHex, rgbOfSetting, type ColourSetting, type Rgb } from "./colour";

/** The xterm scheme's channel values (the 16-colour palette's values are the xterm column of https://en.wikipedia.org/wiki/ANSI_escape_code#3-bit_and_4-bit, the cube and the greyscale ramp come from https://en.wikipedia.org/wiki/ANSI_escape_code#8-bit): a channel fully on, the palette's normal primary, the channels of its blue, white and bright black, the softer red and green of its bright blue, and the greyscale ramp's first, middle and last shades; then the blends the tests expect, a half and a tenth of the way between two colours, rounded. */
const FULL = 255;
const PRIMARY = 205;
const SCHEME_BLUE = 238;
const SCHEME_WHITE = 229;
const SCHEME_GREY = 127;
const BRIGHT_BLUE_TINT = 92;
const HALF_UP = 128;
const PRIMARY_HALF_UP = 103;
const TENTH_UP = 26;
const PRIMARY_LESS_A_TENTH = 185;
const FIRST_GREY = 8;
const MIDDLE_GREY = 128;
const LAST_GREY = 238;

const BLACK: Rgb = [0, 0, 0];
const PURE_BLUE: Rgb = [0, 0, FULL];
const PURE_RED: Rgb = [FULL, 0, 0];
const PURE_WHITE: Rgb = [FULL, FULL, FULL];
const NAMED_GREEN: Rgb = [0, PRIMARY, 0];
const NAMED_BRIGHT_BLUE: Rgb = [BRIGHT_BLUE_TINT, BRIGHT_BLUE_TINT, FULL];
const ORANGE: Rgb = [FULL, HALF_UP, 0];
/** Three distinct small channel values, so a hex reading is told apart channel by channel. */
const LOW_RED = 10;
const LOW_GREEN = 11;
const LOW_BLUE = 12;
const NEAR_BLACK: Rgb = [LOW_RED, LOW_GREEN, LOW_BLUE];
const FIRST_GREYSCALE: Rgb = [FIRST_GREY, FIRST_GREY, FIRST_GREY];
const MIDDLE_GREYSCALE: Rgb = [MIDDLE_GREY, MIDDLE_GREY, MIDDLE_GREY];
const LAST_GREYSCALE: Rgb = [LAST_GREY, LAST_GREY, LAST_GREY];

/** Indexes into the 256-colour palette as the xterm scheme lays it out: the cube's first colour and its blue, red and white corners, then the greyscale ramp's first, middle and last steps. */
const CUBE_FIRST = 16;
const CUBE_BLUE_CORNER = 21;
const CUBE_RED_CORNER = 196;
const CUBE_WHITE_CORNER = 231;
/** The cube's colours run in base 6 from the first index: index 16 plus 36 for each red level, 6 for each green level and 1 for each blue level, so one step along its grey diagonal is 36 + 6 + 1 = 43 indexes. */
const CUBE_DIAGONAL_STRIDE = 43;
/** The xterm scheme's cube channel values at levels 1 to 4, as literal values rather than the formula the code derives them from (level 0 is 0 and level 5 is a channel fully on). */
const CUBE_LEVEL_1 = 95;
const CUBE_LEVEL_2 = 135;
const CUBE_LEVEL_3 = 175;
const CUBE_LEVEL_4 = 215;
const CUBE_CHANNEL_RAMP = [0, CUBE_LEVEL_1, CUBE_LEVEL_2, CUBE_LEVEL_3, CUBE_LEVEL_4, FULL] as const;
/** An index off the diagonal with three different inner levels: red 1, green 2 and blue 3, which are 95, 135 and 175. */
const CUBE_INNER_INDEX = 67;
const CUBE_INNER_RGB: Rgb = [CUBE_LEVEL_1, CUBE_LEVEL_2, CUBE_LEVEL_3];
const GREYSCALE_FIRST_INDEX = 232;
const GREYSCALE_MIDDLE_INDEX = 244;

describe("rgbOfSetting", () => {
  it("reads a #rrggbb value as its channels", () => {
    expect(rgbOfHex("#ff8000")).toEqual(ORANGE);
    expect(rgbOfSetting("#0a0b0c")).toEqual(NEAR_BLACK);
  });

  it("reads a palette index as the xterm scheme defines it: the cube and the greyscale", () => {
    // The cube runs from the first index: three channel levels of the ramp 0, 95, 135, 175, 215, 255.
    expect(rgbOfSetting(CUBE_FIRST)).toEqual(BLACK);
    expect(rgbOfSetting(CUBE_BLUE_CORNER)).toEqual(PURE_BLUE);
    expect(rgbOfSetting(CUBE_RED_CORNER)).toEqual(PURE_RED);
    expect(rgbOfSetting(CUBE_WHITE_CORNER)).toEqual(PURE_WHITE);
    // Every channel level of the ramp, not only its ends: a ramp of evenly spaced levels would pass the corners above.
    CUBE_CHANNEL_RAMP.forEach((level, step) => {
      expect(rgbOfSetting(CUBE_FIRST + CUBE_DIAGONAL_STRIDE * step), `level ${String(step)}`).toEqual([level, level, level]);
    });
    expect(rgbOfSetting(CUBE_INNER_INDEX)).toEqual(CUBE_INNER_RGB);
    // The greyscale runs from the cube's end, from 8 by 10s.
    expect(rgbOfSetting(GREYSCALE_FIRST_INDEX)).toEqual(FIRST_GREYSCALE);
    expect(rgbOfSetting(GREYSCALE_MIDDLE_INDEX)).toEqual(MIDDLE_GREYSCALE);
    expect(rgbOfSetting(MAX_STATUSLINE_PALETTE_INDEX)).toEqual(LAST_GREYSCALE);
  });

  it("reads the first sixteen indexes as the named colours, in the palette's order", () => {
    const NAMES_IN_PALETTE_ORDER = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white", "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"] as const;
    NAMES_IN_PALETTE_ORDER.forEach((name, index) => {
      expect(rgbOfSetting(index), `index ${String(index)}`).toEqual(rgbOfSetting(name));
    });
    const NAMED_RED_INDEX = 1;
    const BRIGHT_BLUE_INDEX = 12;
    expect(rgbOfSetting(NAMED_RED_INDEX)).toEqual([PRIMARY, 0, 0]);
    expect(rgbOfSetting(BRIGHT_BLUE_INDEX)).toEqual(NAMED_BRIGHT_BLUE);
  });

  it("reads each named colour at the xterm scheme's own default, as literal values", () => {
    const XTERM_DEFAULTS: readonly (readonly [ColourSetting, Rgb])[] = [
      ["black", BLACK],
      ["red", [PRIMARY, 0, 0]],
      ["green", NAMED_GREEN],
      ["yellow", [PRIMARY, PRIMARY, 0]],
      ["blue", [0, 0, SCHEME_BLUE]],
      ["magenta", [PRIMARY, 0, PRIMARY]],
      ["cyan", [0, PRIMARY, PRIMARY]],
      ["white", [SCHEME_WHITE, SCHEME_WHITE, SCHEME_WHITE]],
      ["brightBlack", [SCHEME_GREY, SCHEME_GREY, SCHEME_GREY]],
      ["brightRed", PURE_RED],
      ["brightGreen", [0, FULL, 0]],
      ["brightYellow", [FULL, FULL, 0]],
      ["brightBlue", NAMED_BRIGHT_BLUE],
      ["brightMagenta", [FULL, 0, FULL]],
      ["brightCyan", [0, FULL, FULL]],
      ["brightWhite", PURE_WHITE],
    ];
    for (const [name, rgb] of XTERM_DEFAULTS) {
      expect(rgbOfSetting(name), String(name)).toEqual(rgb);
    }
  });

  it("reads a colour name at the default the xterm scheme gives it, and gives default and dim none", () => {
    expect(rgbOfSetting("green")).toEqual(NAMED_GREEN);
    expect(rgbOfSetting("brightBlue")).toEqual(NAMED_BRIGHT_BLUE);
    expect(rgbOfSetting("black")).toEqual(BLACK);
    expect(rgbOfSetting("brightWhite")).toEqual(PURE_WHITE);
    expect(rgbOfSetting("default")).toBeUndefined();
    expect(rgbOfSetting("dim")).toBeUndefined();
  });
});

describe("blendRgb", () => {
  /** Blend positions: halfway and a tenth of the way. */
  const HALF = 0.5;
  const TENTH = 0.1;

  it("holds the start colour at 0 and the end colour at 1, exactly", () => {
    expect(blendRgb(NAMED_GREEN, PURE_RED, 0)).toEqual(NAMED_GREEN);
    expect(blendRgb(NAMED_GREEN, PURE_RED, 1)).toEqual(PURE_RED);
  });

  it("blends each channel on its own, linearly, rounding halves up", () => {
    // Halfway lands both blended channels on an exact half (255 over 2 and 205 over 2), so the rounding is part of what is tested.
    expect(blendRgb(NAMED_GREEN, PURE_RED, HALF)).toEqual([HALF_UP, PRIMARY_HALF_UP, 0]);
    expect(blendRgb(NAMED_GREEN, PURE_RED, TENTH)).toEqual([TENTH_UP, PRIMARY_LESS_A_TENTH, 0]);
  });
});
