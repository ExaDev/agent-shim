import type { RenderContext } from "../context";

/** The Claude Code release the session runs, as the client reports it, or undefined when it reports none. */
export function versionSegment({ payload }: RenderContext): string | undefined {
  return payload.version === undefined || payload.version === "" ? undefined : `CC v${payload.version}`;
}
