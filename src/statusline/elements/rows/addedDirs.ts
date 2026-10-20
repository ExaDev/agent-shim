import { writeAround } from "../../messages/around";
import { addedDirNames } from "../../projectPath";
import type { RenderContext, RowOutput } from "../context";

/** The directories added to the session on a line of their own, when `project.addedDirsLayout` is `row`; the project segment carries them otherwise. */
export function addedDirsRow({ payload, settings, palette, t }: RenderContext): RowOutput {
  const { names, more } = addedDirNames(payload.workspace?.added_dirs);
  if (settings.project.addedDirsLayout !== "row" || names.length === 0) {
    return { kind: "text", lines: [] };
  }
  const label = (text: string): string => palette.paint("label", text);
  const drawn = [...names, ...(more > 0 ? [t("more", { count: more })] : [])].map(label);
  return { kind: "text", lines: [writeAround(t, "addedDirs.label", drawn.join(label(t("list.separator"))), label)] };
}
