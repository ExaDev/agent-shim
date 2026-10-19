import { addedDirNames, formatProjectPath, workingDirectoryOf } from "../../projectPath";
import type { RenderContext } from "../context";

/** The directories added to the session as `+name` each, the form the project segment carries them in. */
function inlineAddedDirs({ payload, palette }: RenderContext): string | undefined {
  const { names, more } = addedDirNames(payload.workspace?.added_dirs);
  const drawn = [...names.map((name) => `+${name}`), ...(more > 0 ? [`+${String(more)} more`] : [])];
  return drawn.length === 0 ? undefined : drawn.map((text) => palette.paint("label", text)).join(" ");
}

/**
 * The project the session is in: the working directory's last levels (`project.pathLevels`), then the directories added to the session when `project.addedDirsLayout` is `inline`. Undefined when the client names no directory and no directory was added. The path draws in the colour the registry paints the segment in, and the added directories in their own.
 */
export function projectSegment(context: RenderContext): string | undefined {
  const { payload, settings } = context;
  const cwd = workingDirectoryOf(payload);
  const parts = [cwd === undefined ? undefined : formatProjectPath(cwd, settings.project.pathLevels), settings.project.addedDirsLayout === "inline" ? inlineAddedDirs(context) : undefined].filter((part) => part !== undefined);
  return parts.length === 0 ? undefined : parts.join(" ");
}
