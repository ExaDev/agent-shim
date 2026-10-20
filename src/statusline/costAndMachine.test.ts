import { describe, expect, it } from "vitest";

import { resolveStatusline, type StatuslineSettings } from "../config/statusline";
import { DAILY_LEDGER_DIRECTORY } from "./dailyLedger";
import type { StatuslineSummary } from "./enrich";
import { parseClientPayload, viewOf } from "./payload";
import { renderStatuslineBlock } from "./render";
import { fakeStatuslineFilesystem, fakeStatuslinePorts, fakeStatuslineSummary, type FakeStatuslineFilesystem } from "./testing";

const WIDE_TERMINAL = 120;
const YEAR = 2026;
const OCTOBER = 9;
const DAY = 19;
const MIDDAY_HOUR = 12;
const NOON = new Date(YEAR, OCTOBER, DAY, MIDDAY_HOUR, 0, 0).getTime();
const KIBIBYTE = 1024;
const GIBIBYTE = KIBIBYTE * KIBIBYTE * KIBIBYTE;
const EIGHT_GIB = 8;
const SIXTEEN_GIB = 16;
const FIRST_FIGURE = 2;
const SECOND_FIGURE = 5.5;
const STATE = "/state/test";

interface Scene {
  readonly settings?: StatuslineSettings;
  readonly payload?: unknown;
  readonly summary?: StatuslineSummary;
  /** The files of the machine, as paths to text. */
  readonly files?: Readonly<Record<string, string>>;
  /** A filesystem to share between several draws, in place of `files`. */
  readonly filesystem?: FakeStatuslineFilesystem;
  readonly memory?: { readonly usedBytes: number; readonly totalBytes: number };
  readonly env?: Record<string, string>;
}

/** The statusline for a scene, drawn in plain text with the ports a scene describes. */
function draw(scene: Scene): string {
  const payload = parseClientPayload(scene.payload ?? {});
  return renderStatuslineBlock({
    summary: scene.summary ?? fakeStatuslineSummary(),
    view: viewOf(payload),
    payload,
    terminalWidth: WIDE_TERMINAL,
    nowMs: NOON,
    settings: resolveStatusline(scene.settings),
    ports: fakeStatuslinePorts({ ...(scene.filesystem ?? fakeStatuslineFilesystem(scene.files ?? {})).ports, stateDirectory: STATE, homeDirectory: "/home/test", env: { NO_COLOR: "1", ...scene.env }, memoryUse: () => scene.memory }),
  });
}

const COST_ONLY: StatuslineSettings = { layout: { header: ["cost"], rows: [] } };

describe("the cost segment", () => {
  it("is not drawn unless the layout names it", () => {
    expect(draw({ payload: { cost: { total_cost_usd: 1.5 } } })).not.toContain("$");
  });

  it("draws the client's own figure as Cost", () => {
    expect(draw({ settings: COST_ONLY, payload: { cost: { total_cost_usd: 1.5 } } })).toBe("Cost $1.50");
  });

  it("draws the door's priced figure as Est. when the client reports none", () => {
    expect(draw({ settings: COST_ONLY, summary: fakeStatuslineSummary({ doorCostUsd: 0.25 }) })).toBe("Est. $0.250");
  });

  it("draws nothing when there is no figure to state", () => {
    expect(draw({ settings: COST_ONLY })).toBe("");
  });

  it("hides a routed session's cost until cost.routed is set, then draws the door's figure", () => {
    const scene = { payload: { cost: { total_cost_usd: 0 } }, summary: fakeStatuslineSummary({ provider: "z.ai", doorCostUsd: 0.042 }) };
    expect(draw({ ...scene, settings: COST_ONLY })).toBe("");
    expect(draw({ ...scene, settings: { ...COST_ONLY, cost: { routed: true } } })).toBe("Est. $0.0420");
  });
});

describe("the daily cost segment", () => {
  const DAILY_ONLY: StatuslineSettings = { layout: { header: ["dailyCost"], rows: [] } };

  it("draws today's spend since the session was first seen, and records it for the other sessions", () => {
    const filesystem = fakeStatuslineFilesystem({});
    expect(draw({ settings: DAILY_ONLY, filesystem, payload: { session_id: "s1", cost: { total_cost_usd: FIRST_FIGURE } } })).toBe("Today $0.0000");
    expect(draw({ settings: DAILY_ONLY, filesystem, payload: { session_id: "s1", cost: { total_cost_usd: SECOND_FIGURE } } })).toBe("Today $3.50");
    expect(draw({ settings: DAILY_ONLY, filesystem, payload: { session_id: "s2", cost: { total_cost_usd: 1 } } })).toBe("Today $3.50");
    expect([...filesystem.files.keys()].sort()).toEqual([`${STATE}/${DAILY_LEDGER_DIRECTORY}/2026-10-19/s1.json`, `${STATE}/${DAILY_LEDGER_DIRECTORY}/2026-10-19/s2.json`]);
  });

  it("is independent of the cost segment, and draws nothing before any session has a figure", () => {
    expect(draw({ settings: DAILY_ONLY })).toBe("");
    expect(draw({ settings: { layout: { header: ["cost", "dailyCost"], rows: [] } }, payload: { session_id: "s", cost: { total_cost_usd: 1 } } })).toMatch(/^Cost \$1\.00 +\| +Today \$0\.0000$/);
  });
});

describe("the memory row", () => {
  const MEMORY_ONLY: StatuslineSettings = { layout: { header: [], rows: ["memory"] } };

  it("is not drawn unless the layout names it", () => {
    expect(draw({ memory: { usedBytes: GIBIBYTE, totalBytes: 2 * GIBIBYTE } })).not.toContain("RAM");
  });

  it("draws the memory in use as a bar with its figures", () => {
    const line = draw({ settings: MEMORY_ONLY, memory: { usedBytes: EIGHT_GIB * GIBIBYTE, totalBytes: SIXTEEN_GIB * GIBIBYTE } });
    expect(line).toContain("RAM ");
    expect(line).toContain("50.0% (8.0 GB / 16 GB)");
    expect(line).toContain("█");
  });

  it("draws nothing when the platform gives no figure", () => {
    expect(draw({ settings: MEMORY_ONLY })).toBe("");
  });

  it("colours the figure by the bands the quota bars use", () => {
    const coloured = renderStatuslineBlock({
      summary: fakeStatuslineSummary(),
      view: viewOf(parseClientPayload({})),
      payload: parseClientPayload({}),
      terminalWidth: WIDE_TERMINAL,
      nowMs: NOON,
      settings: resolveStatusline(MEMORY_ONLY),
      ports: fakeStatuslinePorts({ memoryUse: () => ({ usedBytes: 95, totalBytes: 100 }) }),
    });
    expect(coloured).toContain("\u001b[31m95.0%");
  });
});

describe("the environment row", () => {
  const ENVIRONMENT_ONLY: StatuslineSettings = { layout: { header: [], rows: ["environment"] } };
  const FILES = {
    "/home/test/.claude/CLAUDE.md": "",
    "/home/test/.claude/rules/a.md": "",
    "/work/CLAUDE.md": "",
    "/work/.mcp.json": JSON.stringify({ mcpServers: { one: {} } }),
  };

  it("is not drawn unless the layout names it", () => {
    expect(draw({ files: FILES, payload: { cwd: "/work" } })).not.toContain("CLAUDE.md");
  });

  it("draws the counts of the session's configuration, each left out at zero and pluralised", () => {
    expect(draw({ settings: ENVIRONMENT_ONLY, files: FILES, payload: { cwd: "/work" } })).toBe("2 CLAUDE.md | 1 rule | 1 MCP");
    expect(draw({ settings: ENVIRONMENT_ONLY, files: { ...FILES, "/home/test/.claude/rules/b.md": "" }, payload: { cwd: "/work" } })).toContain("2 rules");
  });

  it("takes the project from the workspace when the client sends no cwd", () => {
    expect(draw({ settings: ENVIRONMENT_ONLY, files: FILES, payload: { workspace: { current_dir: "/work" } } })).toContain("1 MCP");
  });

  it("draws only when the total reaches environment.threshold, and never when there is nothing to count", () => {
    const total = 4;
    expect(draw({ settings: { ...ENVIRONMENT_ONLY, environment: { threshold: total } }, files: FILES, payload: { cwd: "/work" } })).not.toBe("");
    expect(draw({ settings: { ...ENVIRONMENT_ONLY, environment: { threshold: total + 1 } }, files: FILES, payload: { cwd: "/work" } })).toBe("");
    expect(draw({ settings: ENVIRONMENT_ONLY, payload: { cwd: "/work" } })).toBe("");
  });
});
