import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * agent-shim sends a model request itself in two places, each behind something the person configured, and queries quota in one place that sends none. Any other file that loads the Agent SDK is a new way to spend tokens or start a window, and has to be added here deliberately, with the configuration that justifies it.
 */
const SDK_SITES: Readonly<Record<string, string>> = {
  "usage/realWindowOpener.ts": "sends one real request: only for an identity with an anchor",
  "usage/realJobRunner.ts": "sends the job's prompt: only for a job the person added",
  "usage/realAnthropicUsageProbe.ts": "calls the SDK's usage control request and sends no model request",
};

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(full);
    }
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".d.ts") ? [full] : [];
  });
}

describe("where agent-shim can spend tokens or start a window", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const loaders = sourceFiles(root).filter((file) => /import\(\s*["']@anthropic-ai\/claude-agent-sdk["']\s*\)/.test(fs.readFileSync(file, "utf8")));

  it("loads the Agent SDK to run a request only from the sites that are configured to", () => {
    expect(loaders.map((file) => path.relative(root, file)).sort()).toEqual(Object.keys(SDK_SITES).sort());
  });

  it("never builds a messages request of its own outside the routes the door serves", () => {
    const builders = sourceFiles(root)
      .filter((file) => !file.includes(`${path.sep}frontdoor${path.sep}`) && !file.includes(`${path.sep}codex${path.sep}`))
      .filter((file) => /fetch\([^)]*\/v1\/messages/.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.relative(root, file));
    expect(builders).toEqual([]);
  });
});
