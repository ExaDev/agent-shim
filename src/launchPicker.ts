import { realPromptsPort } from "./configure";
import { listIdentities } from "./identityStore";
import type { buildFarmRuntime } from "./launchWiring";
import type { ParsedLauncherArgv } from "./launcher/argv";
import type { IdentityDecision } from "./launcher/identity";
import { memberProviderResolver } from "./launcher/memberProvider";
import { promptsIdentityPicker } from "./launcher/pickerPrompt";
import { runIdentityPicker, type PickerOutcome } from "./launcher/runPicker";
import type { LayoutPaths } from "./paths";
import { realFsPort } from "./realPorts";

/** What the real identity picker needs from the launch that is about to start. */
interface LaunchPickerParams {
  readonly paths: LayoutPaths;
  readonly farm: ReturnType<typeof buildFarmRuntime>;
  readonly parsed: ParsedLauncherArgv;
  /** The identity (or pool) the launch resolved before any question. */
  readonly decision: IdentityDecision;
  /** The environment the launch inherits, which can name a configuration profile. */
  readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * Offers the launch's identity choice on the real terminal, when `runIdentityPicker` finds a reason to: standard input and output are both terminals, the real prompts ask, and the identities come from the real store. The command line's wiring of the picker; the decision of when to ask lives in `src/launcher/pickerDecision.ts`.
 */
export async function pickLaunchIdentity(params: Readonly<LaunchPickerParams>): Promise<PickerOutcome> {
  return await runIdentityPicker({
    parsed: params.parsed,
    decision: params.decision,
    interactive: process.stdin.isTTY && process.stdout.isTTY,
    paths: params.paths,
    fs: realFsPort,
    usageFs: params.farm.runtime.fs,
    pools: params.farm.pools,
    cwd: params.farm.runtime.cwd,
    now: params.farm.runtime.now,
    identityNames: () => listIdentities(params.paths).flatMap((listing) => ("problem" in listing ? [] : [listing.name])),
    // The picker ranks on what the launch will spend, so each identity is judged on the provider the launch resolves for it.
    providerOf: memberProviderResolver({
      paths: params.paths,
      fs: realFsPort,
      env: params.env,
      cliProvider: params.parsed.provider,
      ...(params.parsed.configProfile === undefined ? {} : { cliFlagConfigProfile: params.parsed.configProfile }),
      ...(params.farm.directoryConfigProfile === undefined ? {} : { directoryRuleConfigProfile: params.farm.directoryConfigProfile }),
      ...(params.farm.globalDefaultConfigProfile === undefined ? {} : { globalDefaultConfigProfile: params.farm.globalDefaultConfigProfile }),
      loadCascade: (baseConfigProfile) => params.farm.runtime.loadCascade(baseConfigProfile, undefined),
    }),
    picker: promptsIdentityPicker(realPromptsPort),
  });
}
