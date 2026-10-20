import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { Command } from "commander";

import { printJson, withExamples } from "../cli/commandDeps";
import { resolveStatusline, STATUSLINE_ENV } from "../config/statusline";
import type { LayoutPaths } from "../paths";
import { listProviders } from "../providersStore";
import { realFarmFs, realHeadroomSocketTrust } from "../realPorts";
import { readAccountMetadata, readAccountMetadataFile } from "../usage/account";
import { readUsageSnapshot } from "../usage/read";
import { headroomSocketTarget } from "../frontdoor/status";
import { antigravityStacksWithDefault, isAntigravityPayload } from "./client";
import { fetchHeadroomSessionStats, headroomSessionIdOf, headroomTargetOf, realHeadroomGet } from "./headroom";
import { enrichStatuslinePayload, identityOf } from "./enrich";
import { readUsageLog } from "../usage/read";
import { readModels } from "../modelsStore";
import { readDoorCostUsd } from "./doorCost";
import { parseClientPayload, viewOf } from "./payload";
import { realStatuslinePorts } from "./ports";
import { renderStatuslineBlock } from "./render";
import { formatStatuslineKeys, statuslineKeys } from "./keys";
import { statuslineSettingsFromEnv } from "./settings";
import { terminalWidthOf } from "./width";

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

/** How far back the statusline looks for the session's last served target: long enough that an idle session still shows its last routing, short enough that the records read stay few. */
const ROUTED_TARGET_LOOKBACK_MS = 3_600_000;

/** The command a client's statusline setting names: it reads the client's payload on stdin, adds what the door knows under one `agent_shim` key, and either hands the enriched payload to the renderer named in `AGENT_SHIM_STATUSLINE_CMD` or renders the built-in line itself. */
export function registerStatuslineCommand(program: Command, deps: { readonly paths: LayoutPaths }): void {
  const statusline = program.command("statusline");
  withExamples(
    statusline
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
      // The supervised daemon's socket is authenticated before it is dialled, exactly as the door's own hop does; a refused or absent one leaves no target.
      const socketTarget = headroomSocketTarget(realFarmFs, realHeadroomSocketTrust, deps.paths);
      const target = headroomTargetOf(process.env, socketTarget === undefined || socketTarget.refused !== undefined ? undefined : socketTarget.socketPath);
      const sessionId = headroomSessionIdOf(payload, process.env);
      const headroom = target === undefined || sessionId === undefined ? undefined : await fetchHeadroomSessionStats(realHeadroomGet, target, sessionId);
      // The target this session's last request was served by, from the usage log's recent records for its session id: what shows a routing session's virtual-model choice where the person is looking. A record only names something other than the launch's own provider when routing sent it there. A record that also names the model the session asked for was served by a choice among alternatives (a virtual model's or a tier alias's selection), which the statusline draws beside the name the session typed.
      const sessionHeader = /x-agent-shim-session:\s*([A-Za-z0-9@._-]+)/i.exec(process.env.ANTHROPIC_CUSTOM_HEADERS ?? "")?.[1];
      let routedTarget: string | undefined;
      let modelChoice: { readonly requested: string; readonly served: string; readonly provider: string; readonly providers: readonly string[] } | undefined;
      if (sessionHeader !== undefined) {
        try {
          const last = readUsageLog(realFarmFs, deps.paths.usageLogDir, { sinceMs: nowMs - ROUTED_TARGET_LOOKBACK_MS }).records.filter((record) => record.sessionId === sessionHeader).at(-1);
          if (last?.model !== undefined) {
            if (last.provider !== providerName) {
              routedTarget = `${last.provider}/${last.model}`;
            }
            if (last.requestedModel !== undefined && last.requestedModel !== last.model) {
              modelChoice = { requested: last.requestedModel, served: last.model, provider: last.provider, providers: last.candidateProviders ?? [] };
            }
          }
        } catch {
          routedTarget = undefined;
        }
      }
      const clientPayload = parseClientPayload(payload);
      const enrichParams = { payload, env: process.env, snapshot, account, providerName, nowMs, headroom, routedTarget, ...(modelChoice === undefined ? {} : { modelChoice }) };
      const renderer = process.env.AGENT_SHIM_STATUSLINE_CMD;
      if (renderer !== undefined && renderer !== "") {
        const child = spawn("/bin/sh", ["-c", renderer], { stdio: ["pipe", "inherit", "inherit"] });
        child.stdin.end(`${JSON.stringify(enrichStatuslinePayload(enrichParams).payload)}\n`);
        child.on("close", (code) => {
          process.exit(code ?? 0);
        });
        return;
      }
      const rawSettings = process.env[STATUSLINE_ENV];
      const settings = resolveStatusline(rawSettings === undefined || rawSettings === "" ? undefined : statuslineSettingsFromEnv(rawSettings, STATUSLINE_ENV));
      // What the conversation's requests cost the door is read only for a layout that draws a cost, since it reads the log from the conversation's first day on.
      const conversationId = clientPayload.session_id;
      const prices = settings.layout.header.some((name) => name === "cost" || name === "dailyCost") ? readModels(deps.paths)?.prices : undefined;
      const doorCostUsd = prices === undefined || conversationId === undefined ? undefined : readDoorCostUsd({ fs: realFarmFs, logDir: deps.paths.usageLogDir, prices, conversationId, nowMs, sessionDurationMs: clientPayload.cost?.total_duration_ms });
      const { summary } = enrichStatuslinePayload({ ...enrichParams, ...(doorCostUsd === undefined ? {} : { doorCostUsd }) });
      // Stacked beneath the Antigravity CLI's own line, which already names the model, the model would repeat it; replacing that line, this one is the only place it appears.
      let stackedUnderDefault = false;
      if (isAntigravityPayload(payload)) {
        try {
          stackedUnderDefault = antigravityStacksWithDefault(realFarmFs, os.homedir());
        } catch {
          stackedUnderDefault = false;
        }
      }
      const view = { ...viewOf(clientPayload), ...(stackedUnderDefault ? { modelDisplayName: undefined } : {}) };
      console.log(renderStatuslineBlock({ summary, view, payload: clientPayload, terminalWidth: terminalWidthOf(payload, process.env), nowMs, settings, ports: realStatuslinePorts(process.env, deps.paths.statuslineDir) }));
      }),
    ["$ agent-shim statusline  # a client's statusline setting names this; it renders or delegates"],
  );
  registerStatuslineKeys(statusline);
}

/** `agent-shim statusline keys`: every setting of the built-in statusline, from the schema the configuration files are checked against. Created from its parent so it shares the program's output and exit handling. */
function registerStatuslineKeys(statusline: Command): void {
  withExamples(
    statusline.command("keys").description("List every setting of the built-in statusline with its kind, its default (if it has one) and what it does.").option("--json", "Print the settings as JSON."),
    ["agent-shim statusline keys", "agent-shim statusline keys --json"],
  ).action((options: { readonly json?: boolean }) => {
    if (options.json === true) {
      printJson(statuslineKeys());
      return;
    }
    console.log(formatStatuslineKeys(statuslineKeys()));
  });
}
