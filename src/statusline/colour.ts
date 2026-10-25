import { STATUSLINE_COLOUR_NAMES, type ResolvedStatusline } from "../config/statusline";

/** A colour as a `colours` setting writes it: a name, an index into the 256-colour palette, or `#rrggbb`. */
export type ColourSetting = ResolvedStatusline["colours"][keyof ResolvedStatusline["colours"]];

/** An RGB colour: its red, green and blue channels, each a whole number from 0 to 255. */
export type Rgb = readonly [red: number, green: number, blue: number];

/** The colour names that name a colour of their own. `default` names the terminal's own colour and `dim` the faint attribute, so neither is one of them. */
type NamedColour = Exclude<(typeof STATUSLINE_COLOUR_NAMES)[number], "default" | "dim">;

/** A channel fully on. */
const FULL_CHANNEL = 255;
/** The 16-colour palette's normal primary: the channel of its red, green, yellow, magenta and cyan. */
const NORMAL_PRIMARY = 205;
/** The channel xterm's own defaults give white. */
const SCHEME_WHITE = 229;
/** The channel xterm's own defaults give blue. */
const SCHEME_BLUE = 238;
/** The grey of the scheme's bright black. */
const BRIGHT_BLACK_GREY = 127;
/** The softer red and green of the scheme's bright blue. */
const BRIGHT_BLUE_TINT = 92;

/**
 * The RGB the xterm scheme gives each colour name by default (xterm's own `color0` to `color15` resources, resolved through the colour names it maps them to; the resulting values are the xterm column of the table at https://en.wikipedia.org/wiki/ANSI_escape_code#3-bit_and_4-bit). A themed terminal may draw a name differently, but the RGB a name stands for cannot be known from here, so a gradient that stops at a named colour blends these defaults and a themed terminal sees the default shade there.
 */
const NAMED_DEFAULT_RGB: Readonly<Record<NamedColour, Rgb>> = {
  black: [0, 0, 0],
  red: [NORMAL_PRIMARY, 0, 0],
  green: [0, NORMAL_PRIMARY, 0],
  yellow: [NORMAL_PRIMARY, NORMAL_PRIMARY, 0],
  blue: [0, 0, SCHEME_BLUE],
  magenta: [NORMAL_PRIMARY, 0, NORMAL_PRIMARY],
  cyan: [0, NORMAL_PRIMARY, NORMAL_PRIMARY],
  white: [SCHEME_WHITE, SCHEME_WHITE, SCHEME_WHITE],
  brightBlack: [BRIGHT_BLACK_GREY, BRIGHT_BLACK_GREY, BRIGHT_BLACK_GREY],
  brightRed: [FULL_CHANNEL, 0, 0],
  brightGreen: [0, FULL_CHANNEL, 0],
  brightYellow: [FULL_CHANNEL, FULL_CHANNEL, 0],
  brightBlue: [BRIGHT_BLUE_TINT, BRIGHT_BLUE_TINT, FULL_CHANNEL],
  brightMagenta: [FULL_CHANNEL, 0, FULL_CHANNEL],
  brightCyan: [0, FULL_CHANNEL, FULL_CHANNEL],
  brightWhite: [FULL_CHANNEL, FULL_CHANNEL, FULL_CHANNEL],
};

function isNamedColour(value: string): value is NamedColour {
  return value !== "default" && value !== "dim" && STATUSLINE_COLOUR_NAMES.some((name) => name === value);
}

/** The named colours' RGB in palette order: the names come in the order of the palette's first sixteen indexes, after `default` and `dim`, which are not colours. */
const NAMED_RGB_IN_PALETTE_ORDER: readonly Rgb[] = STATUSLINE_COLOUR_NAMES.filter(isNamedColour).map((name) => NAMED_DEFAULT_RGB[name]);

/** The side of the 6x6x6 colour cube the 256-colour palette holds, as the xterm scheme defines it. */
const CUBE_SIDE = 6;
/** The palette's first cube index; the named colours come before it. */
const CUBE_FIRST_INDEX = 16;
/** The greyscale ramp's first index: the cube's colours (its side, cubed) come before it. */
const GREYSCALE_FIRST_INDEX = CUBE_FIRST_INDEX + CUBE_SIDE * CUBE_SIDE * CUBE_SIDE;
/** The greyscale ramp's first shade and the step between its shades (8, 18, 28 ... 238), as the xterm scheme defines it. */
const GREYSCALE_START = 8;
const GREYSCALE_STEP = 10;
/** The cube's channel ramp: level 0 is none of the channel and every level above adds 40 from 55 (0, 95, 135, 175, 215, 255), as the xterm scheme defines it. */
const CUBE_CHANNEL_BASE = 55;
const CUBE_CHANNEL_STEP = 40;

/** One channel of the cube at a level of it. */
function cubeChannel(level: number): number {
  return level === 0 ? 0 : CUBE_CHANNEL_BASE + CUBE_CHANNEL_STEP * level;
}

/** The RGB of an index into the 256-colour palette as the xterm scheme defines it: a named colour below 16, a cube colour at 16 to 231 and a greyscale one from 232. Undefined for a negative index; the schema holds a setting to 0 to 255. */
function paletteIndexRgb(index: number): Rgb | undefined {
  if (index < CUBE_FIRST_INDEX) {
    return NAMED_RGB_IN_PALETTE_ORDER[index];
  }
  if (index < GREYSCALE_FIRST_INDEX) {
    const cube = index - CUBE_FIRST_INDEX;
    return [cubeChannel(Math.floor(cube / CUBE_SIDE ** 2)), cubeChannel(Math.floor(cube / CUBE_SIDE) % CUBE_SIDE), cubeChannel(cube % CUBE_SIDE)];
  }
  const grey = GREYSCALE_START + GREYSCALE_STEP * (index - GREYSCALE_FIRST_INDEX);
  return [grey, grey, grey];
}

/** The digits of one channel of a `#rrggbb` value, and the radix they are written in. */
const CHANNEL_DIGITS = 2;
const HEX_RADIX = 16;
/** The character a `#rrggbb` value's channels start after. */
const HASH_LENGTH = 1;

/** A `#rrggbb` value as its three channels. */
export function rgbOfHex(value: string): Rgb {
  const channel = (index: number): number => Number.parseInt(value.slice(HASH_LENGTH + index * CHANNEL_DIGITS, HASH_LENGTH + (index + 1) * CHANNEL_DIGITS), HEX_RADIX);
  return [channel(0), channel(1), channel(2)];
}

/**
 * The RGB of a colour setting: `#rrggbb` as it stands, a palette index as the xterm scheme defines it, and a name at the default the xterm scheme gives it, which a themed terminal may draw differently. `default` and `dim` name no colour of their own, so they have no RGB and the caller falls back to what it draws without a gradient.
 */
export function rgbOfSetting(value: ColourSetting): Rgb | undefined {
  if (typeof value === "number") {
    return paletteIndexRgb(value);
  }
  if (value.startsWith("#")) {
    return rgbOfHex(value);
  }
  return isNamedColour(value) ? NAMED_DEFAULT_RGB[value] : undefined;
}

/** `from` at 0 and `to` at 1, each channel interpolated on its own, linearly, and rounded to the nearest whole value: a per-channel linear blend of the sRGB values, since a perceptual space is not worth it for a bar of block characters. `at` is the caller's to hold between 0 and 1. */
export function blendRgb(from: Rgb, to: Rgb, at: number): Rgb {
  const channel = (start: number, end: number): number => Math.round(start + (end - start) * at);
  return [channel(from[0], to[0]), channel(from[1], to[1]), channel(from[2], to[2])];
}
