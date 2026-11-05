import type { FarmRuntime } from "./launcher";
import { recoverFarmWarning } from "./launcher/farm";
import { loadIdentity, resolveIdentityId } from "./launcher/identity";
import type { FsPort } from "./launcher/ports";

/** What `readyTerminalIdentity` reads the identity through, recovers its farm with and asks the person with. */
export interface TerminalIdentityParams {
  readonly identitiesDir: string;
  /** The identity name the launch selected. */
  readonly name: string;
  readonly fs: FsPort;
  readonly farm: Pick<FarmRuntime, "fs" | "now" | "lock" | "classification">;
  /** Receives each line the farm recovery reports, as a launch prints it. */
  readonly warn: (line: string) => void;
  /** Offers the add wizard for a name no identity claims; resolves false when the person declines it. */
  readonly runWizard: (name: string) => Promise<boolean>;
}

/**
 * Makes the identity named `name` ready for a launch from a terminal, before the launch reads it. An identity whose `identity.json` reads is ready as it is. A displaced one, whose record is found by its name but whose `identity.json` is not in its directory (an interrupted resync left it in a superseded farm, with the directory either gone or present without the file), is put back by the farm recovery a launch runs, so the launch goes ahead as it does with no terminal. Under the `CLAUDE_CONFIG_DIR` escape hatch no identity is selected, so this is never asked. Only a name no identity claims is offered to the add wizard.
 *
 * Resolves false when the wizard is declined, and true otherwise. Throws `UnsafeNameError` for a name that is not a safe file name, and what the recovery throws (`IdentityLockBusyError` while another launch holds the identity's resync lock).
 */
export async function readyTerminalIdentity(params: TerminalIdentityParams): Promise<boolean> {
  if (loadIdentity(params.identitiesDir, params.name, params.fs) !== undefined) {
    return true;
  }
  const id = resolveIdentityId(params.identitiesDir, params.name, params.fs);
  if (id === undefined) {
    return params.runWizard(params.name);
  }
  recoverFarmWarning(
    { fs: params.farm.fs, identitiesDir: params.identitiesDir, identity: id, now: params.farm.now, lock: params.farm.lock, classification: params.farm.classification },
    params.warn,
  );
  return true;
}
