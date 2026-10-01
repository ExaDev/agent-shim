import { describe, expect, it } from "vitest";

import { GlobalConfigSchema } from "../config/schema";
import { hashSettings, settingsArgs, settingsEnv, settingsOf } from "./settings";

describe("settingsArgs", () => {
  it("adds nothing for empty settings or the default CCR mode, leaving headroom on its own defaults", () => {
    expect(settingsArgs({})).toEqual([]);
    expect(settingsArgs({ ccr: "default" })).toEqual([]);
  });

  it("turns each set setting into its flag", () => {
    expect(settingsArgs({ mode: "token", targetRatio: 0.4 })).toEqual(["--mode", "token", "--target-ratio", "0.4"]);
    expect(settingsArgs({ ccr: "lossless" })).toEqual(["--lossless"]);
    expect(settingsArgs({ ccr: "none" })).toEqual(["--no-ccr"]);
    expect(settingsArgs({ rolloutChannel: "dev", interceptToolResults: true, readMaturation: true })).toEqual(["--intercept-tool-results", "--read-maturation"]);
  });

  it("does not emit an opt-in switched off", () => {
    expect(settingsArgs({ interceptToolResults: false, readMaturation: false })).toEqual([]);
  });
});

describe("settingsEnv", () => {
  it("exports only the rollout channel", () => {
    expect(settingsEnv({})).toEqual({});
    expect(settingsEnv({ mode: "token", rolloutChannel: "beta" })).toEqual({ HEADROOM_ROLLOUT_CHANNEL: "beta" });
  });
});

describe("hashSettings", () => {
  it("is equal for equal settings and different when any setting differs", () => {
    expect(hashSettings({ mode: "token", ccr: "lossless" })).toBe(hashSettings({ ccr: "lossless", mode: "token" }));
    expect(hashSettings({ mode: "token" })).not.toBe(hashSettings({ mode: "cache" }));
    expect(hashSettings({ rolloutChannel: "beta" })).not.toBe(hashSettings({}));
  });
});

describe("settingsOf", () => {
  it("keeps only the token-saving settings", () => {
    expect(settingsOf({ source: "x", idleShutdownMinutes: 5, mode: "cache" })).toEqual({ mode: "cache" });
  });
});

describe("the headroom config block", () => {
  const parse = (headroom: unknown) => GlobalConfigSchema.safeParse({ headroom });

  it("accepts the settings", () => {
    expect(parse({ mode: "token", targetRatio: 0.5, ccr: "none" }).success).toBe(true);
  });

  it("refuses a ratio outside (0, 1] and unknown values", () => {
    expect(parse({ targetRatio: 0 }).success).toBe(false);
    expect(parse({ targetRatio: 1.5 }).success).toBe(false);
    expect(parse({ mode: "fast" }).success).toBe(false);
    expect(parse({ ccr: "some" }).success).toBe(false);
  });

  it("refuses an experimental opt-in without a channel that unlocks it", () => {
    expect(parse({ interceptToolResults: true }).success).toBe(false);
    expect(parse({ interceptToolResults: true, rolloutChannel: "beta" }).success).toBe(false);
    expect(parse({ interceptToolResults: true, rolloutChannel: "canary" }).success).toBe(true);
    expect(parse({ readMaturation: true }).success).toBe(false);
    expect(parse({ readMaturation: true, rolloutChannel: "canary" }).success).toBe(false);
    expect(parse({ readMaturation: true, rolloutChannel: "beta" }).success).toBe(true);
    expect(parse({ interceptToolResults: true, readMaturation: true, rolloutChannel: "dev" }).success).toBe(true);
  });
});
