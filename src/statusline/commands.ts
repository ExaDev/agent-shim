import { spawn } from "node:child_process";
import type { Command } from "commander";

import { withExamples } from "../cli/commandDeps";
import { realFarmFs } from "../realPorts";
import { readUsageSnapshot } from "../usage/read";
import { enrichStatuslinePayload, identityOf } from "./enrich";
import { renderStatuslineLine } from "./render";

/** One field a client's statusline payload may carry that the built-in line shows. */
function payloadViewOf(payload: unknown): { modelDisplayName: string | undefined; contextUsedPercentage: number | undefined } {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { modelDisplayName: undefined, contextUsedPercentage: undefined };
  }
  const record: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    record[key] = value;
  }
  const model = record.model;
  const displayName = typeof model === "object" && model !== null && !Array.isArray(model) && "display_name" in model && typeof model.display_name === "string" ? model.display_name : undefined;
  const context = record.context_window;
  const used = typeof context === "object" && context !== null && !Array.isArray(context) && "used_percentage" in context && typeof context.used_percentage === "number" ? context.used_percentage : undefined;
  return { modelDisplayName: displayName, contextUsedPercentage: used };
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
export function registerStatuslineCommand(program: Command, deps: { readonly paths: { readonly usageSnapshotsDir: string } }): void {
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
      if (identity !== undefined) {
        try {
          snapshot = readUsageSnapshot(realFarmFs, deps.paths.usageSnapshotsDir, identity);
        } catch {
          snapshot = undefined;
        }
      }
      const { payload: enriched, summary } = enrichStatuslinePayload({ payload, env: process.env, snapshot });
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
      console.log(renderStatuslineLine(summary, view, Date.now()));
      }),
    ["$ agent-shim statusline  # a client's statusline setting names this; it renders or delegates"],
  );
}
