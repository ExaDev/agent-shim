import type { Provider } from "../config/schema";
import { hashAllowlist, headroomAllowlist, headroomUpstreams } from "./state";

/** One input the headroom allowlist is computed from: the provider definitions on disk, or the front door's direct origin. */
export type AllowlistDriftInput = "provider-files" | "front-door-origin";

/**
 * Which inputs could explain a running daemon's recorded allowlist hash no longer matching the allowlist computed now, or undefined when it matches (or no hash was recorded).
 *
 * Only a hash is recorded, so the answer is a set of candidates rather than a certainty. The door's origin is the sole cause when the recorded hash equals the allowlist computed from the current providers without any door origin: the daemon was started before the door had served. Otherwise both inputs remain candidates, because the origin the daemon was started with cannot be recovered from its hash. The door's origin is an input only while a provider routes through the door (see `headroomUpstreams`).
 */
export function diagnoseAllowlistDrift(params: {
  readonly recordedHash: string | undefined;
  readonly providers: readonly Provider[];
  readonly frontDoorOrigin: string | undefined;
}): readonly AllowlistDriftInput[] | undefined {
  const { recordedHash, providers, frontDoorOrigin } = params;
  if (recordedHash === undefined || recordedHash === hashAllowlist(headroomAllowlist(headroomUpstreams(providers, frontDoorOrigin)))) {
    return undefined;
  }
  const originIsInput = providers.length > 0 && frontDoorOrigin !== undefined;
  if (!originIsInput) {
    return ["provider-files"];
  }
  return recordedHash === hashAllowlist(headroomAllowlist(headroomUpstreams(providers, undefined))) ? ["front-door-origin"] : ["provider-files", "front-door-origin"];
}
