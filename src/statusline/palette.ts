import { ESCAPE } from "./ansi";
import { STATUSLINE_COLOUR_NAMES, type ResolvedStatusline } from "../config/statusline";
import { rgbOfHex, rgbOfSetting, type ColourSetting, type Rgb } from "./colour";

/** The roles the statusline paints, each a key of the `colours` settings. */
export type ColourRole = keyof ResolvedStatusline["colours"];

/** The reset that ends every painted run. */
export const RESET = `${ESCAPE}[0m`;

type ColourName = (typeof STATUSLINE_COLOUR_NAMES)[number];

const SGR_BY_NAME: Readonly<Record<ColourName, string>> = {
  default: "",
  dim: "2",
  black: "30",
  red: "31",
  green: "32",
  yellow: "33",
  blue: "34",
  magenta: "35",
  cyan: "36",
  white: "37",
  brightBlack: "90",
  brightRed: "91",
  brightGreen: "92",
  brightYellow: "93",
  brightBlue: "94",
  brightMagenta: "95",
  brightCyan: "96",
  brightWhite: "97",
};

function isColourName(value: string): value is ColourName {
  return STATUSLINE_COLOUR_NAMES.some((name) => name === value);
}

/** The SGR parameters of a 24-bit colour, the one construction a role's `#rrggbb` value and the bars' gradients both build their escapes from. */
function rgbSgr(channels: Rgb): string {
  return `38;2;${channels.join(";")}`;
}

function sgrOf(value: ColourSetting): string {
  if (typeof value === "number") {
    return `38;5;${String(value)}`;
  }
  if (value.startsWith("#")) {
    return rgbSgr(rgbOfHex(value));
  }
  return isColourName(value) ? SGR_BY_NAME[value] : "";
}

/**
 * Paints text in the settings' colours. With colour off (`NO_COLOR`) every role is plain, and a role set to `default` adds no escape either, so a palette of defaults leaves text byte for byte as it was. A colour the statusline blends for itself (a bar's gradient) is painted through the same construction by `rgb`, which colour off leaves plain the same way.
 */
export interface Palette {
  /** The escape sequence that starts a role's colour, or an empty string when the role draws in the terminal's own colour or colour is off. */
  readonly ansi: (role: ColourRole) => string;
  /** `text` in the role's colour, ended with a reset; unchanged when the role adds no escape. */
  readonly paint: (role: ColourRole, text: string) => string;
  /** The escape sequence that starts a 24-bit colour of the statusline's own, such as a gradient's blend, or an empty string when colour is off. */
  readonly rgb: (channels: Rgb) => string;
  /** The RGB of a role's colour, which a gradient blends between: `#rrggbb` as it stands, a palette index as the xterm scheme defines it, a name at the default that scheme gives it. Undefined for `default` and `dim`, which name no colour of their own. */
  readonly rgbOf: (role: ColourRole) => Rgb | undefined;
}

/** Whether the environment allows colour: `NO_COLOR` set, to anything, turns it off (https://no-color.org). */
export function colourEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.NO_COLOR === undefined;
}

export function createPalette(colours: ResolvedStatusline["colours"], enabled: boolean): Palette {
  const ansi = (role: ColourRole): string => {
    const sgr = enabled ? sgrOf(colours[role]) : "";
    return sgr === "" ? "" : `${ESCAPE}[${sgr}m`;
  };
  return {
    ansi,
    paint: (role, text) => {
      const start = ansi(role);
      return start === "" ? text : `${start}${text}${RESET}`;
    },
    rgb: (channels) => (enabled ? `${ESCAPE}[${rgbSgr(channels)}m` : ""),
    rgbOf: (role) => rgbOfSetting(colours[role]),
  };
}
