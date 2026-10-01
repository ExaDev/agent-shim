import { spawnSync } from "node:child_process";

import type { Command } from "commander";

import { withExamples, type CommandDeps } from "./cli/commandDeps";
import { CliError, EXIT_FAILURE, UsageError } from "./cliError";
import type { Credential } from "./config/schema";
import { CREDENTIAL_UNAVAILABLE_EXIT, describeCredential, resolveCredential, type CredentialPort } from "./credential";
import { effectiveStore, ttlMs, type CredentialCachePort } from "./credentialCache";
import { IdentityNotFoundError, readIdentity, setIdentityCredential } from "./identityManager";
import { storeIdentityToken } from "./identityToken";
import { ProviderNotFoundError, readProvider } from "./providers";
import { realCredentialPort } from "./realPorts";
import { cacheFileNameFor, createRealCredentialCache } from "./realCredentialCache";

/** Reads all of standard input as UTF-8 text. */
async function readStandardInput(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** A credential command that could not finish: a missing credential block, a cache that is not enabled, a failed `ssh`. Exits 1, or `CREDENTIAL_UNAVAILABLE_EXIT` when no source yields a token. */
class CredentialCommandError extends CliError {
  override readonly exitCode: number;

  constructor(message: string, exitCode: number = EXIT_FAILURE) {
    super(message);
    this.name = "CredentialCommandError";
    this.exitCode = exitCode;
  }
}

/** Everything the cache commands touch outside the config tree, injected so tests need neither the Keychain, `op` nor `ssh`. */
export interface CredentialCommandPorts {
  readonly credentials: CredentialPort;
  readonly cache: CredentialCachePort;
  readonly platform: NodeJS.Platform;
  readonly now: () => number;
  /** Runs `remoteCommand` on `host` over SSH with `input` on its standard input, returning the exit status. */
  readonly ssh: (host: string, remoteCommand: string, input: string) => number | null;
}

function realCommandPorts(deps: CommandDeps): CredentialCommandPorts {
  return {
    credentials: realCredentialPort,
    cache: createRealCredentialCache(deps.paths.root),
    platform: process.platform,
    now: () => Date.now(),
    ssh: (host, remoteCommand, input) => spawnSync("ssh", ["--", host, remoteCommand], { input, stdio: ["pipe", "inherit", "inherit"] }).status,
  };
}

/** A host as `ssh` takes it: letters, digits and `.`, `_`, `@`, `:`, `-`, never leading with `-` (which `ssh` would read as an option). */
const SSH_HOST_RE = /^[A-Za-z0-9._@:][A-Za-z0-9._@:-]*$/;

interface Subject {
  readonly name: string;
  readonly subject: string;
  readonly credential: Credential;
}

/** The identity's or, with `--provider`, the provider's credential block, or a `CliError` saying what is missing. */
function credentialSubject(deps: CommandDeps, name: string, asProvider: boolean): Subject {
  if (asProvider) {
    const provider = readProvider(deps.paths, name);
    if (provider === undefined) {
      throw new ProviderNotFoundError(name);
    }
    return { name, subject: `provider ${name}`, credential: provider.credential };
  }
  const identity = readIdentity(deps.paths, name);
  if (identity === undefined) {
    throw new IdentityNotFoundError(name);
  }
  if (identity.credential === undefined) {
    throw new CredentialCommandError(`Identity "${name}" has no credential block to cache; it uses its stored login. Give it one with \`claude-use identity set ${name} --credential ...\`.`);
  }
  return { name, subject: `identity ${name}`, credential: identity.credential };
}

function requireCaching(subject: Subject): NonNullable<Credential["cache"]> {
  const cache = subject.credential.cache;
  if (cache === undefined) {
    const flag = subject.subject.startsWith("provider") ? `provider set ${subject.name}` : `identity set ${subject.name}`;
    throw new CredentialCommandError(`The credential for ${subject.subject} is not cached. Turn caching on with \`claude-use ${flag} --credential-cache-ttl 12h\` (or --credential-cache for no expiry).`);
  }
  return cache;
}

/**
 * Registers `claude-use credential`: operations on the credentials identities authenticate with, as opposed to the `identity` noun's configuration of them. `store <identity>` reads a `claude setup-token` token from standard input (never an argument, which would land in shell history and the process list), keeps it at mode 0600 outside every identity's farm, and makes it the identity's `oauthToken` credential.
 */
export function registerCredentialCommand(program: Command, deps: CommandDeps, ports: CredentialCommandPorts = realCommandPorts(deps)): void {
  const credential = withExamples(program.command("credential").description("Manage the credentials identities authenticate with."), [
    "claude-use credential store work < token.txt",
    "claude-use credential warm work",
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

  withExamples(
    credential
      .command("warm [identity]")
      .description("Fetch an identity's or provider's credential from its sources now, prompting if a source needs a person, and fill its cache so later launches need no prompt. Never prints the token.")
      .option("--provider <name>", "Warm a provider's credential instead of an identity's.")
      .action((name: string | undefined, options: Readonly<{ provider?: string }>) => {
        const subject = credentialSubject(deps, subjectName(name, options.provider), options.provider !== undefined);
        const block = requireCaching(subject);
        const resolution = resolveCredential({ credential: subject.credential, env: process.env, port: { ...ports.credentials, cache: { port: ports.cache, platform: ports.platform, now: ports.now } }, subject: subject.subject, refresh: true });
        if (!resolution.ok) {
          throw new CredentialCommandError(resolution.message, CREDENTIAL_UNAVAILABLE_EXIT);
        }
        const limit = ttlMs(block);
        console.log(
          `Cached the credential for ${subject.subject} in the ${effectiveStore(block, ports.platform)} store (${limit === undefined ? "no expiry" : `expires after ${block.ttl ?? ""}`}).`,
        );
      }),
    ["claude-use credential warm work", "claude-use credential warm --provider z"],
  );

  withExamples(
    credential
      .command("forget [identity]")
      .description("Remove an identity's or provider's cached credential from every store. The next launch fetches from the sources again.")
      .option("--provider <name>", "Forget a provider's credential instead of an identity's.")
      .action((name: string | undefined, options: Readonly<{ provider?: string }>) => {
        const subject = credentialSubject(deps, subjectName(name, options.provider), options.provider !== undefined);
        ports.cache.remove("file", subject.subject);
        if (ports.platform === "darwin") {
          ports.cache.remove("keychain", subject.subject);
        }
        console.log(`Removed the cached credential for ${subject.subject}.`);
      }),
    ["claude-use credential forget work", "claude-use credential forget --provider z"],
  );

  withExamples(
    credential
      .command("push <identity> <host>")
      .description("Read an identity's credential here and write it to the credential cache on another host over SSH (mode 0600, token on standard input), so that host needs no 1Password. The identity must cache with the file store on that host.")
      .option("--provider <name>", "Push a provider's credential instead; <identity> is then ignored.")
      .action((name: string, host: string, options: Readonly<{ provider?: string }>) => {
        if (!SSH_HOST_RE.test(host)) {
          throw new UsageError(`"${host}" is not a host ssh can take.`);
        }
        const subject = credentialSubject(deps, subjectName(name, options.provider), options.provider !== undefined);
        requireCaching(subject);
        const resolution = resolveCredential({ credential: subject.credential, env: process.env, port: { ...ports.credentials, cache: { port: ports.cache, platform: ports.platform, now: ports.now } }, subject: subject.subject });
        if (!resolution.ok) {
          throw new CredentialCommandError(resolution.message, CREDENTIAL_UNAVAILABLE_EXIT);
        }
        const entry = JSON.stringify({ token: resolution.credential.token, fetchedAt: resolution.credential.cachedAt ?? ports.now(), source: resolution.credential.source });
        const remoteFile = `"\${CLAUDE_USE_HOME:-$HOME/.claude-use}/credential-cache/${cacheFileNameFor(subject.subject)}"`;
        const remoteDir = `"\${CLAUDE_USE_HOME:-$HOME/.claude-use}/credential-cache"`;
        const status = ports.ssh(host, `umask 077 && mkdir -p ${remoteDir} && cat > ${remoteFile}`, entry);
        if (status !== 0) {
          throw new CredentialCommandError(`Could not write the credential cache for ${subject.subject} on ${host} (ssh exited ${status === null ? "without a status" : String(status)}).`);
        }
        console.log(`Wrote the credential for ${subject.subject} to ${host}. There, set the credential's cache store to file: \`claude-use ${subject.subject.startsWith("provider") ? "provider" : "identity"} set ${subject.name} --credential-cache-store file\`.`);
      }),
    ["claude-use credential push work build-host", "claude-use credential push x build-host --provider z"],
  );
}

/** The subject's name: `--provider`'s value when given, else the positional, else a usage error. */
function subjectName(positional: string | undefined, provider: string | undefined): string {
  const name = provider ?? positional;
  if (name === undefined) {
    throw new UsageError("Name an identity, or pass --provider <name>.");
  }
  return name;
}
