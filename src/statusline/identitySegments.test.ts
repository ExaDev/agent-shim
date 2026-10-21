import { describe, expect, it } from "vitest";

import { resolveStatusline, STATUSLINE_DEFAULTS, type StatuslineSettings } from "../config/statusline";
import { ESCAPE } from "./ansi";
import type { StatuslineSummary } from "./enrich";
import { parseClientPayload } from "./payload";
import type { StatuslinePorts } from "./ports";
import { renderStatuslineBlock } from "./render";
import { fakeRangeReader, fakeStatuslinePorts, newReadLog, type ReadLog } from "./testing";

const WIDE_TERMINAL = 400;
const NOW_MS = Date.parse("2026-10-19T00:00:00.000Z");
const SHORT_USER_LENGTH = 5;
const TRANSCRIPT = "/sessions/s1.jsonl";

const SUMMARY: StatuslineSummary = {
  identity: undefined,
  provider: undefined,
  providerAccountEmail: undefined,
  providerAccountSub: undefined,
  providerPlan: undefined,
  loginAccountEmail: "ada.lovelace@example.com",
  loginRateLimitTier: "default_claude_max_20x",
  loginOrganizationName: undefined,
  loginOrganizationType: "claude_max",
  loginSeatTier: undefined,
  loginPlan: undefined,
  providerQuotaWindows: [],
  quotaFamilies: [],
  headroom: undefined,
  fiveHourUsed: undefined,
  fiveHourResetAt: undefined,
  sevenDayUsed: undefined,
  sevenDayResetAt: undefined,
};

const VIEW = {
  modelDisplayName: "Claude Opus 4.7 (1M context)",
  contextUsedPercentage: undefined,
  contextTotalTokens: undefined,
  contextWindowTokens: undefined,
  cacheHitRatio: undefined,
  cacheReadTokens: undefined,
  freshInputTokens: undefined,
};

function record(fields: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(fields);
}

function assistant(model: string, advisorModel?: string): string {
  return record({ type: "assistant", message: { model }, ...(advisorModel === undefined ? {} : { advisorModel }) });
}

/** Ports whose only file is the transcript the payload names, holding `text`; each read is recorded in `log`. */
function transcriptOf(text: string, log: ReadLog = newReadLog()): Partial<StatuslinePorts> {
  return { readRange: fakeRangeReader({ [TRANSCRIPT]: text }, log) };
}

/** The header's segments, in order, drawn from the payload, summary, ports and settings given, with the first line's justification and colour removed. The payload names the transcript unless a test says otherwise, so the ports decide whether there is anything to read. */
function segments(options: { readonly settings?: StatuslineSettings; readonly payload?: Readonly<Record<string, unknown>>; readonly summary?: Partial<StatuslineSummary>; readonly view?: Partial<typeof VIEW>; readonly ports?: Partial<StatuslinePorts> } = {}): string[] {
  const settings = resolveStatusline({ ...options.settings, layout: { rows: [], ...options.settings?.layout } });
  const block = renderStatuslineBlock({
    summary: { ...SUMMARY, ...options.summary },
    view: { ...VIEW, ...options.view },
    payload: parseClientPayload({ transcript_path: TRANSCRIPT, ...options.payload }),
    terminalWidth: WIDE_TERMINAL,
    nowMs: NOW_MS,
    settings,
    ports: fakeStatuslinePorts(options.ports),
  });
  return block === "" ? [] : block.split("|").map((part) => part.trim());
}

function onlyHeader(...names: NonNullable<NonNullable<StatuslineSettings["layout"]>["header"]>): StatuslineSettings {
  return { layout: { header: names } };
}

describe("the model segment", () => {
  it("writes the client's name whole by default, and drops the context suffix, then the Claude prefix, as the format asks", () => {
    expect(segments({ settings: onlyHeader("model") })).toEqual(["Claude Opus 4.7 (1M context)"]);
    expect(segments({ settings: { ...onlyHeader("model"), model: { format: "compact" } } })).toEqual(["Claude Opus 4.7"]);
    expect(segments({ settings: { ...onlyHeader("model"), model: { format: "short" } } })).toEqual(["Opus 4.7"]);
  });

  it("shows the override in place of the client's name, unformatted", () => {
    expect(segments({ settings: { ...onlyHeader("model"), model: { override: "Work model", format: "short" } } })).toEqual(["Work model"]);
  });

  it("keeps a dynamic mode's served model beside an overridden name", () => {
    const modelChoice = { requested: "auto", served: "glm-5.3", provider: "zai", providers: ["zai"] };
    expect(segments({ settings: { ...onlyHeader("model"), model: { override: "Work model" } }, summary: { modelChoice } })).toEqual(["Work model -> glm-5.3"]);
  });

  it("takes the name of the model the transcript says answered when the source is the transcript, and has no arrow to add", () => {
    const ports = transcriptOf([assistant("claude-opus-4-7"), assistant("glm-5.3")].join("\n"));
    const modelChoice = { requested: "auto", served: "glm-5.3", provider: "zai", providers: ["zai"] };
    expect(segments({ settings: { ...onlyHeader("model"), model: { source: "transcript" } }, ports, summary: { modelChoice } })).toEqual(["glm-5.3"]);
  });

  it("never takes a name Claude Code wrote itself, and keeps the real model the record before it names", () => {
    const ports = transcriptOf([assistant("glm-5.3"), assistant("<synthetic>")].join("\n"));
    expect(segments({ settings: { ...onlyHeader("model"), model: { source: "transcript" } }, ports })).toEqual(["glm-5.3"]);
    expect(segments({ settings: { ...onlyHeader("model"), model: { source: "auto" } }, ports: transcriptOf(assistant("<synthetic>")) })).toEqual(["Claude Opus 4.7 (1M context)"]);
  });

  it("applies the format to a served name too", () => {
    const ports = transcriptOf(assistant("Claude Haiku 4.5 (200k context)"));
    expect(segments({ settings: { ...onlyHeader("model"), model: { source: "transcript", format: "short" } }, ports })).toEqual(["Haiku 4.5"]);
  });

  it("keeps the client's name under auto while the answering model is a Claude model, and follows a proxy's redirect to any other", () => {
    const settings = { ...onlyHeader("model"), model: { source: "auto" as const } };
    expect(segments({ settings, ports: transcriptOf(assistant("claude-opus-4-7")) })).toEqual(["Claude Opus 4.7 (1M context)"]);
    expect(segments({ settings, ports: transcriptOf(assistant("anthropic.claude-opus-4-7-v1:0")) })).toEqual(["Claude Opus 4.7 (1M context)"]);
    expect(segments({ settings, ports: transcriptOf(assistant("glm-5.3")) })).toEqual(["glm-5.3"]);
  });

  it("falls back to the client's name while the transcript has no assistant record, and never reads the transcript for the client source", () => {
    const log = newReadLog();
    const ports = transcriptOf(record({ type: "user", message: { content: "hi" } }), log);
    expect(segments({ settings: { ...onlyHeader("model"), model: { source: "transcript" } }, ports })).toEqual(["Claude Opus 4.7 (1M context)"]);
    expect(log.reads.length).toBeGreaterThan(0);
    log.reads.length = 0;
    segments({ settings: onlyHeader("model"), ports });
    expect(log.reads).toEqual([]);
  });

  it("strips control characters and escape sequences from a served name, so none can reach the terminal", () => {
    const ports = transcriptOf(assistant(`${ESCAPE}[31mevil\u202Emodel`));
    expect(segments({ settings: { ...onlyHeader("model"), model: { source: "transcript" } }, ports })).toEqual(["evilmodel"]);
  });

  it("reads nothing from a payload that names no transcript", () => {
    const log = newReadLog();
    expect(segments({ settings: { ...onlyHeader("model"), model: { source: "transcript" } }, ports: transcriptOf(assistant("glm-5.3"), log), payload: { transcript_path: undefined } })).toEqual(["Claude Opus 4.7 (1M context)"]);
    expect(log.reads).toEqual([]);
  });
});

describe("the platform beside the model", () => {
  const vertex = { env: { CLAUDE_CODE_USE_VERTEX: "1" } };

  it("follows the model's name with the platform claude-hud detects, after the header's separator", () => {
    expect(segments({ settings: onlyHeader("model"), ports: { env: { CLAUDE_CODE_USE_BEDROCK: "1" } } })).toEqual(["Claude Opus 4.7 (1M context)", "Bedrock"]);
    expect(segments({ settings: onlyHeader("model"), ports: vertex })).toEqual(["Claude Opus 4.7 (1M context)", "Vertex"]);
    expect(segments({ settings: onlyHeader("model"), ports: { env: { ANTHROPIC_BASE_URL: "https://api.minimax.io/anthropic" } } })).toEqual(["Claude Opus 4.7 (1M context)", "MiniMax"]);
    expect(segments({ settings: onlyHeader("model"), payload: { model: { id: "opusplan", display_name: "Opus Plan" } }, view: { modelDisplayName: "Opus Plan" } })).toEqual(["Opus Plan", "Enterprise"]);
  });

  it("draws the name alone when no platform is detected", () => {
    expect(segments({ settings: onlyHeader("model"), payload: { model: { id: "claude-opus-4-7", display_name: "Claude Opus 4.7 (1M context)" } } })).toEqual(["Claude Opus 4.7 (1M context)"]);
  });

  it("draws the name alone when model.platform is off", () => {
    expect(segments({ settings: { ...onlyHeader("model"), model: { platform: false } }, ports: vertex })).toEqual(["Claude Opus 4.7 (1M context)"]);
  });

  it("follows an overridden name and a dynamic mode's served model too, and draws nothing without a name", () => {
    const modelChoice = { requested: "auto", served: "glm-5.3", provider: "zai", providers: ["zai"] };
    expect(segments({ settings: { ...onlyHeader("model"), model: { override: "Work model" } }, summary: { modelChoice }, ports: vertex })).toEqual(["Work model -> glm-5.3", "Vertex"]);
    expect(segments({ settings: onlyHeader("model"), view: { modelDisplayName: undefined }, ports: vertex })).toEqual([]);
  });
});

describe("the provider segment", () => {
  const withProvider: Partial<StatuslineSummary> = { provider: "Z.ai", providerAccountEmail: "grace@example.com", providerPlan: "Pro" };

  it("names the launch's provider with its account by default, and nothing without a provider", () => {
    expect(segments({ settings: onlyHeader("provider"), summary: withProvider })).toEqual(["Z.ai · grace@example.com · Pro"]);
    expect(segments({ settings: onlyHeader("provider") })).toEqual([]);
  });

  it("shows the label from the settings in place of the provider's name, keeping its account", () => {
    expect(segments({ settings: { ...onlyHeader("provider"), provider: { name: "Proxy" } }, summary: withProvider })).toEqual(["Proxy · grace@example.com · Pro"]);
  });

  it("shows the label alone for a launch with no provider", () => {
    expect(segments({ settings: { ...onlyHeader("provider"), provider: { name: "Proxy" } } })).toEqual(["Proxy"]);
  });
});

describe("the account segment", () => {
  it("writes the email and the plan by default", () => {
    expect(segments({ settings: onlyHeader("account") })).toEqual(["ada.lovelace@example.com · Max 20x"]);
  });

  it("writes the parts the list names, in its order, and hides the segment when it is empty", () => {
    expect(segments({ settings: { ...onlyHeader("account"), account: { parts: ["plan", "user"] } } })).toEqual(["Max 20x · ada.lovelace@example.com"]);
    expect(segments({ settings: { ...onlyHeader("account"), account: { parts: ["plan"] } } })).toEqual(["Max 20x"]);
    expect(segments({ settings: { ...onlyHeader("account"), account: { parts: ["user"] } } })).toEqual(["ada.lovelace@example.com"]);
    expect(segments({ settings: { ...onlyHeader("account"), account: { parts: [] } } })).toEqual([]);
  });

  it("names an organisation only for the organisation types, when the list asks for it", () => {
    const team = { loginOrganizationType: "claude_team", loginOrganizationName: "Acme", loginSeatTier: "team_standard" };
    expect(segments({ settings: { ...onlyHeader("account"), account: { parts: ["organisation", "plan"] } }, summary: team })).toEqual(["Acme · Team Standard"]);
    expect(segments({ settings: { ...onlyHeader("account"), account: { parts: ["organisation"] } } })).toEqual([]);
  });

  it("cuts the email to the length set, with an ellipsis, and leaves a shorter one whole", () => {
    expect(segments({ settings: { ...onlyHeader("account"), account: { userLength: SHORT_USER_LENGTH } } })).toEqual(["ada.l… · Max 20x"]);
    expect(segments({ settings: { ...onlyHeader("account"), account: { userLength: 100 } } })).toEqual(["ada.lovelace@example.com · Max 20x"]);
  });
});

describe("the effort segment", () => {
  const effort = (format: "full" | "symbol" | "text", payload: Readonly<Record<string, unknown>>): string[] => segments({ settings: { ...onlyHeader("effort"), effort: { format } }, payload });

  it("writes a symbol and the level by default, from a bare string or an object's level", () => {
    expect(segments({ settings: onlyHeader("effort"), payload: { effort: "high" } })).toEqual(["◑ high"]);
    expect(segments({ settings: onlyHeader("effort"), payload: { effort: { level: "max" } } })).toEqual(["● max"]);
  });

  it("writes the symbol alone or the level alone as the format asks", () => {
    expect(effort("symbol", { effort: "xhigh" })).toEqual(["◕"]);
    expect(effort("text", { effort: "xhigh" })).toEqual(["xhigh"]);
  });

  it("writes a level with no symbol as its name in every format, and normalises its case", () => {
    expect(effort("full", { effort: "Turbo " })).toEqual(["turbo"]);
    expect(effort("symbol", { effort: "turbo" })).toEqual(["turbo"]);
    expect(effort("full", { effort: "LOW" })).toEqual(["○ low"]);
  });

  it("removes escape sequences and control characters from a level, so none can reach the terminal", () => {
    expect(effort("full", { effort: `${ESCAPE}[2Jhigh` })).toEqual(["◑ high"]);
    expect(effort("text", { effort: { level: `${ESCAPE}[2J\u0007` } })).toEqual([]);
  });

  it("writes a level that names an inherited object property as its own name, not as a symbol", () => {
    expect(effort("full", { effort: "constructor" })).toEqual(["constructor"]);
    expect(effort("symbol", { effort: "__proto__" })).toEqual(["__proto__"]);
  });

  it("draws nothing when the client reports no level", () => {
    for (const payload of [{}, { effort: "" }, { effort: {} }, { effort: { level: null } }, { effort: 3 }]) {
      expect(effort("full", payload), JSON.stringify(payload)).toEqual([]);
    }
  });
});

describe("the advisor segment", () => {
  const transcriptWith = (advisor: string): Partial<StatuslinePorts> => transcriptOf([assistant("claude-opus-4-7", "claude-sonnet-4-6"), assistant("claude-opus-4-7", advisor)].join("\n"));

  it("shows the latest advisor the transcript records, written as a person says it", () => {
    expect(segments({ settings: onlyHeader("advisor"), ports: transcriptWith("claude-opus-4-7") })).toEqual(["Advisor: Opus 4.7"]);
    expect(segments({ settings: onlyHeader("advisor"), ports: transcriptWith("claude-haiku-4-5-20251001") })).toEqual(["Advisor: Haiku 4.5"]);
    expect(segments({ settings: onlyHeader("advisor"), ports: transcriptWith("sonnet") })).toEqual(["Advisor: Sonnet"]);
    expect(segments({ settings: onlyHeader("advisor"), ports: transcriptWith("claude-experimental") })).toEqual(["Advisor: experimental"]);
  });

  it("writes a dated id with and without a minor version, and the older version-first naming, without reading a date as a minor", () => {
    const written = (id: string): string[] => segments({ settings: onlyHeader("advisor"), ports: transcriptWith(id) });
    expect(written("claude-opus-4-20250514")).toEqual(["Advisor: Opus 4"]);
    expect(written("claude-sonnet-4-20250514")).toEqual(["Advisor: Sonnet 4"]);
    expect(written("claude-opus-4-1-20250805")).toEqual(["Advisor: Opus 4.1"]);
    expect(written("claude-3-5-sonnet-20241022")).toEqual(["Advisor: Sonnet 3.5"]);
    expect(written("claude-3-haiku-20240307")).toEqual(["Advisor: Haiku 3"]);
    expect(written("claude-opus")).toEqual(["Advisor: Opus"]);
    expect(written("claude-opus-4-7-custom")).toEqual(["Advisor: opus-4-7-custom"]);
  });

  it("shows the override instead of the transcript's, without reading the transcript", () => {
    const log = newReadLog();
    expect(segments({ settings: { ...onlyHeader("advisor"), advisor: { override: "Fable" } }, ports: transcriptOf(assistant("claude-opus-4-7", "claude-opus-4-7"), log) })).toEqual(["Advisor: Fable"]);
    expect(log.reads).toEqual([]);
  });

  it("draws nothing when no advisor has been set", () => {
    expect(segments({ settings: onlyHeader("advisor"), ports: transcriptOf(assistant("claude-opus-4-7")) })).toEqual([]);
    expect(segments({ settings: onlyHeader("advisor") })).toEqual([]);
  });

  it("skips a record that is not whole, such as the one a read of a growing file ends in, and keeps what came before", () => {
    const ports = transcriptOf(`${assistant("claude-opus-4-7", "claude-opus-4-7")}\n{"type":"assistant","advisorModel":"claude-so`);
    expect(segments({ settings: onlyHeader("advisor"), ports })).toEqual(["Advisor: Opus 4.7"]);
  });

  it("reads the transcript once for the model and the advisor together", () => {
    const settings = { ...onlyHeader("model", "advisor"), model: { source: "transcript" as const } };
    const together = newReadLog();
    expect(segments({ settings, ports: transcriptOf(assistant("glm-5.3", "claude-opus-4-7"), together) })).toEqual(["glm-5.3", "Advisor: Opus 4.7"]);
    const alone = newReadLog();
    segments({ settings: { ...onlyHeader("model"), model: { source: "transcript" as const } }, ports: transcriptOf(assistant("glm-5.3", "claude-opus-4-7"), alone) });
    expect(together).toEqual(alone);
  });
});

describe("the version segment", () => {
  it("writes the release the client reports, and nothing when it reports none", () => {
    expect(segments({ settings: onlyHeader("version"), payload: { version: "2.1.81" } })).toEqual(["CC v2.1.81"]);
    expect(segments({ settings: onlyHeader("version"), payload: {} })).toEqual([]);
    expect(segments({ settings: onlyHeader("version"), payload: { version: "" } })).toEqual([]);
  });

  it("removes escape sequences and control characters from the version", () => {
    expect(segments({ settings: onlyHeader("version"), payload: { version: `${ESCAPE}[2J2.1.81\u0007` } })).toEqual(["CC v2.1.81"]);
    expect(segments({ settings: onlyHeader("version"), payload: { version: `${ESCAPE}[2J` } })).toEqual([]);
  });
});

describe("the output style segment", () => {
  const files = (contents: Readonly<Record<string, string>>): Partial<StatuslinePorts> => ({
    homeDirectory: "/home/ada",
    readText: (path) => contents[path],
  });
  const style = (name: string): string => JSON.stringify({ outputStyle: name });

  it("reads the style from the user's settings in the default configuration directory", () => {
    expect(segments({ settings: onlyHeader("outputStyle"), ports: files({ "/home/ada/.claude/settings.json": style("Explanatory") }) })).toEqual(["style: Explanatory"]);
  });

  it("treats an empty configuration directory as unset, so the settings are not looked for beside the working directory", () => {
    const ports = { ...files({ "/home/ada/.claude/settings.json": style("Home"), "settings.json": style("Relative") }), env: { CLAUDE_CONFIG_DIR: "" } };
    expect(segments({ settings: onlyHeader("outputStyle"), ports })).toEqual(["style: Home"]);
  });

  it("reads the configuration directory the environment names, not the home directory's", () => {
    const ports = { ...files({ "/home/ada/.claude/settings.json": style("Wrong"), "/identities/ada/settings.json": style("Learning") }), env: { CLAUDE_CONFIG_DIR: "/identities/ada" } };
    expect(segments({ settings: onlyHeader("outputStyle"), ports })).toEqual(["style: Learning"]);
  });

  it("lets each later layer override the last: user, user local, project, project local", () => {
    const layers = {
      "/home/ada/.claude/settings.json": style("user"),
      "/home/ada/.claude/settings.local.json": style("user-local"),
      "/work/.claude/settings.json": style("project"),
      "/work/.claude/settings.local.json": style("project-local"),
    };
    const layerFiles = Object.keys(layers);
    const styles = ["user", "user-local", "project", "project-local"];
    // Each layer added on top of the ones below it takes over; the last present layer is the one drawn.
    styles.forEach((expected, index) => {
      const kept = new Set(layerFiles.slice(0, index + 1));
      const present = Object.fromEntries(Object.entries(layers).filter(([file]) => kept.has(file)));
      expect(segments({ settings: onlyHeader("outputStyle"), payload: { cwd: "/work" }, ports: files(present) }), expected).toEqual([`style: ${expected}`]);
    });
  });

  it("reads the project from the workspace directory when the payload has no cwd", () => {
    expect(segments({ settings: onlyHeader("outputStyle"), payload: { workspace: { current_dir: "/work" } }, ports: files({ "/work/.claude/settings.json": style("project") }) })).toEqual(["style: project"]);
  });

  it("passes over a file that is not JSON, names no style or names an empty one, to the layer below", () => {
    const ports = files({ "/home/ada/.claude/settings.json": style("user"), "/home/ada/.claude/settings.local.json": "{not json", "/work/.claude/settings.json": "{}", "/work/.claude/settings.local.json": style("  ") });
    expect(segments({ settings: onlyHeader("outputStyle"), payload: { cwd: "/work" }, ports })).toEqual(["style: user"]);
  });

  it("draws nothing when no layer names a style", () => {
    expect(segments({ settings: onlyHeader("outputStyle"), ports: files({}) })).toEqual([]);
  });

  it("strips control characters from the style", () => {
    expect(segments({ settings: onlyHeader("outputStyle"), ports: files({ "/home/ada/.claude/settings.json": style(`${ESCAPE}[1mBold`) }) })).toEqual(["style: Bold"]);
  });
});

describe("the segments' defaults", () => {
  it("draw none of the added segments, which claude-hud's default leaves off too, whatever the payload and transcript hold", () => {
    expect(STATUSLINE_DEFAULTS.layout.header).toEqual(["model", "project", "vcs", "provider", "route", "account", "identity", "headroom", "extra"]);
    const payload = { version: "2.1.81", effort: "high", cwd: "/work", transcript_path: TRANSCRIPT };
    const ports = { ...transcriptOf(assistant("glm-5.3", "claude-opus-4-7")), readText: () => explanatoryStyle() };
    expect(segments({ payload, ports })).toEqual(["Claude Opus 4.7 (1M context)", `${ESCAPE}[33mwork${ESCAPE}[0m`, "ada.lovelace@example.com · Max 20x"]);
  });

  it("draw the platform beside the model, as claude-hud's default does", () => {
    expect(STATUSLINE_DEFAULTS.model.platform).toBe(true);
    expect(segments({ payload: { cwd: "/work" }, ports: { env: { CLAUDE_CODE_USE_VERTEX: "1" } } })).toEqual(["Claude Opus 4.7 (1M context)", "Vertex", `${ESCAPE}[33mwork${ESCAPE}[0m`, "ada.lovelace@example.com · Max 20x"]);
  });
});

function explanatoryStyle(): string {
  return JSON.stringify({ outputStyle: "Explanatory" });
}
