import { describe, expect, it } from "vitest";

import { MAX_STATUSLINE_PALETTE_INDEX } from "../config/statusline";
import { blendRgb, LAST_PALETTE_INDEX, rgbOfHex, rgbOfSetting, type Rgb } from "./colour";

/** The xterm scheme's channel values, as its named-colour defaults, the 6x6x6 cube and the greyscale ramp are built from them (https://en.wikipedia.org/wiki/ANSI_escape_code#8-bit_color): a channel fully on, the 16-colour palette's normal primary, the softer red and green of its bright blue, a half and a tenth of a channel rounded up, and the greyscale ramp's first, middle and last shades. */
const FULL = 255;
const PRIMARY = 205;
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
    // The greyscale runs from the cube's end, from 8 by 10s.
    expect(rgbOfSetting(GREYSCALE_FIRST_INDEX)).toEqual(FIRST_GREYSCALE);
    expect(rgbOfSetting(GREYSCALE_MIDDLE_INDEX)).toEqual(MIDDLE_GREYSCALE);
    expect(rgbOfSetting(LAST_PALETTE_INDEX)).toEqual(LAST_GREYSCALE);
    expect(LAST_PALETTE_INDEX).toBe(MAX_STATUSLINE_PALETTE_INDEX);
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
