import { describe, expect, it } from "vitest";

import { resolveStatusline } from "../../../config/statusline";
import { ESCAPE } from "../../ansi";
import { parseClientPayload, viewOf } from "../../payload";
import { renderStatuslineBlock } from "../../render";
import { fakeStatuslinePorts, fakeStatuslineSummary } from "../../testing";

const WIDE_TERMINAL = 100;
const RED = `${ESCAPE}[31m`;
const RESET = `${ESCAPE}[0m`;
const red = (text: string): string => `${RED}${text}${RESET}`;

/** The statusline for `directories` added to a session in `/work`, under `settings` with the label colour red and colour on. */
function draw(directories: readonly string[], settings: Parameters<typeof resolveStatusline>[0]): string {
  const payload = parseClientPayload({ cwd: "/work", workspace: { added_dirs: directories } });
  return renderStatuslineBlock({ summary: fakeStatuslineSummary(), view: viewOf(payload), payload, terminalWidth: WIDE_TERMINAL, nowMs: 0, settings: resolveStatusline(settings), ports: fakeStatuslinePorts() });
}

/** The added directories row at `directories`. */
function row(directories: readonly string[]): string {
  return draw(directories, { layout: { header: [], rows: ["addedDirs"] }, project: { addedDirsLayout: "row" }, colours: { label: "red" } });
}

describe("the added directories row, colour on", () => {
  // The expected bytes are what the statusline wrote before it had a catalogue: the label, each name and each separator painted apart, and the one space between the label and the names left plain.
  it("paints the label, each name and each separator in their own runs", () => {
    expect(row(["/a/b", "/c/d"])).toBe(`${red("Added dirs:")} ${red("b")}${red(", ")}${red("d")}`);
  });

  it("paints the count of the directories left out as one more name", () => {
    const text = row(["/a/b", "/c/d", "/e/f", "/g/h", "/i/j", "/k/l", "/m/n"]);
    expect(text).toBe(`${red("Added dirs:")} ${["b", "d", "f", "h", "j", "+2 more"].map(red).join(red(", "))}`);
  });
});

describe("the added directories inline in the project segment, colour on", () => {
  it("paints each name and the count left out in the label colour, inside the project's own colour", () => {
    const text = draw(["/a/b", "/c/d", "/e/f", "/g/h", "/i/j", "/k/l", "/m/n"], { layout: { header: ["project"], rows: [] }, colours: { label: "red", project: "green" } });
    expect(text).toBe(`${ESCAPE}[32mwork ${["+b", "+d", "+f", "+h", "+j", "+2 more"].map(red).join(" ")}${RESET}`);
  });
});
