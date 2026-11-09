import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = import.meta.dirname;

/** Every non-test TypeScript source file under `src`, as a path relative to it. */
function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(full);
    }
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path.relative(SRC, full)] : [];
  });
}

/**
 * The files that read a URL's `.hostname` without dialling it: `baseUrlDial.ts` defines the one rule, the others only compare the host with a known one or test that it is set. A dial target built from `url.hostname` keeps an IPv6 literal's brackets, which `net.isIP` takes for a name, so every other file reaches a host through `dialHostOf` or `parseDialAuthority`.
 */
const HOSTNAME_READERS = new Set(["baseUrlDial.ts", "headroom/state.ts", "usage/providerQuota.ts"]);

describe("dial targets are built through the one host rule", () => {
  const files = sourceFiles(SRC).map((file) => ({ file, text: fs.readFileSync(path.join(SRC, file), "utf8") }));

  it("reads a URL's hostname only where the host is not dialled", () => {
    const offenders = files.filter(({ file, text }) => /\.hostname\b/.test(text) && !HOSTNAME_READERS.has(file)).map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it("splits an authority at its last colon only in the shared parser, which understands brackets", () => {
    const offenders = files.filter(({ file, text }) => text.includes('lastIndexOf(":")') && file !== "baseUrlDial.ts").map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it("holds the readers that are exempt to files that really read a hostname", () => {
    for (const file of HOSTNAME_READERS) {
      expect(files.find((entry) => entry.file === file)?.text, file).toMatch(/\.hostname\b/);
    }
  });
});
