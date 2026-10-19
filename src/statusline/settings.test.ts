import { describe, expect, it } from "vitest";

import { UsageError } from "../cliError";
import { checkedStatusline, statuslineSettingsFromEnv } from "./settings";

describe("statuslineSettingsFromEnv", () => {
  it("reads the JSON object a launch exported", () => {
    expect(statuslineSettingsFromEnv('{"bar":{"width":6},"layout":{"header":["model"]}}', "AGENT_SHIM_STATUSLINE")).toEqual({ bar: { width: 6 }, layout: { header: ["model"] } });
  });

  it("fails loudly on text that is not JSON, naming the source", () => {
    expect(() => statuslineSettingsFromEnv("{nope", "AGENT_SHIM_STATUSLINE")).toThrow("AGENT_SHIM_STATUSLINE: not valid JSON.");
  });

  it("fails loudly on a setting the schema refuses, naming the key", () => {
    expect(() => statuslineSettingsFromEnv('{"bar":{"width":0}}', "AGENT_SHIM_STATUSLINE")).toThrow(/AGENT_SHIM_STATUSLINE: bar\.width:/);
    expect(() => statuslineSettingsFromEnv('{"theme":"dark"}', "AGENT_SHIM_STATUSLINE")).toThrow(UsageError);
  });

  it("fails loudly on thresholds that cannot be drawn", () => {
    expect(() => statuslineSettingsFromEnv('{"bands":{"warnAt":95}}', "AGENT_SHIM_STATUSLINE")).toThrow(/bands\.warnAt \(95\) must be below bands\.criticalAt \(90\)/);
  });
});

describe("checkedStatusline", () => {
  it("returns the settings it was given and names the source of a refusal", () => {
    const settings = { bands: { warnAt: 50 } };
    expect(checkedStatusline(settings, "launch.statusline")).toBe(settings);
    expect(() => checkedStatusline({ bands: { criticalAt: 10 } }, "launch.statusline")).toThrow(/^launch\.statusline: statusline bands\.warnAt/);
  });
});
