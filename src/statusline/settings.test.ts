import { describe, expect, it } from "vitest";

import { UsageError } from "../cliError";
import { checkedStatusline, statuslineSettingsFromEnv } from "./settings";

describe("statuslineSettingsFromEnv", () => {
  it("reads the JSON object a launch exported", () => {
    expect(statuslineSettingsFromEnv('{"barWidth":6,"header":["model"]}', "AGENT_SHIM_STATUSLINE")).toEqual({ barWidth: 6, header: ["model"] });
  });

  it("fails loudly on text that is not JSON, naming the source", () => {
    expect(() => statuslineSettingsFromEnv("{nope", "AGENT_SHIM_STATUSLINE")).toThrow("AGENT_SHIM_STATUSLINE: not valid JSON.");
  });

  it("fails loudly on a setting the schema refuses, naming the key", () => {
    expect(() => statuslineSettingsFromEnv('{"barWidth":0}', "AGENT_SHIM_STATUSLINE")).toThrow(/AGENT_SHIM_STATUSLINE: barWidth:/);
    expect(() => statuslineSettingsFromEnv('{"theme":"dark"}', "AGENT_SHIM_STATUSLINE")).toThrow(UsageError);
  });

  it("fails loudly on thresholds that cannot be drawn", () => {
    expect(() => statuslineSettingsFromEnv('{"warnAt":95}', "AGENT_SHIM_STATUSLINE")).toThrow(/warnAt \(95\) must be below criticalAt \(90\)/);
  });
});

describe("checkedStatusline", () => {
  it("returns the settings it was given and names the source of a refusal", () => {
    const settings = { warnAt: 50 };
    expect(checkedStatusline(settings, "launch.statusline")).toBe(settings);
    expect(() => checkedStatusline({ criticalAt: 10 }, "launch.statusline")).toThrow(/^launch\.statusline: statusline warnAt/);
  });
});
