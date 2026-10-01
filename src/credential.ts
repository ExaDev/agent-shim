import type { Credential, CredentialSource, CredentialTarget, CredentialTargetVar } from "./config/schema";
import { effectiveStore, isFresh, type CredentialCachePort } from "./credentialCache";

/** The exit status for a launch whose selected provider or identity has a credential block none of whose sources yields a token: 64, the conventional `EX_USAGE`, because the invocation asked for a credential the environment cannot supply. */
export const CREDENTIAL_UNAVAILABLE_EXIT = 64;

/** How long a non-interactive credential command may run. Secret-store CLIs answer from a local cache or agent well within a second, so this leaves a wide margin while still failing a wedged command quickly instead of stalling the launch. */
export const CREDENTIAL_COMMAND_TIMEOUT_MS = 10_000;

/** How long an interactive credential command may run: long enough for a person to notice and approve a biometric or password prompt, short enough that a prompt nobody is watching fails the launch rather than hanging it. */
export const CREDENTIAL_INTERACTIVE_TIMEOUT_MS = 120_000;

/** The permission bits for group and others. A secret file with any of them set is readable or writable by someone other than its owner. */
const GROUP_OTHER_PERMISSION_BITS = 0o077;

/** The permission bits of a mode, without the file-type bits, for printing as the familiar three octal digits. */
const PERMISSION_BITS = 0o777;

/** Permission bits are conventionally written in octal. */
const OCTAL_RADIX = 8;

/** What reading one `file` source found: nothing at that path, or its contents and permission bits. `mode` is undefined on a platform with no POSIX permission bits (Windows), where the looseness check cannot apply. */
type SecretFileRead =
  | { readonly found: false }
  | { readonly found: true; readonly content: string; readonly mode: number | undefined };

/** The outcome of one credential command. `stderr` is empty for an interactive run, whose stderr goes to the terminal so a person sees any prompt. */
export interface CredentialCommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

/**
 * Everything resolving a credential needs from the outside world, injected so the resolver (and every launcher test) runs without `op`, the Keychain, real secret files or a terminal. `src/realPorts.ts` wires the real one; tests wire a fake.
 */
export interface CredentialPort {
  /** Reads a `file` source's path (absolute or `~`-rooted). */
  readonly readSecretFile: (filePath: string) => SecretFileRead;
  /** Runs a command source's argv directly (no shell) under a timeout, capturing stdout. An interactive run inherits the terminal's stdin and stderr so a person can answer a prompt. */
  readonly runCommand: (
    argv: readonly [string, ...string[]],
    options: { readonly timeoutMs: number; readonly interactive: boolean },
  ) => CredentialCommandResult;
  /** Whether a person can answer a prompt now: standard input is a terminal, or there is a desktop session to show a dialog in. */
  readonly personPresent: () => boolean;
  /** Where cached credentials live, used only for a credential block that asks for caching. Omit to resolve every launch from the sources. */
  readonly cache?: CredentialCacheEnv;
}

/** The sources that run a command: `command` itself and the two presets that compile to one. */
type CommandBackedSource = Extract<CredentialSource, { readonly command: unknown } | { readonly op: unknown } | { readonly keychain: unknown }>;

/**
 * The argv a command-backed source runs, with the `op` and `keychain` presets compiled to theirs: `op read <ref>` and `security find-generic-password -s <service> [-a <account>] -w`.
 */
export function commandArgv(source: CommandBackedSource): readonly [string, ...string[]] {
  if ("command" in source) {
    return source.command;
  }
  if ("op" in source) {
    return ["op", "read", source.op];
  }
  const account = source.keychain.account;
  return ["security", "find-generic-password", "-s", source.keychain.service, ...(account === undefined ? [] : ["-a", account]), "-w"];
}

/**
 * Whether a source needs a person present. An explicit `interactive` always wins. Otherwise only `op` defaults to interactive, because the desktop app's integration asks for approval, unless `OP_SERVICE_ACCOUNT_TOKEN` is set, in which case `op` authenticates as the service account with nobody asked. A plain `command` and a `keychain` read default to non-interactive: a Keychain item whose access list already trusts `security` reads silently, and one that does not fails at once with "User interaction is not allowed" rather than hanging.
 */
export function isInteractiveSource(source: CredentialSource, env: Readonly<Record<string, string | undefined>>): boolean {
  if ("command" in source || "keychain" in source) {
    return source.interactive ?? false;
  }
  if ("op" in source) {
    return source.interactive ?? (env.OP_SERVICE_ACCOUNT_TOKEN ?? "") === "";
  }
  return false;
}

/** One source as `check`, `doctor` and every `--json` output report it: its kind plus the same non-secret identifying detail `describeSource` prints. */
type CredentialSourceSummary =
  | { readonly kind: "env"; readonly variable: string }
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "command"; readonly program: string }
  | { readonly kind: "op"; readonly reference: string }
  | { readonly kind: "keychain"; readonly service: string; readonly account?: string }
  | { readonly kind: "literal" };

/** A credential block as it is reported: its effective target and each source's summary, in order. */
export interface CredentialSummary {
  readonly target: CredentialTarget;
  readonly sources: readonly CredentialSourceSummary[];
  /** The block's cache setting when it asks for caching: how long a token is kept (absent for no expiry) and where. */
  readonly cache?: { readonly ttl?: string; readonly store?: string };
}

function summariseSource(source: CredentialSource): CredentialSourceSummary {
  if ("env" in source) {
    return { kind: "env", variable: source.env };
  }
  if ("file" in source) {
    return { kind: "file", path: source.file };
  }
  if ("command" in source) {
    return { kind: "command", program: source.command[0] };
  }
  if ("op" in source) {
    return { kind: "op", reference: source.op };
  }
  if ("keychain" in source) {
    return {
      kind: "keychain",
      service: source.keychain.service,
      ...(source.keychain.account === undefined ? {} : { account: source.keychain.account }),
    };
  }
  return { kind: "literal" };
}

/** Summarises a credential block for reporting, with `target` resolved to its default. */
export function summariseCredential(credential: Credential): CredentialSummary {
  return {
    target: credential.target ?? "bearer",
    sources: credential.sources.map(summariseSource),
    ...(credential.cache === undefined ? {} : { cache: credential.cache }),
  };
}

/** Renders a source summary for a message: its kind and the non-secret detail that identifies it (a variable name, a path, a program, a reference, a Keychain service). Never a token, and never a `literal` source's value. */
function formatSourceSummary(summary: CredentialSourceSummary): string {
  switch (summary.kind) {
    case "env":
      return `env ${summary.variable}`;
    case "file":
      return `file ${summary.path}`;
    case "command":
      return `command ${summary.program}`;
    case "op":
      return `op ${summary.reference}`;
    case "keychain":
      return `keychain ${summary.service}${summary.account === undefined ? "" : ` (account ${summary.account})`}`;
    case "literal":
      return "literal (non-secret placeholder)";
    default:
      return summary satisfies never;
  }
}

/** Renders a source for a message, as `formatSourceSummary` does its summary. */
export function describeSource(source: CredentialSource): string {
  return formatSourceSummary(summariseSource(source));
}

/** Renders a credential summary on one line for human-readable output: `bearer from env Z_API_TOKEN, then op op://...`. */
export function formatCredentialSummary(summary: CredentialSummary): string {
  const cache = summary.cache === undefined ? "" : `, cached ${summary.cache.ttl === undefined ? "with no expiry" : `for ${summary.cache.ttl}`}${summary.cache.store === undefined ? "" : ` in the ${summary.cache.store} store`}`;
  return `${summary.target} from ${summary.sources.map(formatSourceSummary).join(", then ")}${cache}`;
}

/** Renders a credential block on one line, as `formatCredentialSummary` does its summary. */
export function describeCredential(credential: Credential): string {
  return formatCredentialSummary(summariseCredential(credential));
}

/** The outcome of trying one source: its token, or why it yielded none. `warn` marks a reason worth reporting even when a later source succeeds. */
type SourceOutcome =
  | { readonly ok: true; readonly token: string }
  | { readonly ok: false; readonly reason: string; readonly warn: boolean };

/** Inputs to `resolveCredential`. */
export interface ResolveCredentialParams {
  readonly credential: Credential;
  /** The launching environment: where `env` sources are read, and what decides whether `op` is interactive. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly port: CredentialPort;
  /** What the credential belongs to, for messages and as its cache key: `provider z` or `identity work`. */
  readonly subject: string;
  /** True to skip a cached token and fetch from the sources, replacing the cached copy: what `credential warm` does. */
  readonly refresh?: boolean;
}

/** What caching a credential needs beyond the block's own `cache` setting: the port holding entries, the platform that picks the default store, and the clock the TTL is measured on. */
export interface CredentialCacheEnv {
  readonly port: CredentialCachePort;
  readonly platform: NodeJS.Platform;
  readonly now: () => number;
}

/** A resolved credential: the token, where it goes, and which source produced it. `warnings` carries any source refused on the way for a reason worth reporting (a secret file with loose permissions). */
export interface ResolvedCredential {
  readonly target: CredentialTarget;
  readonly token: string;
  readonly source: CredentialSource;
  readonly warnings: readonly string[];
  /** When the token was fetched, if it came from the cache rather than a source; undefined for a live fetch. */
  readonly cachedAt?: number;
}

/** The outcome of `resolveCredential`: a resolved credential, or a message naming every source and why none yielded a token. */
export type CredentialResolution =
  | { readonly ok: true; readonly credential: ResolvedCredential }
  | { readonly ok: false; readonly message: string };

function trySource(source: CredentialSource, params: ResolveCredentialParams): SourceOutcome {
  const none = (reason: string, warn = false): SourceOutcome => ({ ok: false, reason, warn });

  if ("env" in source) {
    const value = params.env[source.env];
    return value === undefined || value === "" ? none("is unset or empty") : { ok: true, token: value };
  }
  if ("literal" in source) {
    return { ok: true, token: source.literal };
  }
  if ("file" in source) {
    const read = params.port.readSecretFile(source.file);
    if (!read.found) {
      return none("does not exist");
    }
    if (read.mode !== undefined && (read.mode & GROUP_OTHER_PERMISSION_BITS) !== 0) {
      return none(
        `is readable or writable by group or others (mode ${(read.mode & PERMISSION_BITS).toString(OCTAL_RADIX)}); run \`chmod 600 ${source.file}\``,
        true,
      );
    }
    const token = read.content.trim();
    return token === "" ? none("is empty") : { ok: true, token };
  }

  const argv = commandArgv(source);
  const interactive = isInteractiveSource(source, params.env);
  if (interactive && !params.port.personPresent()) {
    return none("needs a person to approve it, but there is no terminal or desktop session");
  }
  const timeoutMs = source.timeoutMs ?? (interactive ? CREDENTIAL_INTERACTIVE_TIMEOUT_MS : CREDENTIAL_COMMAND_TIMEOUT_MS);
  const result = params.port.runCommand(argv, { timeoutMs, interactive });
  if (result.timedOut) {
    return none(`timed out after ${String(timeoutMs)}ms`);
  }
  if (result.status !== 0) {
    // Never stdout, which would be the credential: the exit status and stderr, which is where a well-behaved secret tool explains itself.
    const stderr = result.stderr.trim();
    const outcome = result.status === null ? "could not be run or was killed by a signal" : `exited with status ${String(result.status)}`;
    return none(`${outcome}${stderr === "" ? "" : `: ${stderr}`}`);
  }
  const token = result.stdout.trim();
  return token === "" ? none("printed no token") : { ok: true, token };
}

/** The `claude-use credential warm` invocation that refills the cache for a subject such as `identity work` or `provider z`. */
function warmCommandFor(subject: string): string {
  const [kind, name] = subject.split(" ");
  return kind === "provider" ? `claude-use credential warm --provider ${name ?? ""}` : `claude-use credential warm ${name ?? ""}`;
}

/**
 * Resolves a credential block: a fresh cached token if the block caches one, else tries each source in order and returns the first non-empty token, with the block's target, storing it when the block caches. When none yields one, the message names every source and why, and never a value; for a caching block it also names the command that fills the cache from a terminal. Pure over its injected ports.
 */
export function resolveCredential(params: ResolveCredentialParams): CredentialResolution {
  const target = params.credential.target ?? "bearer";
  const cacheBlock = params.credential.cache;
  const cache = cacheBlock === undefined ? undefined : params.port.cache;
  const store = cacheBlock === undefined || cache === undefined ? undefined : effectiveStore(cacheBlock, cache.platform);
  if (cacheBlock !== undefined && cache !== undefined && store !== undefined && params.refresh !== true) {
    const entry = cache.port.read(store, params.subject);
    if (entry !== undefined && isFresh(entry, cacheBlock, cache.now())) {
      return { ok: true, credential: { target, token: entry.token, source: entry.source, warnings: [], cachedAt: entry.fetchedAt } };
    }
  }
  const attempts: string[] = [];
  const warnings: string[] = [];
  for (const source of params.credential.sources) {
    const outcome = trySource(source, params);
    if (outcome.ok) {
      if (cache !== undefined && store !== undefined) {
        cache.port.write(store, params.subject, { token: outcome.token, fetchedAt: cache.now(), source });
      }
      return { ok: true, credential: { target, token: outcome.token, source, warnings } };
    }
    const line = `${describeSource(source)} ${outcome.reason}`;
    attempts.push(line);
    if (outcome.warn) {
      warnings.push(`claude-use: ${params.subject}: skipped ${line}`);
    }
  }
  const hint = cacheBlock === undefined ? "" : `; fill the cache from a terminal with \`${warmCommandFor(params.subject)}\``;
  return { ok: false, message: `claude-use: ${params.subject} has no usable credential: ${attempts.join("; ")}${hint}` };
}

/**
 * The credential variables a child environment gets for a resolved token: the target's variable set to the token, and the other two set to undefined so that merging this over an environment removes them, and an ambient one inherited from the parent can neither outrank nor sit alongside the credential claude-use chose. Removing a variable (rather than setting it to the empty string) leaves nothing for Claude Code to interpret.
 */
export function credentialVariables(target: CredentialTarget, token: string): Record<CredentialTargetVar, string | undefined> {
  return {
    ANTHROPIC_AUTH_TOKEN: target === "bearer" ? token : undefined,
    ANTHROPIC_API_KEY: target === "apiKey" ? token : undefined,
    CLAUDE_CODE_OAUTH_TOKEN: target === "oauthToken" ? token : undefined,
  };
}
