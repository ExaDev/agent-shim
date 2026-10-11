import type { Command } from "commander";

import { printJson, withExamples, type CommandDeps } from "../cli/commandDeps";
import { listIdentities } from "../identityStore";
import { realSessionFs } from "./realFs";
import type { AgentNode, SessionAgentTree } from "./schema";
import { collectSessionList, showSession, type IdentitySession } from "./sessions";

/** The identity column of the text listing: the first identity, and how many more expose the same session, so a shared history store does not print every name on every line. */
function identityColumn(identities: readonly string[]): string {
  const [first, ...rest] = identities;
  return rest.length === 0 ? (first ?? "-") : `${first ?? "-"} +${String(rest.length)}`;
}

/** Formats `session list`, one line per session. */
export function formatSessionList(sessions: readonly IdentitySession[]): string[] {
  if (sessions.length === 0) {
    return ["no sessions with agents or workflow runs found"];
  }
  return sessions.map((session) => {
    const when = session.updatedAt ?? "-";
    const state = session.superseded ? " superseded" : "";
    return `${identityColumn(session.identities)}  ${session.sessionId}  ${when}  agents=${String(session.agentCount)} runs=${String(session.workflowRunCount)}${state}  ${session.project}`;
  });
}

function formatNode(node: AgentNode, depth: number): string[] {
  const indent = "  ".repeat(depth);
  const label = node.description ?? node.name ?? "";
  const extras = [node.background === true ? "background" : undefined, node.workflowRunId, node.workflowPhase, node.teamName, node.stoppedByUser === true ? "stopped" : undefined].filter((value) => value !== undefined);
  const line = `${indent}- [${node.kind}] ${node.agentType} ${node.id}${label === "" ? "" : `  ${label}`}${extras.length === 0 ? "" : `  (${extras.join(", ")})`}`;
  return [line, ...node.children.flatMap((child) => formatNode(child, depth + 1))];
}

/** Formats `session show`: the agent tree indented by nesting, then the task list, workflow runs and anything unreadable. */
export function formatSessionTree(identities: readonly string[], tree: SessionAgentTree): string[] {
  const lines = [`session ${tree.sessionId}${tree.superseded ? " (superseded)" : ""}  identities ${identities.join(",")}  project ${tree.project}`];
  lines.push(tree.agents.length === 0 ? "agents: none" : "agents:", ...tree.agents.flatMap((node) => formatNode(node, 1)));
  if (tree.workflowRuns.length > 0) {
    lines.push("workflow runs:", ...tree.workflowRuns.map((run) => `  ${run.runId}  ${run.workflowName ?? "-"}  ${run.status ?? "-"}  phases: ${run.phases.join(" > ") || "-"}`));
  }
  if (tree.tasks.length > 0) {
    lines.push("tasks:", ...tree.tasks.map((task) => `  [${task.status}] ${task.id}  ${task.subject}`));
  }
  if (tree.problems.length > 0) {
    lines.push("problems:", ...tree.problems.map((problem) => `  ${problem.path}: ${problem.reason}`));
  }
  return lines;
}

/** Registers the `session` noun: `list` and `show`. Both read the transcripts on disk and write nothing. */
export function registerSessionCommands(program: Command, deps: CommandDeps): void {
  const { paths } = deps;
  const identityNames = (): readonly string[] => listIdentities(paths).map((entry) => entry.name);
  const session = withExamples(program.command("session").description("Inspect a session's agents: its subagents, forks, workflow agents, task list and workflow runs, read from the transcripts on disk."), [
    "agent-shim session list",
    "agent-shim session show 3164d246",
  ]);
  withExamples(
    session
      .command("list")
      .description("List sessions that spawned agents or ran workflows, newest transcript first, with their agent and workflow-run counts. Read-only.")
      .option("--identity <name>", "Only this identity's sessions.")
      .option("--all", "Include sessions that spawned no agent and ran no workflow.")
      .option("--json", "Print the sessions as JSON.")
      .action((options: Readonly<{ identity?: string; all?: boolean; json?: boolean }>) => {
        const sessions = collectSessionList(realSessionFs, paths.identitiesDir, identityNames(), {
          ...(options.identity === undefined ? {} : { identity: options.identity }),
          ...(options.all === undefined ? {} : { all: options.all }),
        });
        if (options.json === true) {
          printJson(sessions);
          return;
        }
        for (const line of formatSessionList(sessions)) {
          console.log(line);
        }
      }),
    ["agent-shim session list", "agent-shim session list --identity work --json"],
  );
  withExamples(
    session
      .command("show <session>")
      .description("Show one session's agent tree, task list and workflow runs. Takes the session id or an unambiguous prefix of it. Read-only.")
      .option("--identity <name>", "Look only in this identity.")
      .option("--json", "Print the tree as JSON.")
      .action((query: string, options: Readonly<{ identity?: string; json?: boolean }>) => {
        const view = showSession(realSessionFs, paths.identitiesDir, identityNames(), query, options.identity);
        if (options.json === true) {
          printJson({ identities: view.identities, ...view.tree });
          return;
        }
        for (const line of formatSessionTree(view.identities, view.tree)) {
          console.log(line);
        }
      }),
    ["agent-shim session show 3164d246", "agent-shim session show 3164d246 --identity work --json"],
  );
}
