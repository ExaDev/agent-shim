import { FILE_NAME_RULE, isFileName, isStoredName } from "./config/names";
import type { DoctorSection, DoctorSeverity } from "./doctorReport";

/** Reports a stored file whose name the shape new names are given refuses. The file keeps working from the person's own configuration, which may name any name that stays inside its directory, but a project file cannot name it and a new one could not be given the name; a name that cannot even stay inside its directory (a file called only `.json`) cannot be used at all. Returns whether the name is usable, so the caller can skip checking a file it has just said it cannot use. */
export function pushNameFinding(push: (section: DoctorSection, severity: DoctorSeverity, message: string, subject?: string) => void, section: DoctorSection, kind: string, entry: { readonly name: string; readonly path: string }): boolean {
  if (isFileName(entry.name)) {
    return true;
  }
  if (!isStoredName(entry.name)) {
    push(section, "fail", `${entry.path} cannot be used as a ${kind}: its name is ${JSON.stringify(entry.name)}, and a name ${FILE_NAME_RULE}. Rename or remove the file.`, entry.name);
    return false;
  }
  push(
    section,
    "warn",
    `The ${kind} ${JSON.stringify(entry.name)} is stored under a name that does not fit the shape names are given now (a name ${FILE_NAME_RULE}). It still works from your own configuration, but a project file cannot name it. Rename ${entry.path} to a name that fits, and change what names it.`,
    entry.name,
  );
  return true;
}
