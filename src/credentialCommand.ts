import type { Command } from "commander";

import { withExamples, type CommandDeps } from "./cli/commandDeps";
import { UsageError } from "./cliError";
import { describeCredential } from "./credential";
import { IdentityNotFoundError, readIdentity, setIdentityCredential } from "./identityManager";
import { storeIdentityToken } from "./identityToken";

/** Reads all of standard input as UTF-8 text. */
async function readStandardInput(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Registers `claude-use credential`: operations on the credentials identities authenticate with, as opposed to the `identity` noun's configuration of them. `store <identity>` reads a `claude setup-token` token from standard input (never an argument, which would land in shell history and the process list), keeps it at mode 0600 outside every identity's farm, and makes it the identity's `oauthToken` credential.
 */
export function registerCredentialCommand(program: Command, deps: CommandDeps): void {
  const credential = withExamples(program.command("credential").description("Manage the credentials identities authenticate with."), [
    "claude-use credential store work < token.txt",
  ]);

  withExamples(
    credential
      .command("store <identity>")
      .description("Store a `claude setup-token` token for an identity and make it that identity's credential. The token is read from standard input and never printed.")
      .action(async (name: string) => {
        if (readIdentity(deps.paths, name) === undefined) {
          throw new IdentityNotFoundError(name);
        }
        if (deps.isInteractive()) {
          throw new UsageError("Pass the token on standard input, so it never lands in your shell history: run `claude setup-token`, then pipe or redirect its token into this command.");
        }
        const stored = storeIdentityToken(deps.paths, name, await readStandardInput());
        const updated = setIdentityCredential(deps.paths, name, { sources: [{ file: stored }], target: "oauthToken" });
        if (updated.credential !== undefined) {
          console.log(`Identity "${name}" now authenticates with credential ${describeCredential(updated.credential)}.`);
        }
      }),
    ["pbpaste | claude-use credential store work", "claude-use credential store work < token.txt"],
  );
}
