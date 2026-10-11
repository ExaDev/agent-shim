import nodeFs from "node:fs";
import path from "node:path";

import type { Command } from "commander";

import { printJson, withExamples, type CommandDeps } from "../cli/commandDeps";
import { CliError } from "../cliError";
import { listIdentities } from "../identityStore";
import { realFarmFs } from "../realPorts";
import { listSessions, readSessionAgentTree, summariseSession, type AgentReadFs, type SessionRef, type SessionSummary } from "./read";
import type { AgentNode, SessionAgentTree } from "./schema";

/** The reads the session commands make: the reader's own, plus resolving a path to the real location it points at, which is how identities sharing one history store are told from identities with their own. */
export interface SessionCommandFs extends AgentReadFs {
  /** The real path `candidate` resolves to, or undefined when nothing is there. */
  readonly realpath: (candidate: string) => string | undefined;
}

/** The real filesystem, for the commands. */
const realSessionFs: SessionCommandFs = {
  ...realFarmFs,
  realpath: (candidate) => {
    try {
      return nodeFs.realpathSync(candidate);
    } catch {
      // An identity that has never run a session has no projects directory; that is the answer, not an error.
      return undefined;
    }
  },
};

/** A session as `session list` reports it. `identities` names every identity whose configuration exposes it: history is shared between identities by default, so one session is usually visible to several. */
export interface IdentitySession extends SessionSummary {
  readonly identities: readonly string[];
}

/** Raised when a session id names no session, or more than one. */
export class SessionLookupError extends CliError {
  constructor(message: string) {
    super(message);
    this.name = "SessionLookupError";
  }
}

/** The configuration directory an identity's sessions live under. */
function identityConfigDir(identitiesDir: string, identity: string): string {
  return path.join(identitiesDir, identity);
}

/** Identities whose `projects` directory is the same store on disk, scanned once for all of them. */
interface HistoryStore {
  /** The identity whose configuration directory is read for this store. */
  readonly configDir: string;
  readonly identities: readonly string[];
}

/** Groups identities by the real location of their `projects` directory, in the order the identities were given. An identity with no projects directory belongs to no store. */
function historyStores(fs: SessionCommandFs, identitiesDir: string, identities: readonly string[]): readonly HistoryStore[] {
  const byRealPath = new Map<string, { configDir: string; identities: string[] }>();
  for (const identity of identities) {
    const configDir = identityConfigDir(identitiesDir, identity);
    const real = fs.realpath(path.join(configDir, "projects"));
    if (real === undefined) {
      continue;
    }
    const store = byRealPath.get(real);
    if (store === undefined) {
      byRealPath.set(real, { configDir, identities: [identity] });
    } else {
      store.identities.push(identity);
    }
  }
  return [...byRealPath.values()];
}

/** Filters for `session list`. */
export interface SessionListFilters {
  /** Only this identity's sessions. */
  readonly identity?: string;
  /** Include sessions that spawned no agent and ran no workflow. */
  readonly all?: boolean;
}

/**
 * Collects `session list`, read-only: every session of the given identities with its agent and workflow-run counts, newest transcript first. Sessions with nothing to inspect are left out unless `all` is set, because most sessions never spawn an agent and listing them would bury the ones that did.
 */
export function collectSessionList(fs: SessionCommandFs, identitiesDir: string, identities: readonly string[], filters: Readonly<SessionListFilters>): readonly IdentitySession[] {
  const names = filters.identity === undefined ? identities : identities.filter((name) => name === filters.identity);
  if (filters.identity !== undefined && names.length === 0) {
    throw new SessionLookupError(`no identity named "${filters.identity}"`);
  }
  const sessions: IdentitySession[] = [];
  for (const store of historyStores(fs, identitiesDir, names)) {
    for (const ref of listSessions(fs, store.configDir)) {
      const summary = summariseSession(fs, store.configDir, ref);
      if (filters.all === true || summary.agentCount > 0 || summary.workflowRunCount > 0) {
        sessions.push({ ...summary, identities: store.identities });
      }
    }
  }
  return sessions.sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "") || left.sessionId.localeCompare(right.sessionId));
}

/** A resolved session: where it is read from and which identities expose it. */
export interface LocatedSession {
  readonly identities: readonly string[];
  readonly configDir: string;
  readonly ref: SessionRef;
}

/**
 * Resolves a session id, or an unambiguous prefix of one, across the given identities. Fails with every candidate named when the prefix matches several, so the caller can say which it meant.
 */
export function locateSession(fs: SessionCommandFs, identitiesDir: string, identities: readonly string[], query: string, onlyIdentity?: string): LocatedSession {
  const names = onlyIdentity === undefined ? identities : identities.filter((name) => name === onlyIdentity);
  if (onlyIdentity !== undefined && names.length === 0) {
    throw new SessionLookupError(`no identity named "${onlyIdentity}"`);
  }
  const matches: LocatedSession[] = [];
  for (const store of historyStores(fs, identitiesDir, names)) {
    for (const ref of listSessions(fs, store.configDir)) {
      if (ref.sessionId.startsWith(query)) {
        matches.push({ identities: store.identities, configDir: store.configDir, ref });
      }
    }
  }
  const exact = matches.filter((match) => match.ref.sessionId === query);
  const candidates = exact.length > 0 ? exact : matches;
  const only = candidates[0];
  if (candidates.length === 1 && only !== undefined) {
    return only;
  }
  if (candidates.length === 0) {
    throw new SessionLookupError(`no session matches "${query}"`);
  }
  throw new SessionLookupError(`"${query}" matches ${String(candidates.length)} sessions: ${candidates.map((match) => `${match.ref.sessionId} (${match.identities.join(", ")})`).join("; ")}; give more of the id or pass --identity`);
}

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
        const located = locateSession(realSessionFs, paths.identitiesDir, identityNames(), query, options.identity);
        const tree = readSessionAgentTree(realSessionFs, located.configDir, located.ref);
        if (options.json === true) {
          printJson({ identities: located.identities, ...tree });
          return;
        }
        for (const line of formatSessionTree(located.identities, tree)) {
          console.log(line);
        }
      }),
    ["agent-shim session show 3164d246", "agent-shim session show 3164d246 --identity work --json"],
  );
}
