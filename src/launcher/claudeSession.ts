import { resumeTargetOf } from "../usage/resumeContext";

/** The token that ends agent-shim's own and claude's flag recognition: everything from it onwards belongs to a command claude runs. */
const TERMINATOR = "--";

/** How a supervised launch names its conversation to claude: `start` begins one under the launch's id, `resume` continues the one with that id, `as-given` leaves the caller's own `--resume <id>` as written. */
type ClaudeConversation = "start" | "resume" | "as-given";

/** The flags that take a conversation id as their value. `--resume` and `-r` take it optionally, `--session-id` always. */
const VALUED_CONVERSATION_FLAGS: ReadonlySet<string> = new Set(["--resume", "-r", "--session-id"]);

/** The flags that continue the working directory's latest conversation. */
const CONTINUE_FLAGS: ReadonlySet<string> = new Set(["--continue", "-c"]);

/** Whether `token` is claude's own flag, which a value never is: the optional value of `--resume` is the next token only when it is not one. */
function isFlag(token: string | undefined): boolean {
  return token?.startsWith("-") === true;
}

/**
 * The arguments claude receives with every conversation argument of the caller's removed (`--continue`, `-c`, `--resume [id]`, `-r [id]`, `--session-id <id>`, and their `=` forms) and the launch's own added: `--session-id <id>` for `start`, `--resume <id>` for `resume`. Tokens from a `--` terminator on are left alone, since they belong to a command claude runs, and the added flag goes before them.
 */
export function withConversation(passthrough: readonly string[], conversation: "start" | "resume", id: string): readonly string[] {
  const end = passthrough.indexOf(TERMINATOR);
  const head = end === -1 ? passthrough : passthrough.slice(0, end);
  const tail = end === -1 ? [] : passthrough.slice(end);
  const kept: string[] = [];
  for (let index = 0; index < head.length; index += 1) {
    const token = head[index];
    if (token === undefined || CONTINUE_FLAGS.has(token) || token.startsWith("--resume=") || token.startsWith("--session-id=")) {
      continue;
    }
    if (VALUED_CONVERSATION_FLAGS.has(token)) {
      if (!isFlag(head[index + 1]) && head[index + 1] !== undefined) {
        index += 1;
      }
      continue;
    }
    kept.push(token);
  }
  return [...kept, conversation === "start" ? "--session-id" : "--resume", id, ...tail];
}

/** Whether the arguments already carry the caller's own `--settings`, which a supervised launch cannot add to. */
export function hasSettingsArgument(passthrough: readonly string[]): boolean {
  const end = passthrough.indexOf(TERMINATOR);
  return (end === -1 ? passthrough : passthrough.slice(0, end)).some((token) => token === "--settings" || token.startsWith("--settings="));
}

/** The arguments a supervised launch gives claude: the caller's own, with the conversation argument the launch asks for (unless it takes the caller's as given) and, when it carries any, `--settings` placed before a `--` terminator. */
export function withSupervision(passthrough: readonly string[], supervised: SupervisedLaunch): readonly string[] {
  const conversation = supervised.conversation === "as-given" ? passthrough : withConversation(passthrough, supervised.conversation, supervised.sessionId);
  if (supervised.settings === undefined) {
    return conversation;
  }
  const end = conversation.indexOf(TERMINATOR);
  return end === -1 ? [...conversation, "--settings", supervised.settings] : [...conversation.slice(0, end), "--settings", supervised.settings, ...conversation.slice(end)];
}

/** Whether the arguments open claude's conversation picker (`--resume` or `-r` with no id), which names no conversation until the person chooses. */
function opensPicker(passthrough: readonly string[]): boolean {
  const end = passthrough.indexOf(TERMINATOR);
  const head = end === -1 ? passthrough : passthrough.slice(0, end);
  return head.some((token, index) => (token === "--resume" || token === "-r") && (head[index + 1] === undefined || isFlag(head[index + 1])));
}

/** Whether the arguments run claude non-interactively (`-p` or `--print`): a print run ends by itself and has no prompt to be moved at. */
function isPrintRun(passthrough: readonly string[]): boolean {
  const end = passthrough.indexOf(TERMINATOR);
  return (end === -1 ? passthrough : passthrough.slice(0, end)).some((token) => token === "-p" || token === "--print");
}

/** What a supervising launcher asks of one launch: the session id it carries, how claude is told that id, and, for a relaunch, the pool member to run as in place of a pick. */
export interface SupervisedLaunch {
  /** The id the launch's session carries: the front door's session header, and claude's own conversation id. */
  readonly sessionId: string;
  readonly conversation: ClaudeConversation;
  /** The pool member to run as, for a relaunch after the previous member ran out of quota. The pool pick is skipped. */
  readonly member?: string;
  /** Claude Code settings, as the JSON `--settings` takes, to add to the launch: the hooks that tell the supervisor when a turn begins and ends. */
  readonly settings?: string;
}

/** A conversation id that is safe to use as a file name: the supervisor registers sessions under it. Claude's own ids are UUIDs; anything with a separator or a dot is refused rather than trusted. */
const CONVERSATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** What one supervised launch's conversation is: its id, and how claude is told it. */
export interface InitialConversation {
  readonly sessionId: string;
  readonly conversation: ClaudeConversation;
}

/** Why a launch cannot be supervised: the reason is printed once, and the launch runs unsupervised. */
export interface Unsupervisable {
  readonly reason: string;
}

/**
 * The conversation a supervised launch starts with, from the arguments claude will receive: a `--resume <id>` keeps its id, `--continue` is pinned to the id of the working directory's latest conversation (`latestId`, undefined when it has none), and no conversation argument starts a new one under `newId`. A conversation picker, a print run, or a `--continue` with nothing to continue cannot be supervised, because no conversation id is known to resume under another account.
 */
export function initialConversationOf(passthrough: readonly string[], context: { readonly newId: () => string; readonly latestId: () => string | undefined }): InitialConversation | Unsupervisable {
  if (isPrintRun(passthrough)) {
    return { reason: "a print run ends by itself" };
  }
  const target = resumeTargetOf(passthrough);
  if (target?.kind === "id") {
    return CONVERSATION_ID_RE.test(target.id) ? { sessionId: target.id, conversation: "as-given" } : { reason: "the conversation id is not a plain identifier" };
  }
  if (target?.kind === "latest") {
    const latest = context.latestId();
    if (latest === undefined) {
      return { reason: "there is no conversation in this directory to continue" };
    }
    return CONVERSATION_ID_RE.test(latest) ? { sessionId: latest, conversation: "resume" } : { reason: "the latest conversation's id is not a plain identifier" };
  }
  if (opensPicker(passthrough)) {
    return { reason: "the conversation picker names no conversation until one is chosen" };
  }
  return { sessionId: context.newId(), conversation: "start" };
}
