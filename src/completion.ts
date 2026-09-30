import { Help, type Command } from "commander";

import { UsageError } from "./cliError";
import { LAUNCHER_FLAG_NAMES } from "./launcher/argv";

/** The shells `claude-use completion` can generate a script for. */
const COMPLETION_SHELLS = ["bash", "zsh", "fish"] as const;
type CompletionShell = (typeof COMPLETION_SHELLS)[number];

/** One word a shell may offer at some point on the command line: a subcommand or a flag, with its one-line description. */
interface CompletionWord {
  readonly word: string;
  readonly description: string;
}

/** One reachable command in the tree, identified by its path from the root (`root/identity/add`). */
interface CompletionNode {
  readonly id: string;
  readonly words: readonly CompletionWord[];
  /** Subcommand name to the child node's id. */
  readonly children: ReadonlyMap<string, string>;
}

/** The first sentence of a command or option description: what fits a completion menu. */
function firstSentence(text: string): string {
  const end = text.search(/\.(\s|$)/);
  return end === -1 ? text : text.slice(0, end);
}

/**
 * Flattens `program`'s visible command tree into completion nodes, reading it through Commander's own `Help` visibility rules so hidden commands (`__headroom-supervisor`) never appear. `run` gets the launcher's own flags, since Commander forwards its arguments untouched and so knows none of them.
 */
function collectNodes(program: Command): CompletionNode[] {
  const help = new Help();
  const nodes: CompletionNode[] = [];
  const visit = (command: Command, id: string): void => {
    const subcommands = help.visibleCommands(command).filter((sub) => sub.name() !== "help");
    const children = new Map(subcommands.map((sub) => [sub.name(), `${id}/${sub.name()}`]));
    const optionWords: CompletionWord[] =
      command.name() === "run" && id !== "root"
        ? LAUNCHER_FLAG_NAMES.map((flag) => ({ word: flag, description: "claude-use launch flag" }))
        : help
            .visibleOptions(command)
            .flatMap((option) => (option.long === undefined ? [] : [{ word: option.long, description: firstSentence(option.description) }]));
    nodes.push({
      id,
      words: [...subcommands.map((sub) => ({ word: sub.name(), description: firstSentence(sub.description()) })), ...optionWords],
      children,
    });
    for (const sub of subcommands) {
      visit(sub, `${id}/${sub.name()}`);
    }
  };
  visit(program, "root");
  return nodes;
}

/** Quotes `text` for a POSIX-style shell single-quoted string (bash, zsh). */
function singleQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/** Quotes `text` for a fish single-quoted string, where only `\` and `'` need escaping. */
function fishQuote(text: string): string {
  return `'${text.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

/** The `case` arms, shared by bash and zsh, that walk from one node to a child as each completed word is read. */
function transitionArms(nodes: readonly CompletionNode[], indent: string): string {
  return nodes
    .flatMap((node) => [...node.children].map(([name, child]) => `${indent}${singleQuote(`${node.id}:${name}`)}) node=${singleQuote(child)} ;;`))
    .join("\n");
}

function bashScript(nodes: readonly CompletionNode[]): string {
  const arms = nodes
    .map((node) => `    ${singleQuote(node.id)}) candidates=${singleQuote(node.words.map((word) => word.word).join(" "))} ;;`)
    .join("\n");
  return `# claude-use bash completion. Load with: source <(claude-use completion bash)
_claude_use() {
  local cur="\${COMP_WORDS[COMP_CWORD]}" node=root candidates="" i
  for ((i = 1; i < COMP_CWORD; i++)); do
    case "\${node}:\${COMP_WORDS[i]}" in
${transitionArms(nodes, "      ")}
    esac
  done
  case "\${node}" in
${arms}
  esac
  COMPREPLY=($(compgen -W "\${candidates}" -- "\${cur}"))
}
complete -o default -F _claude_use claude-use
`;
}

function zshScript(nodes: readonly CompletionNode[]): string {
  const arms = nodes
    .map((node) => {
      const entries = node.words.map((word) => singleQuote(`${word.word}:${word.description.replaceAll(":", "\\:")}`)).join(" ");
      return `    ${singleQuote(node.id)}) candidates=(${entries}) ;;`;
    })
    .join("\n");
  return `#compdef claude-use
# claude-use zsh completion. Load with: source <(claude-use completion zsh), after compinit.
_claude_use() {
  local node=root word
  local -a candidates
  for word in "\${(@)words[2,CURRENT-1]}"; do
    case "\${node}:\${word}" in
${transitionArms(nodes, "      ")}
    esac
  done
  case "\${node}" in
${arms}
  esac
  _describe -t commands 'claude-use' candidates
}
if [ "\${funcstack[1]}" = "_claude_use" ]; then
  _claude_use "$@"
else
  compdef _claude_use claude-use
fi
`;
}

function fishScript(nodes: readonly CompletionNode[]): string {
  const transitions = nodes
    .flatMap((node) =>
      [...node.children].map(([name, child]) => `            case ${fishQuote(`${node.id}:${name}`)}\n                set node ${fishQuote(child)}`),
    )
    .join("\n");
  const completions = nodes
    .flatMap((node) =>
      node.words.map((word) => {
        const condition = fishQuote(`test (__claude_use_node) = ${node.id}`);
        const target = word.word.startsWith("--") ? `-l ${fishQuote(word.word.slice(2))}` : `-a ${fishQuote(word.word)}`;
        return `complete -c claude-use -n ${condition} ${target} -d ${fishQuote(word.description)}`;
      }),
    )
    .join("\n");
  return `# claude-use fish completion. Load with: claude-use completion fish | source
function __claude_use_node
    set -l node root
    for word in (commandline -opc)[2..-1]
        switch "$node:$word"
${transitions}
        end
    end
    echo $node
end
complete -c claude-use -f
${completions}
`;
}

/** Raised when `claude-use completion` is asked for a shell it cannot generate a script for. */
export class UnsupportedShellError extends UsageError {
  constructor(readonly shell: string) {
    super(`Unsupported shell "${shell}". Supported shells: ${COMPLETION_SHELLS.join(", ")}.`);
    this.name = "UnsupportedShellError";
  }
}

function isCompletionShell(value: string): value is CompletionShell {
  return COMPLETION_SHELLS.some((shell) => shell === value);
}

/**
 * Generates the completion script for `shell` from `program`'s own command tree, so completion can never drift from the commands and options that actually exist. The script completes subcommands and long options at every level, and the launcher's own flags after `run`; it does not complete argument values such as identity names.
 */
function generateCompletion(program: Command, shell: CompletionShell): string {
  const nodes = collectNodes(program);
  switch (shell) {
    case "bash":
      return bashScript(nodes);
    case "zsh":
      return zshScript(nodes);
    case "fish":
      return fishScript(nodes);
    default:
      return shell satisfies never;
  }
}

/** Registers `claude-use completion <shell>` onto `program`. Register it last, since the script covers whatever the tree holds at the moment it runs. */
export function registerCompletionCommand(program: Command): void {
  program
    .command("completion")
    .description("Print a shell completion script for bash, zsh or fish.")
    .argument("<shell>", `The shell to generate a script for: ${COMPLETION_SHELLS.join(", ")}.`)
    .action((shell: string) => {
      if (!isCompletionShell(shell)) {
        throw new UnsupportedShellError(shell);
      }
      process.stdout.write(generateCompletion(program, shell));
    })
    .addHelpText(
      "after",
      "\nExamples:\n  $ source <(claude-use completion bash)   # in ~/.bashrc\n  $ source <(claude-use completion zsh)    # in ~/.zshrc, after compinit\n  $ claude-use completion fish | source    # in ~/.config/fish/config.fish",
    );
}
