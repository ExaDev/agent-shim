import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { Command } from "commander";

import { withExamples } from "../cli/commandDeps";
import type { LayoutPaths } from "../paths";
import { listProviders } from "../providersStore";
import { realFarmFs } from "../realPorts";
import { readAccountMetadata, readAccountMetadataFile } from "../usage/account";
import { readUsageSnapshot } from "../usage/read";
import { enrichStatuslinePayload, identityOf } from "./enrich";
import { renderStatuslineBlock } from "./render";
import { terminalWidthOf } from "./width";

/** The payload fields the built-in statusline shows, in the Antigravity statusline's own selection: the model, the context window's use, its size, and the prompt cache's effectiveness. */
function payloadViewOf(payload: unknown): { modelDisplayName: string | undefined; contextUsedPercentage: number | undefined; contextTotalTokens: number | undefined; contextWindowTokens: number | undefined; cacheHitRatio: number | undefined; cacheReadTokens: number | undefined; freshInputTokens: number | undefined } {
  const empty = { modelDisplayName: undefined, contextUsedPercentage: undefined, contextTotalTokens: undefined, contextWindowTokens: undefined, cacheHitRatio: undefined, cacheReadTokens: undefined, freshInputTokens: undefined };
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return empty;
  }
  const record: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    record[key] = value;
  }
  const model = record.model;
  const displayName = typeof model === "object" && model !== null && !Array.isArray(model) && "display_name" in model && typeof model.display_name === "string" ? model.display_name : undefined;
  const context = record.context_window;
  const ctx = typeof context === "object" && context !== null && !Array.isArray(context) ? context : undefined;
  const used = ctx !== undefined && "used_percentage" in ctx && typeof ctx.used_percentage === "number" ? ctx.used_percentage : undefined;
  const totalIn = ctx !== undefined && "total_input_tokens" in ctx && typeof ctx.total_input_tokens === "number" ? ctx.total_input_tokens : undefined;
  const size = ctx !== undefined && "context_window_size" in ctx && typeof ctx.context_window_size === "number" ? ctx.context_window_size : undefined;
  const current = ctx !== undefined && "current_usage" in ctx && typeof ctx.current_usage === "object" && ctx.current_usage !== null && !Array.isArray(ctx.current_usage) ? ctx.current_usage : undefined;
  const cacheRead = current !== undefined && "cache_read_input_tokens" in current && typeof current.cache_read_input_tokens === "number" ? current.cache_read_input_tokens : undefined;
  const fresh = current !== undefined && "input_tokens" in current && typeof current.input_tokens === "number" ? current.input_tokens : undefined;
  const promptCache = record.prompt_cache;
  const cache = typeof promptCache === "object" && promptCache !== null && !Array.isArray(promptCache) ? promptCache : undefined;
  const hitRatio = cache !== undefined && "hit_ratio" in cache && typeof cache.hit_ratio === "number" ? cache.hit_ratio : undefined;
  return { modelDisplayName: displayName, contextUsedPercentage: used, contextTotalTokens: totalIn, contextWindowTokens: size, cacheHitRatio: hitRatio, cacheReadTokens: cacheRead, freshInputTokens: fresh };
}

async function readAllStdin(): Promise<string> {
  return await new Promise((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    process.stdin.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    process.stdin.resume();
  });
}

/** The command a client's statusline setting names: it reads the client's payload on stdin, adds what the door knows under one `agent_shim` key, and either hands the enriched payload to the renderer named in `AGENT_SHIM_STATUSLINE_CMD` or renders the built-in line itself. */
export function registerStatuslineCommand(program: Command, deps: { readonly paths: LayoutPaths }): void {
  withExamples(
    program
      .command("statusline")
      .description("Serve as a statusline entrypoint: read the client's stdin payload, add the identity's live provider, account and usage windows under an agent_shim key, then run the renderer named in AGENT_SHIM_STATUSLINE_CMD or print the built-in line.")
      .action(async () => {
      const stdin = await readAllStdin();
      let payload: unknown;
      try {
        payload = JSON.parse(stdin);
      } catch {
        payload = undefined;
      }
      const identity = identityOf(process.env);
      let snapshot;
      let account;
      if (identity !== undefined) {
        try {
          snapshot = readUsageSnapshot(realFarmFs, deps.paths.usageSnapshotsDir, identity);
        } catch {
          snapshot = undefined;
        }
        try {
          account = readAccountMetadata(realFarmFs, deps.paths.identitiesDir, identity);
        } catch {
          account = undefined;
        }
      } else {
        // A session outside agent-shim keeps its profile where Claude Code does: in the pinned configuration directory, else the home directory's `.claude.json`.
        const configDir = process.env.CLAUDE_CONFIG_DIR;
        try {
          account = readAccountMetadataFile(realFarmFs, configDir === undefined || configDir === "" ? path.join(os.homedir(), ".claude.json") : path.join(configDir, ".claude.json"));
        } catch {
          account = undefined;
        }
      }
      // The launch environment names the provider by display name, while the usage snapshot keys it by registered name.
      const displayName = process.env.AGENT_SHIM_PROVIDER;
      let providerName;
      if (displayName !== undefined && displayName !== "") {
        try {
          providerName = listProviders(deps.paths).find((entry) => entry.provider.displayName === displayName)?.name;
        } catch {
          providerName = undefined;
        }
      }
      const nowMs = Date.now();
      const { payload: enriched, summary } = enrichStatuslinePayload({ payload, env: process.env, snapshot, account, providerName, nowMs });
      const renderer = process.env.AGENT_SHIM_STATUSLINE_CMD;
      if (renderer !== undefined && renderer !== "") {
        const child = spawn("/bin/sh", ["-c", renderer], { stdio: ["pipe", "inherit", "inherit"] });
        child.stdin.end(`${JSON.stringify(enriched)}\n`);
        child.on("close", (code) => {
          process.exit(code ?? 0);
        });
        return;
      }
      const view = payloadViewOf(payload);
      console.log(renderStatuslineBlock(summary, view, terminalWidthOf(payload, process.env), nowMs));
      }),
    ["$ agent-shim statusline  # a client's statusline setting names this; it renders or delegates"],
  );
}
