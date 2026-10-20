import { truncateWithEllipsis, visibleLength } from "../../ansi";
import { paintCore } from "../../messages/around";
import { parseClaudeModelId } from "../../modelId";
import type { AgentFact } from "../../transcript/activity";
import type { RenderContext, RowOutput } from "../context";
import { formatSpan } from "../sessionFormat";
import { DONE_MARK, ELLIPSIS, NO_LINES, RUNNING_MARK } from "./activityParts";

/** The most agents the row draws, running ones first: a finished agent is history, and never takes the place of one still working. */
const MAX_AGENTS_SHOWN = 3;

/** The most finished agents drawn, and how long after it ended one is still worth a line: a person looks at the statusline when something has just happened, and an agent that finished a minute ago is news. */
const MAX_RECENT_FINISHED = 2;
const FINISHED_RETENTION_MS = 60_000;

/** The most columns of an agent's type and description the row gives them, before the width of the line cuts the description further. */
const TYPE_COLUMNS = 24;
const DESCRIPTION_COLUMNS = 40;

const BRACKETED_SUFFIX = /\[[^\]]*\]$/;

/** An agent's model as a short label: a Claude model ID is its family and version (`claude-opus-4-8[1m]` is `opus-4.8`, `claude-haiku-4-5-20251001` is `haiku-4.5`), an alias such as `opus` stays as it is, and any other ID, which names a provider's own model, is kept whole. */
function modelLabel(model: string | undefined): string | undefined {
  const id = model?.replace(BRACKETED_SUFFIX, "").trim();
  if (id === undefined || id === "" || /^claude-$/i.test(id)) {
    return undefined;
  }
  const parsed = parseClaudeModelId(id);
  return parsed === undefined ? id : `${parsed.family}${parsed.version === undefined ? "" : `-${parsed.version}`}`;
}

/** The agents to draw: the newest running ones, then as many of the recently finished ones as the budget leaves. */
function agentsShown(agents: readonly AgentFact[], nowMs: number): AgentFact[] {
  const running = agents.filter((agent) => agent.status === "running").slice(-MAX_AGENTS_SHOWN);
  const slots = Math.min(MAX_RECENT_FINISHED, MAX_AGENTS_SHOWN - running.length);
  const recent = agents.filter((agent) => agent.status === "completed" && agent.endedAtMs !== undefined && agent.endedAtMs <= nowMs && nowMs - agent.endedAtMs <= FINISHED_RETENTION_MS);
  return [...running, ...(slots > 0 ? recent.slice(-slots) : [])];
}

/** The fewest columns worth giving a description: the ellipsis that ends it and one character before it. Below that the description is left out. */
const DESCRIPTION_ELLIPSIS = "...";
const MIN_DESCRIPTION_COLUMNS = DESCRIPTION_ELLIPSIS.length + 1;

/** An agent as one line that fits the width: a marker, its type, its model, what it was asked to do and how long it ran or has been running. What does not fit is given up in turn, the description first (it gets what is left, up to its own limit), then the model, then the end of the type. */
function agentLine(agent: AgentFact, context: RenderContext): string {
  const { palette, nowMs, width, t } = context;
  const marker = agent.status === "running" ? palette.paint("warning", RUNNING_MARK) : palette.paint("context", DONE_MARK);
  const elapsed = formatSpan(Math.max(0, (agent.endedAtMs ?? nowMs) - (agent.startedAtMs ?? nowMs)));
  const timeText = t("agents.elapsed", { time: elapsed });
  // The marker and a space after it; the time and the model hold the space before them themselves, where the language writes one.
  const fixed = visibleLength(RUNNING_MARK) + 1 + visibleLength(timeText);
  const type = truncateWithEllipsis(agent.type, Math.min(TYPE_COLUMNS, Math.max(1, width - fixed)), ELLIPSIS);
  const model = modelLabel(agent.model);
  const modelText = model === undefined ? "" : t("agents.model", { model });
  const showModel = modelText !== "" && fixed + visibleLength(type) + visibleLength(modelText) <= width;
  const used = fixed + visibleLength(type) + (showModel ? visibleLength(modelText) : 0);
  // The words that introduce the description are the language's, so their width is measured from the message.
  const room = Math.min(DESCRIPTION_COLUMNS, width - used - visibleLength(t("agents.description", { description: "" })));
  const description = agent.description === undefined || room < MIN_DESCRIPTION_COLUMNS ? "" : palette.paint("label", t("agents.description", { description: truncateWithEllipsis(agent.description, room, DESCRIPTION_ELLIPSIS) }));
  const label = (text: string): string => palette.paint("label", text);
  return `${marker} ${palette.paint("agent", type)}${showModel ? paintCore(modelText, label) : ""}${description}${paintCore(timeText, label)}`;
}

/** The session's agents, one line each: the running ones first, then those that finished in the last minute, at most three together. Nothing is drawn without a transcript to read or an agent to show. */
export function agentsRow(context: RenderContext): RowOutput {
  const facts = context.transcript();
  const shown = facts === undefined ? [] : agentsShown(facts.activity.agents, context.nowMs);
  return shown.length === 0 ? NO_LINES : { kind: "text", lines: shown.map((agent) => agentLine(agent, context)) };
}
