import type { Command } from "commander";
import { UsageError } from "./cliError";

/**
 * Registers `agent-shim run [args...]`, forwarding every argument to `handler` exactly as typed. Kept in its own module, separate from `src/program.ts`'s `buildProgram`, so its Commander parsing behaviour (in particular, preserving a literal `--` inside the forwarded args rather than losing it) is testable in isolation.
 */
export function registerRunCommand(program: Command, handler: (args: readonly string[]) => Promise<void>, codexHandler?: (args: readonly string[]) => Promise<void>): void {
  program
    .command("run")
    .description(
      "Launch Claude Code or, with a leading --agent codex, Codex under an identity, without needing a `claude`-named binary on PATH. " +
        "Launch flags (see `agent-shim --help`) are consumed first; native arguments are forwarded to the selected CLI.",
    )
    .allowUnknownOption()
    // Without this, Commander treats a literal `--` inside the forwarded args as its own end-of-options marker and strips it before it reaches `args`, so a downstream flag meant to be shielded from parsing (e.g. `claude mcp add name -- npx -y pkg`) arrives at the real `claude` binary with no `--` at all, and its own Commander parser then rejects the bare `-y` as an unknown option of its own. `passThroughOptions` makes Commander forward every token after the first one verbatim, `--` included. It requires the parent program to have already called `enablePositionalOptions()`, which `buildProgram` does.
    .passThroughOptions()
    .helpOption(false)
    .argument("[args...]", "Arguments to forward, e.g. @<name>, --config-profile <name>, or any native CLI flag.")
    .action(async (args: readonly string[]) => {
      if (args[0] === "--agent" || args[0]?.startsWith("--agent=") === true) {
        const inline = args[0].startsWith("--agent=");
        const agent = inline ? args[0].slice("--agent=".length) : args[1];
        const forwarded = args.slice(inline ? 1 : 2);
        if (agent === "claude") return handler(forwarded);
        if (agent === "codex" && codexHandler !== undefined) return codexHandler(forwarded);
        throw new UsageError("--agent requires claude or codex, and must immediately follow run.");
      }
      return handler(args);
    });
}
