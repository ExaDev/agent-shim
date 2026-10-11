import { ORPCError } from "@orpc/client";
import { openapi } from "@orpc/openapi";
import { z } from "zod";

import { MergedAgentTreeSchema, mergeLiveTasks, type LiveTask } from "../agents/liveTasks";
import type { SessionSummary } from "../agents/read";
import { SessionSummarySchema, type SessionAgentTreeSchema } from "../agents/schema";
import { CliError } from "../cliError";
import { doorApiAuth, READ_ONLY_OPERATION_EXTENSION, SESSION_HISTORY_TAG } from "./rcApi";

/**
 * A session's agents as a typed oRPC API: the sessions that spawned agents or ran workflows, and one session's agent tree, task list and workflow runs, read from the transcripts on disk. The same data `agent-shim session list` and `session show` print, so a consumer that is not the CLI (an MCP client, the library) asks the door for it.
 */

/** What `agentTrees.list` accepts. */
export const AgentTreesListInputSchema = z.strictObject({
  /** Only this identity's sessions. */
  identity: z.string().optional(),
  /** Include sessions that spawned no agent and ran no workflow. */
  all: z.boolean().optional(),
});

/** What `agentTrees.list` answers. */
export const AgentTreesListOutputSchema = z.array(SessionSummarySchema);

/** What `agentTrees.show` accepts. */
export const AgentTreesShowInputSchema = z.strictObject({
  /** A session id, or an unambiguous prefix of one. */
  session: z.string().min(1),
  /** Look only in this identity. */
  identity: z.string().optional(),
});

/** What `agentTrees.show` answers: the tree read from disk with the live Remote Control tasks merged in, beside the identities that expose it. */
export const AgentTreesShowOutputSchema = z.strictObject({ identities: z.array(z.string()), ...MergedAgentTreeSchema.shape });

/** Everything the agent trees procedures need, injected so they serve against fakes in tests exactly as the door's real wiring serves against this machine. */
export interface AgentTreesApiDeps {
  /** This generation's control token: the same value every router on the mount checks. */
  readonly expectedToken: string;
  /** Lists sessions, throwing the reader's `CliError` for an identity that does not exist. */
  readonly sessionList: (filters: z.infer<typeof AgentTreesListInputSchema>) => readonly (SessionSummary & { readonly identities: readonly string[] })[];
  /** Resolves and reads one session, throwing the reader's `CliError` for an id that matches none or several. */
  readonly sessionShow: (query: string, identity: string | undefined) => { readonly identities: readonly string[]; readonly tree: z.infer<typeof SessionAgentTreeSchema> };
  /** The live tasks the door has observed on its Remote Control sessions, which the disk tree is merged with. Empty when no session is live. */
  readonly liveTasks: () => readonly LiveTask[];
}

/** A lookup the caller got wrong (no such identity, an id that matches nothing or several) is the request being impossible, answered with the reader's own message; anything else is a bug and stays a server error. */
function asBadRequest(error: unknown): never {
  if (error instanceof CliError) {
    throw new ORPCError("BAD_REQUEST", { message: error.message });
  }
  throw error;
}

/** Builds the agent trees router: two reads, behind the control-token middleware. */
export function createAgentTreesApiRouter(deps: AgentTreesApiDeps) {
  const authed = doorApiAuth(deps.expectedToken);
  return {
    agentTrees: {
      list: authed
        .meta(
          openapi({
            method: "POST",
            path: "/rest/agent-trees/list",
            summary: "List the sessions that spawned agents or ran workflows, newest transcript first",
            tags: [SESSION_HISTORY_TAG],
            // A POST because the filters are a body, but the answer changes nothing.
            spec: (current) => ({ ...current, [READ_ONLY_OPERATION_EXTENSION]: true }),
          }),
        )
        .input(AgentTreesListInputSchema)
        .output(AgentTreesListOutputSchema)
        .handler(({ input }) => {
          try {
            return deps.sessionList(input).map((session) => ({ ...session, identities: [...session.identities] }));
          } catch (error: unknown) {
            return asBadRequest(error);
          }
        }),
      show: authed
        .meta(
          openapi({
            method: "POST",
            path: "/rest/agent-trees/show",
            summary: "Show one session's agent tree, task list and workflow runs, with the live Remote Control tasks merged in",
            tags: [SESSION_HISTORY_TAG],
            spec: (current) => ({ ...current, [READ_ONLY_OPERATION_EXTENSION]: true }),
          }),
        )
        .input(AgentTreesShowInputSchema)
        .output(AgentTreesShowOutputSchema)
        .handler(({ input }) => {
          try {
            const view = deps.sessionShow(input.session, input.identity);
            return { identities: [...view.identities], ...mergeLiveTasks(view.tree, deps.liveTasks()) };
          } catch (error: unknown) {
            return asBadRequest(error);
          }
        }),
    },
  };
}

/** The agent trees router, as the merged mount's and the client's own types are derived from it. */
export type AgentTreesApiRouter = ReturnType<typeof createAgentTreesApiRouter>;
