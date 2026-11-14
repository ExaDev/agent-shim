/**
 * Whether `file`, a path under `src`, is one of its source modules: a `.ts` file but a test (`*.test.ts`), a test world (`*TestWorld.ts`) or a declaration file (`*.d.ts`). `fileFaults.repo.test.ts`, `keepTicking.repo.test.ts` and `logFile.repo.test.ts` each list `src` themselves and filter the listing with this.
 */
export function isSourceModule(file: string): boolean {
  return file.endsWith(".ts") && !file.endsWith(".test.ts") && !file.endsWith("TestWorld.ts") && !file.endsWith(".d.ts");
}
