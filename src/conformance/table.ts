import type { CaseTable } from "../../conformance/runner/run.mjs";
import { configTable } from "./config";
import { rootTable } from "./root";

/** The area tables, one module per area of the source, so an extraction adds its functions in its own module and one line here. */
const AREAS: readonly (readonly [string, CaseTable])[] = [
  ["root", rootTable],
  ["config", configTable],
];

/**
 * Every function a `function` case can name, from all the areas. A name two areas both define is refused at load, since a case would then run whichever came last.
 */
function merged(areas: readonly (readonly [string, CaseTable])[]): CaseTable {
  const owners = new Map<string, string>();
  const table: Record<string, CaseTable[string]> = {};
  for (const [area, functions] of areas) {
    for (const [name, fn] of Object.entries(functions)) {
      const owner = owners.get(name);
      if (owner !== undefined) {
        throw new Error(`the function ${name} is defined by both ${owner} and ${area}`);
      }
      owners.set(name, area);
      table[name] = fn;
    }
  }
  return table;
}

export const TABLE: CaseTable = merged(AREAS);

export { merged as mergeAreaTables };
