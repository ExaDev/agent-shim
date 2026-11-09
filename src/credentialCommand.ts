
import { sameFile } from "./fileIdentity";
import { FILE_NAME_CHARS, FILE_NAME_FIRST_CHARS, FILE_NAME_RULE, InvalidProviderNameError, isFileName, isStoredName, MAX_NAME_BYTES } from "./config/names";
import type { Command } from "commander";
import fs from "node:fs";
import path from "node:path";

import { withExamples, type CommandDeps } from "./cli/commandDeps";
import { CliError, EXIT_FAILURE, UsageError } from "./cliError";
import { isRouterProvider, type Credential } from "./config/schema";
import { CREDENTIAL_UNAVAILABLE_EXIT, describeCredential, identityCacheKey, resolveCredential, type CredentialPort } from "./credential";
import { CachedCredentialSchema, effectiveStore, ttlMs, type CredentialCachePort } from "./credentialCache";
import { identityIdOf, identityNotFound, identityRecords, readIdentityById, requireStoredIdentityId, setIdentityCredential } from "./identityStore";
import { DuplicateIdentityNameError } from "./identityRecords";
import { IdentityNamesLockBusyError, nonWaitingIdentityNamesLockPorts, realIdentityNamesLockPorts, withIdentityNamesLock } from "./identityNamesLock";
import { storeIdentityToken } from "./identityToken";
import { ProviderNotFoundError, readProvider } from "./providersStore";
import { realCredentialPort } from "./realPorts";
import { cacheFileNameFor, createRealCredentialCache, identityEntryAfterOwner, serialisedFor, sharesCacheFile } from "./realCredentialCache";
import { spawnSyncBlocking } from "./blockingSpawn";
import { shellQuoted } from "./shellQuote";

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
  /** Runs `remoteCommand` on `host` over SSH with `input` on its standard input, returning the exit status (null when it ended without one) and what it wrote to standard output, which a refusal of the remote push script uses to say what it found there. */
  readonly ssh: (host: string, remoteCommand: string, input: string) => { readonly status: number | null; readonly stdout: string };
  /** Reads all of standard input as UTF-8 text: where `credential store` takes its token from. */
  readonly readInput: () => Promise<string>;
}

function realCommandPorts(deps: CommandDeps): CredentialCommandPorts {
  return {
    credentials: realCredentialPort,
    cache: createRealCredentialCache(deps.paths.root),
    platform: process.platform,
    now: () => Date.now(),
    ssh: (host, remoteCommand, input) => {
      const result = spawnSyncBlocking("an ssh run", "ssh", ["--", host, remoteCommand], { input, encoding: "utf8", stdio: ["pipe", "pipe", "inherit"] });
      return { status: result.status, stdout: result.stdout };
    },
    readInput: readStandardInput,
  };
}

/**
 * POSIX shell that sets `root` to the remote host's state root exactly as `resolveAgentShimHome` would: `AGENT_SHIM_HOME`, else the former `CLAUDE_USE_HOME`, else `~/.agent-shim`, else an existing former `~/.claude-use`.
 */
const REMOTE_ROOT_SCRIPT =
  'root="${AGENT_SHIM_HOME:-${CLAUDE_USE_HOME:-}}"; if [ -z "$root" ]; then if [ -d "$HOME/.agent-shim" ]; then root="$HOME/.agent-shim"; elif [ -d "$HOME/.claude-use" ]; then root="$HOME/.claude-use"; else root="$HOME/.agent-shim"; fi; fi';

/** A host as `ssh` takes it: letters, digits and `.`, `_`, `@`, `:`, `-`, never leading with `-` (which `ssh` would read as an option). */
const SSH_HOST_RE = /^[A-Za-z0-9._@:][A-Za-z0-9._@:-]*$/;
/** OpenSSH's status when it cannot complete the connection. */
const SSH_CONNECTION_FAILURE_STATUS = 255;

/**
 * The command `ssh` runs for `script`: `script` under `/bin/sh`, whatever the remote account's login shell is. OpenSSH hands a remote command to that login shell, and zsh, the macOS default, refuses an unmatched glob (the identities directory of a host with none) where a POSIX shell passes it through, so the script is written for and run by `/bin/sh` alone. The login shell still parses the one quoted word first, and csh and tcsh expand `!` as history and refuse a newline inside quotes even within single quotes, so the script holds neither: every name it embeds is one `isFileName` accepts (`remoteIdentityPushScript` and a provider's push refuse any other before a script is built), and the rest is fixed text.
 */
function remoteShellCommand(script: string): string {
  return `exec /bin/sh -c ${shellQuoted(script)}`;
}

/** What the remote push script prints between two NULs before the fields of a refusal: the login shell's start-up files can print to standard output before the script runs, so the fields are read from after the first NUL-framed marker, each followed by a NUL, which no path, id or owner holds. A field can end with the marker text or be that text, but never holds the NUL on either side of it, so no field is read as the frame. */
const REMOTE_REPLY_MARKER = "agent-shim-push-reply";
const REMOTE_LOCK_FRAME = "\u0000agent-shim-identity-lock-v1\u0000";

/** The `REMOTE_REPLY_MARKER` as `remoteReply` frames it, a NUL on each side. */
const REMOTE_REPLY_FRAME = `\u0000${REMOTE_REPLY_MARKER}\u0000`;

/** The shell that prints `REMOTE_REPLY_FRAME` and then a refusal's fields, each followed by a NUL. */
function remoteReply(...fields: readonly string[]): string {
  return `printf '\\000%s\\000' '${REMOTE_REPLY_MARKER}'; printf '%s\\000' ${fields.join(" ")}`;
}

/** The fields a remote push script printed with `remoteReply`, read from after the first frame in what `ssh` returned, or none when it printed no reply. */
function remoteReplyFields(stdout: string): readonly string[] {
  const at = stdout.indexOf(REMOTE_REPLY_FRAME);
  return at === -1 ? [] : stdout.slice(at + REMOTE_REPLY_FRAME.length).split("\u0000").slice(0, -1);
}

/** The exit status the remote push script ends with when no identity on the remote host is named the pushed name. */
const REMOTE_NO_IDENTITY_STATUS = 3;
/** The exit status the remote push script ends with when more than one identity on the remote host claims the pushed name. */
const REMOTE_DUPLICATE_IDENTITY_STATUS = 4;

/** The remote push script's status when the identity's id there is not one `isFileName` accepts (an ASCII letter or digit, then ASCII letters, digits and `.`, `_`, `@`, `-`, at most `MAX_NAME_BYTES` bytes): an id the rest of agent-shim there refuses (a leading `-`), whose entry's owner would have to be escaped in JSON (`"`, `\`) or which the remote `tr` would map to a file name other than `cacheFileNameFor`'s (a non-ASCII letter). Nothing is written. */
const REMOTE_UNSAFE_ID_STATUS = 5;

/** The remote push scripts' status when the cache file a push would write already holds an entry recorded for another owner (see `REMOTE_OWNER_CHECK`). Nothing is written. */
const REMOTE_FOREIGN_ENTRY_STATUS = 6;
/** The receiving host has an identity operation in progress. */
const REMOTE_IDENTITY_BUSY_STATUS = 7;

/** How many fields `REMOTE_OWNER_CHECK` replies with: the root, the file, the other owner and whether a provider of that name is defined there. A status 6 without them all was not printed by the script, so it is not read as its refusal. */
const REMOTE_FOREIGN_ENTRY_FIELDS = 4;

/**
 * POSIX shell, run with `$root` the state root, `$file` the name of the cache file a push would write, `$target` its path and `$owner` the owner its entry records (`identity <id>` or `provider <name>`), that ends the script with `REMOTE_FOREIGN_ENTRY_STATUS`, writing nothing, when the file already holds an entry recorded for any other owner: another identity or provider whose key names the same file (`cacheFileNameFor`), or an owner that is not a string. Such an entry is another's credential, perhaps the host's only copy. An entry with no owner (cached before owners were recorded) is anyone's, as the store reads it, and is overwritten, as are the push's own entry and a file that is not an entry. Every `"owner":` key the file holds must have `$owner` as its value, compared as a fixed string, so no character of a name is read as a pattern; a value is a whole JSON string, an escaped quote inside it included, and a key whose value is not a string has no value, which differs too. The reply is four fields: the root, the file, the other owner as the JSON string holds it, escaped (empty when it is not a string), and whether a provider of that name is defined there (`1`, empty when it is not, and `?` when the escaped name cannot be turned into a file name here, which `remoteForeignOwner` and `providerAsideRoute` tell).
 */
const REMOTE_OWNER_CHECK = [
  `if [ -f "$target" ]; then`,
  `all=$(grep -oE '"owner"[[:space:]]*:' "$target" | wc -l);`,
  `mine=$(grep -oE '"owner"[[:space:]]*:[[:space:]]*"([^"\\\\]|\\\\.)*"' "$target" | sed 's/^"owner"[[:space:]]*:[[:space:]]*//' | grep -cxF "\\"$owner\\"");`,
  `if [ $((all)) -ne $((mine)) ]; then other=$(grep -oE '"owner"[[:space:]]*:[[:space:]]*("([^"\\\\]|\\\\.)*")?' "$target" | sed 's/^"owner"[[:space:]]*:[[:space:]]*//' | grep -vxF "\\"$owner\\"" | head -n 1 | sed 's/^"//; s/"$//'); present=; case "$other" in *\\\\*) present=?;; "provider "*) if [ -f "$root/providers/\${other#provider }.json" ]; then present=1; fi;; esac; ${remoteReply('"$root"', '"$file"', '"$other"', '"$present"')}; exit ${String(REMOTE_FOREIGN_ENTRY_STATUS)}; fi;`,
  `fi`,
].join(" ");

/** The receiver's fixed POSIX collision check for an identity id it resolved under the names lock. It reports an unsafe id or a foreign cache owner without writing; the receiver publishes the validated entry atomically after the check succeeds. */
function remoteIdentityPushScript(name: string): string {
  if (!isFileName(name)) {
    throw new UsageError(`"${name}" is not an identity name that can be pushed.`);
  }
  return [
    "export LC_ALL=C",
    'id="$AGENT_SHIM_RECEIVER_ID"',
    // Validate every byte of the resolved id before it is used in a cache path; LC_ALL=C makes the character ranges ASCII and the length a byte count.
    `case "$id" in [${FILE_NAME_FIRST_CHARS}]*) ;; *) ${remoteReply('"$id"')}; exit ${String(REMOTE_UNSAFE_ID_STATUS)};; esac`,
    `rest=$(printf '%s/' "$id" | tr -d '${FILE_NAME_CHARS}'); if [ "$rest" = / ]; then :; else ${remoteReply('"$id"')}; exit ${String(REMOTE_UNSAFE_ID_STATUS)}; fi`,
    `if [ "\${#id}" -gt ${String(MAX_NAME_BYTES)} ]; then ${remoteReply('"$id"')}; exit ${String(REMOTE_UNSAFE_ID_STATUS)}; fi`,
    `file="identity_$(printf '%s' "$id" | tr -c 'A-Za-z0-9._-' '_').json"; target="$root/credential-cache/$file"`,
    `owner="identity $id"; ${REMOTE_OWNER_CHECK}`,
    remoteReply('"$id"'),
  ].join("; ");
}

/** What a refusal for an identity whose id on the remote host a push cannot write for says to do there: give the identity there another name, which changes no file but its identity.json, and create a new one of the pushed name, whose id agent-shim picks (one a push writes for, sharing no cache file with another identity). Only agent-shim runs there and nothing is moved or deleted. */
function identityAsideRoute(name: string): string {
  return `On that host, give that identity another name with \`agent-shim identity rename ${name} ${name}-old\` (or another unused name), create the one to push to with \`agent-shim identity add ${name}\`, which picks an id a push can write for, and push again. The identity renamed aside keeps its id, credential, cached entry and sign-in as they were.`;
}

/** `name` as one word of a command printed for a person to run on the remote host: as it is when it holds only characters a shell reads as themselves, else single-quoted (`shellQuoted`). The other owner's provider name is read from the remote host's file and can be one an older release allowed (a space, a quote), so it is never put into a command raw. */
function commandWord(name: string): string {
  return /^[A-Za-z0-9._@:+=-]+$/u.test(name) ? name : shellQuoted(name);
}

/** The owner a remote cache file records, from the JSON string the remote script replied with, escapes and all (`REMOTE_OWNER_CHECK`); empty for a string that is not valid JSON, which no owner an agent-shim wrote is, so it is told as an owner that is not a string. */
function ownerFromReply(raw: string): string {
  try {
    const owner: unknown = JSON.parse(`"${raw}"`);
    return typeof owner === "string" ? owner : "";
  } catch (error) {
    if (error instanceof SyntaxError) {
      return "";
    }
    throw error;
  }
}

/** What the refusal of a provider push over another's entry says to do there. A provider's cache key is its name on every host, so the pushed provider keeps its name: another provider whose name names the same file (compared with case folded, as a filesystem that ignores case does) and is defined there is renamed there, which moves its cached credential to its new name's file, and an entry no provider there reads (an owner that is not a provider's, or a provider not defined there) is removed with `credential forget --provider`. `present` is the remote script's answer to whether the other provider is defined there: `1`, empty, or `?` when it could not tell from the escaped name. */
function providerAsideRoute(name: string, owner: string, present: string): string {
  const candidate = owner.startsWith("provider ") ? owner.slice("provider ".length) : undefined;
  const other = candidate !== undefined && isStoredName(candidate) && sharesCacheFile(owner, `provider ${name}`) ? candidate : undefined;
  if (other === undefined) {
    return `No provider reads that entry: remove it there with \`agent-shim credential forget --provider ${commandWord(name)}\`, and push again.`;
  }
  const rename = `\`agent-shim provider rename ${commandWord(other)} ${commandWord(`${other}-2`)}\``;
  const forget = `\`agent-shim credential forget --provider ${commandWord(other)}\``;
  if (present === "1") {
    return `On that host, give provider ${JSON.stringify(other)} another name with ${rename} (or another unused name), which moves its cached credential to that name's file, and push again.`;
  }
  return present === "?"
    ? `Whether a provider ${JSON.stringify(other)} is defined on that host could not be told from its name in the entry: if \`agent-shim provider list\` there shows it, give it another name with ${rename} (or another unused name), which moves its cached credential to that name's file, otherwise remove that entry there with ${forget}, and push again.`
    : `No provider on that host is named ${JSON.stringify(other)}: remove that entry there with ${forget}, and push again.`;
}

/** POSIX shell, run on the remote host after `REMOTE_ROOT_SCRIPT`, that writes standard input, a provider's entry recording the provider as its owner, to the provider's cache file there, unless that file holds another owner's entry (`REMOTE_OWNER_CHECK`). A provider's cache key is its name on every host, so the file is named here, as `cacheFileNameFor` names it. */
function remoteProviderPushScript(cacheKey: string): string {
  return [`file=${shellQuoted(cacheFileNameFor(cacheKey))}`, 'target="$root/credential-cache/$file"', `owner=${shellQuoted(cacheKey)}`, REMOTE_OWNER_CHECK, 'umask 077 && mkdir -p "$root/credential-cache" && cat > "$target"'].join("; ");
}

interface Subject {
  readonly name: string;
  readonly subject: string;
  /** The key its cached credential is filed under: the subject for a provider, and `identity <id>` for an identity (see `identityCacheKey`). */
  readonly cacheKey: string;
  readonly credential: Credential;
}

/** The identity's or, with `--provider`, the provider's credential block, or a `CliError` saying what is missing. */
function credentialSubject(deps: CommandDeps, name: string, asProvider: boolean): Subject {
  if (asProvider) {
    const provider = readProvider(deps.paths, name);
    if (provider === undefined) {
      throw new ProviderNotFoundError(name);
    }
    if (isRouterProvider(provider)) {
      throw new UsageError(`Provider "${name}" is a router: it has no credential of its own.`);
    }
    return { name, subject: `provider ${name}`, cacheKey: `provider ${name}`, credential: provider.credential };
  }
  const id = identityIdOf(deps.paths, name);
  const identity = id === undefined ? undefined : readIdentityById(deps.paths, id);
  if (id === undefined || identity === undefined) {
    throw identityNotFound(deps.paths, name);
  }
  if (identity.credential === undefined) {
    throw new CredentialCommandError(`Identity "${name}" has no credential block to cache; it uses its stored login. Give it one with \`agent-shim identity set ${name} --credential ...\`.`);
  }
  return { name, subject: `identity ${name}`, cacheKey: identityCacheKey(id), credential: identity.credential };
}

function requireCaching(subject: Subject): NonNullable<Credential["cache"]> {
  const cache = subject.credential.cache;
  if (cache === undefined) {
    const flag = subject.subject.startsWith("provider") ? `provider set ${subject.name}` : `identity set ${subject.name}`;
    throw new CredentialCommandError(`The credential for ${subject.subject} is not cached. Turn caching on with \`agent-shim ${flag} --credential-cache-ttl 12h\` (or --credential-cache for no expiry).`);
  }
  return cache;
}

/**
 * Registers `agent-shim credential`: operations on the credentials identities authenticate with, as opposed to the `identity` noun's configuration of them. `store <identity>` reads a `claude setup-token` token from standard input (never an argument, which would land in shell history and the process list), keeps it at mode 0600 outside every identity's farm, and makes it the identity's `oauthToken` credential.
 */
export function registerCredentialCommand(program: Command, deps: CommandDeps, ports: CredentialCommandPorts = realCommandPorts(deps)): void {
  program.command("__identity-lock-v1 <name>", { hidden: true }).allowExcessArguments(false).action(async (name: string) => {
    const input = await ports.readInput();
    let parsed: unknown;
    try {
      parsed = JSON.parse(`{${input}`);
    } catch {
      throw new CredentialCommandError("Invalid remote credential input.");
    }
    const credential = CachedCredentialSchema.safeParse(parsed);
    if (!credential.success) throw new CredentialCommandError("Invalid remote credential input.");
    process.stdout.write(REMOTE_LOCK_FRAME);
    try {
      withIdentityNamesLock(deps.paths, nonWaitingIdentityNamesLockPorts, () => {
        if (!identityRecords(deps.paths).some((record) => record.name === name)) {
          process.exitCode = REMOTE_NO_IDENTITY_STATUS;
          return;
        }
        let canonicalId: string | undefined;
        try {
          canonicalId = identityIdOf(deps.paths, name);
        } catch (error: unknown) {
          if (!(error instanceof DuplicateIdentityNameError)) throw error;
          process.exitCode = REMOTE_DUPLICATE_IDENTITY_STATUS;
          return;
        }
        if (canonicalId === undefined) throw new CredentialCommandError("Remote identity disappeared while locked.");
        const result = spawnSyncBlocking("a remote identity cache operation", "/bin/sh", ["-c", `${REMOTE_ROOT_SCRIPT}; ${remoteIdentityPushScript(name)}`], { input: "", encoding: "utf8", env: { ...process.env, AGENT_SHIM_HOME: deps.paths.root, AGENT_SHIM_RECEIVER_ID: canonicalId } });
        if (result.status === 0) {
          const id = remoteReplyFields(result.stdout)[0];
          if (id === undefined || !isFileName(id) || id !== canonicalId) throw new CredentialCommandError("Remote identity check returned an invalid id.");
          ports.cache.write("file", identityCacheKey(id), credential.data);
        }
        process.stdout.write(result.stdout);
        process.stderr.write(result.stderr);
        process.exitCode = result.status ?? EXIT_FAILURE;
      });
    } catch (error: unknown) {
      if (!(error instanceof IdentityNamesLockBusyError)) throw error;
      process.exitCode = REMOTE_IDENTITY_BUSY_STATUS;
    }
  });
  const credential = withExamples(program.command("credential").description("Manage the credentials identities authenticate with."), [
    "agent-shim credential store work < token.txt",
    "agent-shim credential warm work",
  ]);

  withExamples(
    credential
      .command("store <identity>")
      .description("Store a `claude setup-token` token for an identity and make it that identity's credential. The token is read from standard input and never printed.")
      .action(async (name: string) => {
        // The identity is checked before anything is written: `setIdentityCredential` below refuses a displaced identity or an identity.json it cannot read, and the token file it points at would by then already hold the new token.
        if (deps.isInteractive()) {
          throw new UsageError("Pass the token on standard input, so it never lands in your shell history: run `claude setup-token`, then pipe or redirect its token into this command.");
        }
        const selected = withIdentityNamesLock(deps.paths, realIdentityNamesLockPorts, () => {
          const id = requireStoredIdentityId(deps.paths, name);
          readIdentityById(deps.paths, id);
          return { id, file: fs.openSync(path.join(deps.paths.identitiesDir, id, "identity.json"), "r") };
        });
        try {
          const input = await ports.readInput();
          withIdentityNamesLock(deps.paths, realIdentityNamesLockPorts, () => {
            const currentId = requireStoredIdentityId(deps.paths, name);
            const original = fs.fstatSync(selected.file, { bigint: true });
            const current = fs.statSync(path.join(deps.paths.identitiesDir, currentId, "identity.json"), { bigint: true });
            if (currentId !== selected.id || !sameFile(original, current)) {
              throw new CredentialCommandError(`Identity "${name}" changed while reading the token. Try again.`);
            }
            const stored = storeIdentityToken(deps.paths, currentId, input);
            const updated = setIdentityCredential(deps.paths, name, { sources: [{ file: stored }], target: "oauthToken" });
            if (updated.credential !== undefined) {
              console.log(`Identity "${name}" now authenticates with credential ${describeCredential(updated.credential)}.`);
            }
          });
        } finally {
          fs.closeSync(selected.file);
        }
      }),
    ["pbpaste | agent-shim credential store work", "agent-shim credential store work < token.txt"],
  );

  withExamples(
    credential
      .command("warm [identity]")
      .description("Fetch an identity's or provider's credential from its sources now, prompting if a source needs a person, and fill its cache so later launches need no prompt. Never prints the token.")
      .option("--provider <name>", "Warm a provider's credential instead of an identity's.")
      .action((name: string | undefined, options: Readonly<{ provider?: string }>) => {
        const warm = (): void => {
          const subject = credentialSubject(deps, subjectName(name, options.provider), options.provider !== undefined);
          const block = requireCaching(subject);
          const resolution = resolveCredential({ credential: subject.credential, env: process.env, port: { ...ports.credentials, cache: { port: ports.cache, platform: ports.platform, now: ports.now } }, subject: subject.subject, cacheKey: subject.cacheKey, refresh: true });
          if (!resolution.ok) {
            throw new CredentialCommandError(resolution.message, CREDENTIAL_UNAVAILABLE_EXIT);
          }
          const limit = ttlMs(block);
          console.log(
            `Cached the credential for ${subject.subject} in the ${effectiveStore(block, ports.platform)} store (${limit === undefined ? "no expiry" : `expires after ${block.ttl ?? ""}`}).`,
          );
        };
        if (options.provider === undefined) {
          withIdentityNamesLock(deps.paths, realIdentityNamesLockPorts, warm);
        } else {
          warm();
        }
      }),
    ["agent-shim credential warm work", "agent-shim credential warm --provider z"],
  );

  withExamples(
    credential
      .command("forget [identity]")
      .description("Remove an identity's or provider's cached credential from every store. The next launch fetches from the sources again.")
      .option("--provider <name>", "Forget a provider's credential instead of an identity's.")
      .action((name: string | undefined, options: Readonly<{ provider?: string }>) => {
        const forget = (): void => {
          const chosen = subjectName(name, options.provider);
          let subjectText: string;
          let cacheKey: string;
          if (options.provider !== undefined) {
            if (!isStoredName(chosen)) {
              throw new InvalidProviderNameError(chosen);
            }
            const provider = readProvider(deps.paths, chosen);
            if (provider !== undefined && isRouterProvider(provider)) {
              throw new UsageError(`Provider "${chosen}" is a router: it has no credential of its own.`);
            }
            subjectText = `provider ${chosen}`;
            cacheKey = `provider ${chosen}`;
          } else {
            const subject = credentialSubject(deps, chosen, false);
            subjectText = subject.subject;
            cacheKey = subject.cacheKey;
          }
          ports.cache.remove("file", cacheKey);
          if (ports.platform === "darwin") {
            ports.cache.remove("keychain", cacheKey);
          }
          console.log(`Removed the cached credential for ${subjectText}.`);
        };
        if (options.provider === undefined) {
          withIdentityNamesLock(deps.paths, realIdentityNamesLockPorts, forget);
        } else {
          forget();
        }
      }),
    ["agent-shim credential forget work", "agent-shim credential forget --provider z"],
  );

  withExamples(
    credential
      .command("push <identity> <host>")
      .description("Read an identity's credential here and write it to the credential cache on another host over SSH (mode 0600, token on standard input), so that host needs no 1Password. The identity must cache with the file store on that host, and the destination agent-shim must support the identity lock receiver. The entry records its owner, which a host running a release from before owners were recorded reads as no entry, so upgrade that host first.")
      .option("--provider <name>", "Push a provider's credential instead; <identity> is then ignored.")
      .action((name: string, host: string, options: Readonly<{ provider?: string }>) => {
        if (!SSH_HOST_RE.test(host)) {
          throw new UsageError(`"${host}" is not a host ssh can take.`);
        }
        const isProvider = options.provider !== undefined;
        const push = (): void => {
          const subject = credentialSubject(deps, subjectName(name, options.provider), isProvider);
          // A provider's name is embedded in the script the remote login shell parses and in the cache file's owner, so one an older release allowed (a quote, a `!`, a space, a newline) is refused here, before anything is read or sent, as an identity's is by `remoteIdentityPushScript`.
          if (isProvider && !isFileName(subject.name)) {
            throw new CredentialCommandError(`Provider ${JSON.stringify(subject.name)} cannot be pushed: its name ${FILE_NAME_RULE}, which the script on the other host and the cache file's owner need. Give it a name that does here with \`agent-shim provider rename <name> <new name>\`, and push again; nothing was sent.`);
          }
          requireCaching(subject);
          const resolution = resolveCredential({ credential: subject.credential, env: process.env, port: { ...ports.credentials, cache: { port: ports.cache, platform: ports.platform, now: ports.now } }, subject: subject.subject, cacheKey: subject.cacheKey });
          if (!resolution.ok) {
            throw new CredentialCommandError(resolution.message, CREDENTIAL_UNAVAILABLE_EXIT);
          }
          const cached = { token: resolution.credential.token, fetchedAt: resolution.credential.cachedAt ?? ports.now(), source: resolution.credential.source };
          // A provider keeps its name on every host; the receiver resolves an identity name to the destination host's id before recording its owner.
          const entry = isProvider ? serialisedFor(cached, subject.cacheKey) : identityEntryAfterOwner(cached);
          if (!isProvider && !isFileName(subject.name)) throw new UsageError(`"${subject.name}" is not an identity name that can be pushed.`);
          const remoteCommand = isProvider ? remoteShellCommand(`${REMOTE_ROOT_SCRIPT}; ${remoteProviderPushScript(subject.cacheKey)}`) : remoteShellCommand(`exec agent-shim __identity-lock-v1 ${subject.name}`);
          const { status, stdout } = ports.ssh(host, remoteCommand, entry);
          if (!isProvider && status !== null && status !== SSH_CONNECTION_FAILURE_STATUS && !stdout.includes(REMOTE_LOCK_FRAME)) {
            throw new CredentialCommandError(`The remote identity lock receiver on ${host} did not confirm the transfer. Upgrade agent-shim there and retry.`);
          }
          if (!isProvider && status === REMOTE_IDENTITY_BUSY_STATUS) throw new CredentialCommandError(`An identity operation is in progress on ${host}; retry the credential push when it finishes.`);
          const reply = remoteReplyFields(stdout);
          if (!isProvider && status === REMOTE_NO_IDENTITY_STATUS) {
            throw new CredentialCommandError(
              `No identity on ${host} is named "${subject.name}", so nothing was written there. Create it there with \`agent-shim identity add ${subject.name}\`, then push again; if \`agent-shim identity list\` there already shows the name, do what it says for that identity there first instead, and push again.`,
            );
          }
          if (!isProvider && status === REMOTE_UNSAFE_ID_STATUS && reply.length >= 1) {
            throw new CredentialCommandError(`The identity named "${subject.name}" on ${host} is stored under the id ${JSON.stringify(reply[0])}, which a push cannot write for, so nothing was written there. ${identityAsideRoute(subject.name)}`);
          }
          if (status === REMOTE_FOREIGN_ENTRY_STATUS && reply.length >= REMOTE_FOREIGN_ENTRY_FIELDS) {
            const [root = "", file = "", raw = "", present = ""] = reply;
            const owner = ownerFromReply(raw);
            const held = `The cache file ${root}/credential-cache/${file} on ${host} already holds a credential recorded for ${owner === "" ? "an owner that is not a string" : owner}, not for ${subject.subject}, so nothing was written there, and that entry is left as it is.`;
            throw new CredentialCommandError(isProvider ? `${held} ${providerAsideRoute(subject.name, owner, present)}` : `${held} ${identityAsideRoute(subject.name)}`);
          }
          if (!isProvider && status === REMOTE_DUPLICATE_IDENTITY_STATUS) {
            throw new CredentialCommandError(`More than one identity on ${host} is named "${subject.name}", so nothing was written there. Rename all but one there by its id with \`agent-shim identity rename <id> <new name> --id\`.`);
          }
          if (status !== 0) {
            throw new CredentialCommandError(`Could not write the credential cache for ${subject.subject} on ${host} (ssh exited ${status === null ? "without a status" : String(status)}).`);
          }
          console.log(`Wrote the credential for ${subject.subject} to ${host}. There, set the credential's cache store to file: \`agent-shim ${isProvider ? "provider" : "identity"} set ${subject.name} --credential-cache-store file\`.`);
        };
        if (isProvider) {
          push();
        } else {
          withIdentityNamesLock(deps.paths, realIdentityNamesLockPorts, push);
        }
      }),
    ["agent-shim credential push work build-host", "agent-shim credential push x build-host --provider z"],
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
