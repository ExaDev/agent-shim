import { describe, expect, it } from "vitest";

import { SESSION_CONTROL_PLUGIN_NAME } from "./sessionControlPlugin";
import { NO_PLUGIN_TURNS, pluginTurnsAfterLine } from "./sessionPluginTurns";

/** One user row in the shape the 2.1.319 CLI writes, with the given origin. */
function userRow(uuid: string, origin: Record<string, unknown> | undefined, content: unknown = "carry on"): string {
  return JSON.stringify({ type: "user", uuid, ...(origin === undefined ? {} : { origin }), message: { role: "user", content } });
}

const PERSON_WORDS = { kind: "plugin", name: SESSION_CONTROL_PLUGIN_NAME, asUser: true };

describe("the control plugin's turns in a transcript", () => {
  it("counts only user rows the control plugin submitted as the person's words, keeping the latest", () => {
    const lines = [
      userRow("typed", undefined),
      userRow("framed", { kind: "plugin", name: SESSION_CONTROL_PLUGIN_NAME }),
      userRow("other-plugin", { kind: "plugin", name: "another", asUser: true, note: SESSION_CONTROL_PLUGIN_NAME }),
      userRow("peer", { kind: "peer", from: SESSION_CONTROL_PLUGIN_NAME }),
      userRow("first", PERSON_WORDS),
      userRow("blocks", PERSON_WORDS, [{ type: "text", text: "carry on" }]),
      JSON.stringify({ type: "attachment", uuid: "attached", origin: PERSON_WORDS }),
      `{"type":"user","origin":{"name":"${SESSION_CONTROL_PLUGIN_NAME}"`,
      userRow("second", PERSON_WORDS, "and the next file"),
    ];
    expect(lines.reduce(pluginTurnsAfterLine, NO_PLUGIN_TURNS)).toEqual({ count: 2, last: { uuid: "second", text: "and the next file" } });
  });
});
