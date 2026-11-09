import fs from "node:fs";
import path from "node:path";

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

/** The longest the repo's type-aware lint takes to load its configuration and parse a snippet, which waits on the type information of the project, not on a clock. */
const LINT_TEST_BUDGET_MS = 120_000;

const VARIANTS: Readonly<Record<string, string>> = {
  "a fallback built inline": "export const f = (x: AbortSignal | undefined) => x ?? new AbortController().signal;",
  "a controller made in parentheses": "export const f = (x: AbortSignal | undefined) => (x ?? new AbortController()).signal;",
  "a controller built ahead of the expression": "const c = new AbortController();\nexport const f = (x: AbortSignal | undefined) => x ?? c.signal;",
  "a logical or": "export const f = (x: AbortSignal | undefined) => x || new AbortController().signal;",
  "a ternary with the controller inline": "export const f = (x: AbortSignal | undefined) => (x === undefined ? new AbortController().signal : x);",
  "a ternary with the controller built ahead": "const c = new AbortController();\nexport const f = (x: AbortSignal | undefined) => (x === undefined ? c.signal : x);",
};

describe("the rule that keeps an absent abort signal absent", () => {
  it(
    "refuses every way of substituting a signal nothing can abort, and allows a controller used for what it is for",
    async () => {
      const eslint = new ESLint({ cwd: path.resolve(__dirname, "..") });
      // The type-aware lint reads a file of the project, so each snippet is written to a probe file beside the sources and removed again.
      const filePath = path.resolve(__dirname, "zzAbsentSignalProbe.ts");
      const messagesFor = async (text: string): Promise<readonly string[]> => {
        fs.writeFileSync(filePath, text);
        const [result] = await eslint.lintFiles([filePath]);
        return (result?.messages ?? []).filter((message) => message.ruleId === "no-restricted-syntax").map((message) => message.message);
      };
      try {
        for (const [name, text] of Object.entries(VARIANTS)) {
          expect(await messagesFor(text), name).not.toEqual([]);
        }
        expect(await messagesFor("export const f = () => { const c = new AbortController(); return c.signal; };")).toEqual([]);
      } finally {
        fs.rmSync(filePath, { force: true });
      }
    },
    LINT_TEST_BUDGET_MS,
  );
});
