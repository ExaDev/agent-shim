import { createHash } from "node:crypto";

import type { HeadroomGlobalConfig } from "../config/schema";

/** The token-saving settings of the `headroom` config block, without its install and lifecycle fields (`source`, `idleShutdownMinutes`). */
export type HeadroomSettings = Pick<HeadroomGlobalConfig, "mode" | "targetRatio" | "ccr" | "rolloutChannel" | "interceptToolResults" | "readMaturation">;

/** Picks the settings out of a headroom config block, leaving unset fields unset. */
export function settingsOf(config: Readonly<HeadroomGlobalConfig>): HeadroomSettings {
  return {
    ...(config.mode === undefined ? {} : { mode: config.mode }),
    ...(config.targetRatio === undefined ? {} : { targetRatio: config.targetRatio }),
    ...(config.ccr === undefined ? {} : { ccr: config.ccr }),
    ...(config.rolloutChannel === undefined ? {} : { rolloutChannel: config.rolloutChannel }),
    ...(config.interceptToolResults === undefined ? {} : { interceptToolResults: config.interceptToolResults }),
    ...(config.readMaturation === undefined ? {} : { readMaturation: config.readMaturation }),
  };
}

/**
 * The `headroom proxy` arguments the settings ask for, after the supervisor's own `--host` and `--port`. Only settings that are set produce a flag, so an empty settings object leaves headroom on its own defaults. `ccr: "default"` is headroom's default and likewise adds nothing.
 */
export function settingsArgs(settings: Readonly<HeadroomSettings>): string[] {
  return [
    ...(settings.mode === undefined ? [] : ["--mode", settings.mode]),
    ...(settings.targetRatio === undefined ? [] : ["--target-ratio", String(settings.targetRatio)]),
    ...(settings.ccr === "lossless" ? ["--lossless"] : []),
    ...(settings.ccr === "none" ? ["--no-ccr"] : []),
    ...(settings.interceptToolResults === true ? ["--intercept-tool-results"] : []),
    ...(settings.readMaturation === true ? ["--read-maturation"] : []),
  ];
}

/** The environment the settings add to the daemon's: only the rollout channel, which headroom reads from `HEADROOM_ROLLOUT_CHANNEL` and has no flag for. */
export function settingsEnv(settings: Readonly<HeadroomSettings>): Record<string, string> {
  return settings.rolloutChannel === undefined ? {} : { HEADROOM_ROLLOUT_CHANNEL: settings.rolloutChannel };
}

/** A stable hash of the settings, so drift detection compares one short string against what the running daemon was started with. The same settings hash the same whatever order the config file wrote its keys in. */
export function hashSettings(settings: Readonly<HeadroomSettings>): string {
  return createHash("sha256").update(JSON.stringify([...settingsArgs(settings), JSON.stringify(settingsEnv(settings))])).digest("hex");
}
