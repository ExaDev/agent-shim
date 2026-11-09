import fs from "node:fs";
import path from "node:path";

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

/** The longest the repo's type-aware lint takes to load its configuration and parse a snippet, which waits on the type information of the project, not on a clock. */
const LINT_TEST_BUDGET_MS = 120_000;

const URL_READS: Readonly<Record<string, string>> = {
  "a dotted hostname": "export const f = (u: URL) => u.hostname;",
  "a dotted host": "export const f = (u: URL) => u.host;",
  "a hostname read off a fresh URL": "export const f = (x: string) => new URL(x).hostname;",
  "a host read off a fresh URL": "export const f = (x: string) => new URL(x).host;",
  "a bracketed string key": 'export const f = (x: string) => new URL(x)["hostname"];',
  "a single-quoted bracketed key": "export const f = (x: string) => new URL(x)['host'];",
  "a template key": "export const f = (u: URL) => u[`hostname`];",
  "an optional chain": "export const f = (u: URL | undefined) => u?.hostname;",
  "a destructured hostname": "export const f = (u: URL) => { const { hostname } = u; return hostname; };",
  "a destructured host from a fresh URL": "export const f = (x: string) => { const { host } = new URL(x); return host; };",
  "a renamed destructured host": "export const f = (u: URL) => { const { host: h } = u; return h; };",
  "a destructured parameter": "export const f = ({ hostname }: URL) => hostname;",
  "a destructuring assignment": "export const f = (u: URL) => { let h = ''; ({ hostname: h } = u); return h; };",
  "a host in a template string": "export const f = (u: URL) => `${u.protocol}//${u.host}`;",
  "a host handed to a connect call": "import net from 'node:net';\nexport const f = (u: URL) => net.connect({ host: u.host, port: 1 });",
  "a hostname of a picked URL": "export const f = (u: Pick<URL, 'hostname'>) => u.hostname;",
};

const COLON_CUTS: Readonly<Record<string, string>> = {
  "a split at a colon": 'export const f = (x: string) => x.split(":")[0];',
  "a single-quoted split": "export const f = (x: string) => x.split(':')[0];",
  "a last index of a colon": 'export const f = (x: string) => x.lastIndexOf(":");',
  "a single-quoted last index": "export const f = (x: string) => x.lastIndexOf(':');",
  "an index of a colon": 'export const f = (x: string) => x.indexOf(":");',
  "a template-quoted index": "export const f = (x: string) => x.indexOf(`:`);",
  "a bracketed method": 'export const f = (x: string) => x["indexOf"](":");',
};

const CLEAN: Readonly<Record<string, string>> = {
  "a host field of something that is not a URL": "export const f = (t: { host: string }) => t.host;",
  "a URL's protocol and pathname": "export const f = (u: URL) => `${u.protocol}${u.pathname}`;",
  "the shared host rule": "import { dialHostOf } from '../baseUrlDial';\nexport const f = (u: URL) => dialHostOf(u);",
  "a search for a colon that is not a cut": 'export const f = (x: string) => x.includes(":");',
  "a split at something else": 'export const f = (x: string) => x.split(",");',
};

describe("the rules that keep every dial target on the one host rule", () => {
  /** Lints `text` as a source file at `relativePath` under `src` and returns the messages of the dial rules, the probe file removed again. */
  async function dialMessages(relativePath: string, text: string): Promise<readonly string[]> {
    const eslint = new ESLint({ cwd: path.resolve(__dirname, "..") });
    // The type-aware lint reads a file of the project, so each snippet is written to a probe file beside the sources and removed again.
    const filePath = path.resolve(__dirname, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, text);
    try {
      const [result] = await eslint.lintFiles([filePath]);
      return (result?.messages ?? []).filter((message) => message.ruleId?.startsWith("dial/") === true).map((message) => `${message.ruleId ?? ""}: ${message.message}`);
    } finally {
      fs.rmSync(filePath, { force: true });
    }
  }

  it(
    "refuses every way of reading a URL's host or hostname",
    async () => {
      for (const [name, text] of Object.entries(URL_READS)) {
        const messages = await dialMessages("zzDialReadProbe.ts", text);
        expect(messages.map((message) => message.split(":")[0]), name).toContain("dial/no-url-host-read");
      }
    },
    LINT_TEST_BUDGET_MS,
  );

  it(
    "refuses every way of cutting a string at a colon in the code that dials",
    async () => {
      for (const [name, text] of Object.entries(COLON_CUTS)) {
        const messages = await dialMessages("frontdoor/zzDialColonProbe.ts", text);
        expect(messages.map((message) => message.split(":")[0]), name).toContain("dial/no-colon-split");
      }
    },
    LINT_TEST_BUDGET_MS,
  );

  it(
    "allows what is not a dial target",
    async () => {
      for (const [name, text] of Object.entries(CLEAN)) {
        expect(await dialMessages("frontdoor/zzDialCleanProbe.ts", text), name).toEqual([]);
      }
    },
    LINT_TEST_BUDGET_MS,
  );
});
