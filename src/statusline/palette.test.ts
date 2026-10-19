import { describe, expect, it } from "vitest";

import { STATUSLINE_DEFAULTS } from "../config/statusline";
import { ESCAPE as ESC } from "./ansi";
import { colourEnabled, createPalette, RESET } from "./palette";

const paletteOf = (overrides: Readonly<Partial<typeof STATUSLINE_DEFAULTS.colours>>, enabled = true) => createPalette({ ...STATUSLINE_DEFAULTS.colours, ...overrides }, enabled);

describe("createPalette", () => {
  it("starts a named colour with its escape and ends the painted text with a reset", () => {
    expect(paletteOf({ model: "cyan" }).paint("model", "Sonnet")).toBe(`${ESC}[36mSonnet${RESET}`);
    expect(paletteOf({ label: "dim" }).paint("label", "x")).toBe(`${ESC}[2mx${RESET}`);
    expect(paletteOf({ label: "brightBlue" }).ansi("label")).toBe(`${ESC}[94m`);
  });

  it("writes a palette index and a hex value as the extended colour sequences", () => {
    expect(paletteOf({ model: 208 }).ansi("model")).toBe(`${ESC}[38;5;208m`);
    expect(paletteOf({ model: 0 }).ansi("model")).toBe(`${ESC}[38;5;0m`);
    expect(paletteOf({ model: "#ff8000" }).ansi("model")).toBe(`${ESC}[38;2;255;128;0m`);
    expect(paletteOf({ model: "#FF8000" }).ansi("model")).toBe(`${ESC}[38;2;255;128;0m`);
  });

  it("leaves text untouched for the default colour, so a palette of defaults changes nothing", () => {
    const palette = paletteOf({ model: "default" });
    expect(palette.ansi("model")).toBe("");
    expect(palette.paint("model", "Sonnet")).toBe("Sonnet");
  });

  it("paints nothing at all with colour off, whatever the settings say", () => {
    const palette = paletteOf({ model: "red", critical: "#ff0000" }, false);
    expect(palette.ansi("model")).toBe("");
    expect(palette.paint("critical", "x")).toBe("x");
  });
});

describe("colourEnabled", () => {
  it("is off when NO_COLOR is set, even to an empty value", () => {
    expect(colourEnabled({})).toBe(true);
    expect(colourEnabled({ NO_COLOR: "" })).toBe(false);
    expect(colourEnabled({ NO_COLOR: "1" })).toBe(false);
  });
});
