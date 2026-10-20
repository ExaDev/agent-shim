import { truncateWithEllipsis, visibleLength } from "../../ansi";
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

/** An agent as one line: a marker, its type, its model, what it was asked to do and how long it ran or has been running. The description gets what the line has left, up to its own limit, and is left out when nothing is left. */
function agentLine(agent: AgentFact, context: RenderContext): string {
  const { palette, nowMs, width } = context;
  const marker = agent.status === "running" ? palette.paint("warning", RUNNING_MARK) : palette.paint("context", DONE_MARK);
  const type = truncateWithEllipsis(agent.type, TYPE_COLUMNS, ELLIPSIS);
  const model = modelLabel(agent.model);
  const elapsed = formatSpan(Math.max(0, (agent.endedAtMs ?? nowMs) - (agent.startedAtMs ?? nowMs)));
  const modelText = model === undefined ? "" : ` ${palette.paint("label", `[${model}]`)}`;
  const timeText = ` ${palette.paint("label", `(${elapsed})`)}`;
  const fixed = visibleLength(`${marker} ${type}${modelText}${timeText}`);
  // The description is introduced by a colon and a space.
  const room = Math.min(DESCRIPTION_COLUMNS, width - fixed - 2);
  const description = agent.description === undefined || room < 1 ? "" : palette.paint("label", `: ${truncateWithEllipsis(agent.description, room, "...")}`);
  return `${marker} ${palette.paint("agent", type)}${modelText}${description}${timeText}`;
}

/** The session's agents, one line each: the running ones first, then those that finished in the last minute, at most three together. Nothing is drawn without a transcript to read or an agent to show. */
export function agentsRow(context: RenderContext): RowOutput {
  const facts = context.transcript();
  const shown = facts === undefined ? [] : agentsShown(facts.activity.agents, context.nowMs);
  return shown.length === 0 ? NO_LINES : { kind: "text", lines: shown.map((agent) => agentLine(agent, context)) };
}
