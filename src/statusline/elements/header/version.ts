import { boundedDisplayText } from "../../sanitise";
import type { RenderContext } from "../context";

/** The Claude Code release the session runs, as the client reports it (cleaned like any text from outside the statusline), or undefined when it reports none. */
export function versionSegment({ payload, t }: RenderContext): string | undefined {
  const version = boundedDisplayText(payload.version ?? "");
  return version === "" ? undefined : t("version.label", { version });
}
