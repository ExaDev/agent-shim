import { FileNameSchema, isFileName, isStoredName, profileFilePath, providerFilePath, requireNewProviderName, StoredNameSchema } from "../config/names";
import { optionalText, text } from "./args";
import type { CaseTable } from "../../conformance/runner/run.mjs";

/** The functions of the configuration names (what a name may hold, and the file a name stands for), by the name a `function` case gives. */
export const configTable: CaseTable = {
  isFileName: (name) => isFileName(text(name)),
  isStoredName: (name) => isStoredName(text(name)),
  "FileNameSchema.accepts": (name) => FileNameSchema.safeParse(name).success,
  "StoredNameSchema.accepts": (name) => StoredNameSchema.safeParse(name).success,
  profileFilePath: (directory, name, from) => profileFilePath(text(directory), text(name), optionalText(from)),
  providerFilePath: (directory, name, from) => providerFilePath(text(directory), text(name), optionalText(from)),
  requireNewProviderName: (name) => {
    requireNewProviderName(text(name));
  },
};
