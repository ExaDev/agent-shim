import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";

import { registerRunCommand } from "./runCommand";

/** Mirrors how `buildProgram` sets up its parent program before registering `run`: `passThroughOptions` on the `run` subcommand requires `enablePositionalOptions` on the parent chain, so a test program needs the same setup to exercise the real behaviour rather than commander's unrelated "broken pass-through" guard error. */
function buildTestProgram(): Command {
  return new Command().exitOverride().enablePositionalOptions();
}

describe("registerRunCommand", () => {
  it("preserves a literal -- inside the forwarded args", async () => {
    const handler = vi.fn<(args: readonly string[]) => Promise<void>>().mockResolvedValue(undefined);
    const program = buildTestProgram();
    registerRunCommand(program, handler);

    await program.parseAsync(["run", "mcp", "add", "agent-comms", "--", "npx", "-y", "agent-comms", "bridge", "mcp"], {
      from: "user",
    });

    expect(handler).toHaveBeenCalledWith(["mcp", "add", "agent-comms", "--", "npx", "-y", "agent-comms", "bridge", "mcp"]);
  });

  it("forwards a flag with no -- unchanged", async () => {
    const handler = vi.fn<(args: readonly string[]) => Promise<void>>().mockResolvedValue(undefined);
    const program = buildTestProgram();
    registerRunCommand(program, handler);

    await program.parseAsync(["run", "--config-profile", "work", "@myid"], { from: "user" });

    expect(handler).toHaveBeenCalledWith(["--config-profile", "work", "@myid"]);
  });

  it("forwards an empty args list when nothing follows run", async () => {
    const handler = vi.fn<(args: readonly string[]) => Promise<void>>().mockResolvedValue(undefined);
    const program = buildTestProgram();
    registerRunCommand(program, handler);

    await program.parseAsync(["run"], { from: "user" });

    expect(handler).toHaveBeenCalledWith([]);
  });
});
