/**
 * Verifies one Claude Code release for the goal, compaction and turn verbs, the checks `docs/rc-slash-commands.md` names, in the isolated self-hosted lab (`scripts/rc-self-host-lab.mts`) with its mock provider.
 *
 * Usage, through `node scripts/verify-claude-code.mts` (or `pnpm verify:claude-code`), which bundles this file:
 *
 * - `verify <version> --dir <work-dir>` fetches that release's binary for this platform from the registry, builds this checkout's agent-shim with the version added to `RC_SESSION_COMMAND_VERIFIED_VERSIONS` (the build the version would ship in, so the launcher loads its control plugin and the door serves it), brings the lab up on the launched, supervised and self-hosted routes in turn, runs `LAB_CHECKS` through the lab door's `frontdoor rc` verbs on each, and takes each lab down. It prints one line per check and exits 0 only when every check passed and every lab's leak checks were clean, and 1 naming each difference otherwise. <work-dir> must not exist yet, and is removed at the end unless `--keep`.
 * - `candidates` prints, as a JSON array, the published releases newer than the newest verified version.
 * - `newest` prints, as a JSON array of one, the newest verified version: what a change to the verification itself must keep passing.
 * - `record <version>...` adds the versions to `src/supervise/verifiedVersions.ts` and to the supported versions sentence of `docs/rc-slash-commands.md`.
 *
 * The binary is read from the platform package's tarball straight off the registry, verified against the integrity the registry publishes for it, and only its executable is extracted: no package manager runs, so no lifecycle script of the main package (its `postinstall` fetches the same binary) ever does. The lab's own requirements apply (tmux, lsof, no `CLAUDE_CONFIG_DIR` and a work directory outside `/tmp` and every real state root).
 */
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

import { RC_SESSION_COMMAND_VERIFIED_VERSIONS } from "../src/supervise/verifiedVersions";
import { cliBundleOptions } from "./bundle-options.mts";
import { LAB_STATE_FILE, labBaseEnv, labLayout, parseLabState, type LabRoute, type LabState } from "./rc-self-host-lab-core";
import { CLAUDE_CODE_PACKAGE, LAB_CHECKS, binaryPackageName, documentWithVersions, formatReport, isReleaseVersion, matchesIntegrity, newestVersion, parsePublishedVersions, pendingRequestIds, parseRegistryTarball, registryPackageUrl, registryVersionUrl, verifiedVersionsSource, versionsNewerThanVerified, withVersions, type LabCheckResult } from "./verify-claude-code-core";

const USAGE = "usage: node scripts/verify-claude-code.mts verify <version> --dir <work-dir> [--keep] | candidates | newest | record <version>...";

/** The public npm registry, which publishes Claude Code. */
const REGISTRY = "https://registry.npmjs.org";
/** The routes a release is verified on, in the order they run. */
const ROUTES: readonly LabRoute[] = ["launched", "supervised", "self-hosted"];
/** How long each verb waits for the session's answer: a goal set's first turn and a compaction each run a model call on the mock, which answers at once, so this bounds a session that stopped answering rather than any work. */
const VERB_WAIT_MS = 120_000;
/** How often the run looks for a permission request to deny while a verb waits: the mock's first answer in a conversation is a tool call that asks for one. */
const DENY_POLL_MS = 1_000;

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
/** The bundled entry lives in `dist/`, so the checkout root is one level up from either location. */
const REPO_ROOT = path.resolve(SCRIPTS_DIR, "..");
const LAB = path.join(REPO_ROOT, "scripts", "rc-self-host-lab.mts");
const VERIFIED_VERSIONS_SOURCE = path.join(REPO_ROOT, "src", "supervise", "verifiedVersions.ts");
const SLASH_COMMANDS_DOCUMENT = path.join(REPO_ROOT, "docs", "rc-slash-commands.md");

async function fetchJson(url: string, accept: string): Promise<unknown> {
  const response = await fetch(url, { headers: { accept } });
  if (!response.ok) {
    throw new Error(`${url} answered ${String(response.status)}`);
  }
  const parsed: unknown = await response.json();
  return parsed;
}

/** The C library this Node runs against is musl when its own report names no glibc runtime: the signal Node gives for it on Linux. */
function runsOnMusl(): boolean {
  if (process.platform !== "linux") {
    return false;
  }
  const report: unknown = process.report.getReport();
  return !(typeof report === "object" && report !== null && "header" in report && typeof report.header === "object" && report.header !== null && "glibcVersionRuntime" in report.header);
}

/** Fetches the release's binary for this platform into `directory` and answers its path. */
async function fetchBinary(version: string, directory: string): Promise<string> {
  const packageName = binaryPackageName({ platform: process.platform, arch: process.arch, musl: runsOnMusl() });
  const { tarball, integrity } = parseRegistryTarball(await fetchJson(registryVersionUrl(REGISTRY, packageName, version), "application/json"));
  const response = await fetch(tarball);
  if (!response.ok) {
    throw new Error(`${tarball} answered ${String(response.status)}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!matchesIntegrity(integrity, bytes)) {
    throw new Error(`${tarball} does not match the integrity the registry publishes for ${packageName}@${version}`);
  }
  fs.mkdirSync(directory, { recursive: true });
  const archive = path.join(directory, "package.tgz");
  fs.writeFileSync(archive, bytes);
  // The package's one executable is `package/claude` (`claude.exe` on Windows); nothing else in the archive is extracted.
  const member = process.platform === "win32" ? "package/claude.exe" : "package/claude";
  const extracted = spawnSync("tar", ["-xzf", archive, "-C", directory, member], { encoding: "utf8" });
  if (extracted.status !== 0) {
    throw new Error(`tar could not extract ${member} from ${archive}: ${extracted.stderr.trim()}`);
  }
  fs.rmSync(archive);
  return path.join(directory, member);
}

/** Builds this checkout's CLI bundle with `version` among the verified versions, into `outfile`. */
async function buildCandidate(version: string, outfile: string): Promise<void> {
  const contents = verifiedVersionsSource(fs.readFileSync(VERIFIED_VERSIONS_SOURCE, "utf8"), withVersions(RC_SESSION_COMMAND_VERIFIED_VERSIONS, [version]));
  await esbuild.build({
    ...cliBundleOptions(REPO_ROOT),
    outfile,
    logLevel: "silent",
    plugins: [{ name: "candidate-verified-versions", setup: (build) => {
          build.onLoad({ filter: /[\\/]src[\\/]supervise[\\/]verifiedVersions\.ts$/ }, () => ({ contents, loader: "ts" }));
        } }],
  });
}

/** The outcome of one child process. */
interface Ran {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs one command to completion without blocking the event loop, so the denial poll keeps running beside it. */
async function runAsync(command: string, args: readonly string[], env: Readonly<Record<string, string | undefined>>): Promise<Ran> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

/** What the lab's own command left: whether it exited 0, and what it reported on standard error, which names any failure and any leak. */
interface LabRun {
  readonly clean: boolean;
  readonly errors: string;
}

/** The lab's own command, run to completion, its output passed through so the lab's facts and leak checks are in the run's log. */
async function lab(args: readonly string[]): Promise<LabRun> {
  const ran = await runAsync(process.execPath, [LAB, ...args], process.env);
  process.stdout.write(ran.stdout);
  process.stderr.write(ran.stderr);
  return { clean: ran.status === 0, errors: ran.stderr.trim().replaceAll("\n", " ") };
}

/** The lab door's `frontdoor rc` verbs, run as the lab's own bundle under the lab's environment. */
function doorClient(labDir: string, state: LabState): (args: readonly string[]) => Promise<Ran> {
  const env = labBaseEnv(process.env, labLayout(labDir));
  return async (args) => await runAsync(process.execPath, [state.cliBundle, "frontdoor", "rc", ...args], env);
}

/** Denies every permission request pending on the session: the mock's first answer in a conversation is a Bash call that raises one, and a denial lets the turn finish without running it. */
async function denyPending(rc: (args: readonly string[]) => Promise<Ran>, sessionId: string): Promise<void> {
  const listed = await rc(["pending", sessionId, "--json"]);
  if (listed.status !== 0) {
    throw new Error(`frontdoor rc pending failed: ${listed.stderr.trim()}`);
  }
  for (const requestId of pendingRequestIds(JSON.parse(listed.stdout))) {
    const answered = await rc(["answer", "--session", sessionId, "--request", requestId, "--deny", "--text", "denied by the version check"]);
    if (answered.status !== 0) {
      throw new Error(`frontdoor rc answer failed on ${requestId}: ${answered.stderr.trim()}`);
    }
  }
}

/** Runs every check on one lab's session, denying permission requests while each runs. */
async function runChecks(route: LabRoute, labDir: string, state: LabState): Promise<readonly LabCheckResult[]> {
  const rc = doorClient(labDir, state);
  const results: LabCheckResult[] = [];
  const stop = new AbortController();
  const denial = (async (): Promise<void> => {
    while (!stop.signal.aborted) {
      await denyPending(rc, state.sessionId);
      await delay(DENY_POLL_MS);
    }
  })();
  try {
    for (const check of LAB_CHECKS) {
      const waits = check.expect === undefined ? [] : ["--wait-ms", String(VERB_WAIT_MS)];
      const ran = await rc([...check.args, "--session", state.sessionId, ...waits, "--json"]);
      if (ran.status !== 0) {
        results.push({ route, name: check.name, difference: `the verb failed: ${ran.stderr.trim() || ran.stdout.trim()}` });
        continue;
      }
      if (check.expect === undefined) {
        results.push({ route, name: check.name });
        continue;
      }
      const answer: unknown = JSON.parse(ran.stdout);
      const difference = check.expect(answer, route);
      results.push(difference === undefined ? { route, name: check.name } : { route, name: check.name, difference });
    }
  } finally {
    stop.abort();
    await denial;
  }
  return results;
}

async function verify(version: string, workDir: string, keep: boolean): Promise<boolean> {
  if (fs.existsSync(workDir)) {
    throw new Error(`${workDir} already exists; a run starts from an empty directory so nothing of an earlier one is reused`);
  }
  fs.mkdirSync(workDir, { recursive: true });
  const results: LabCheckResult[] = [];
  try {
    const binary = await fetchBinary(version, path.join(workDir, "claude-code"));
    const bundle = path.join(workDir, "cli.cjs");
    await buildCandidate(version, bundle);
    for (const route of ROUTES) {
      const labDir = path.join(workDir, `lab-${route}`);
      const started = await lab(["up", "--dir", labDir, "--claude-version", version, "--route", route, "--claude-binary", binary, "--cli-bundle", bundle]);
      const stateFile = path.join(labDir, LAB_STATE_FILE);
      const state = fs.existsSync(stateFile) ? parseLabState(fs.readFileSync(stateFile, "utf8")) : undefined;
      if (state === undefined) {
        results.push({ route, name: "the lab comes up with its Remote Control session", difference: `the lab did not come up: ${started.errors}` });
        continue;
      }
      results.push(started.clean ? { route, name: "the lab's leak checks at start" } : { route, name: "the lab's leak checks at start", difference: started.errors });
      results.push(...(await runChecks(route, labDir, state)));
      const stopped = await lab(["down", "--dir", labDir, ...(keep ? ["--keep"] : [])]);
      results.push(stopped.clean ? { route, name: "the lab's leak checks at teardown" } : { route, name: "the lab's leak checks at teardown", difference: stopped.errors });
    }
  } finally {
    if (!keep) {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }
  for (const line of formatReport(version, results)) {
    console.log(line);
  }
  return results.every((result) => result.difference === undefined);
}

async function candidates(): Promise<void> {
  // The abbreviated document the registry serves installers lists every version without each one's full manifest.
  const published = parsePublishedVersions(await fetchJson(registryPackageUrl(REGISTRY, CLAUDE_CODE_PACKAGE), "application/vnd.npm.install-v1+json"));
  console.log(JSON.stringify(versionsNewerThanVerified(published, RC_SESSION_COMMAND_VERIFIED_VERSIONS)));
}

function record(versions: readonly string[]): void {
  const all = withVersions(RC_SESSION_COMMAND_VERIFIED_VERSIONS, versions);
  fs.writeFileSync(VERIFIED_VERSIONS_SOURCE, verifiedVersionsSource(fs.readFileSync(VERIFIED_VERSIONS_SOURCE, "utf8"), all));
  fs.writeFileSync(SLASH_COMMANDS_DOCUMENT, documentWithVersions(fs.readFileSync(SLASH_COMMANDS_DOCUMENT, "utf8"), all));
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  try {
    if (command === "candidates" && rest.length === 0) {
      await candidates();
      return;
    }
    if (command === "newest" && rest.length === 0) {
      console.log(JSON.stringify([newestVersion(RC_SESSION_COMMAND_VERIFIED_VERSIONS)]));
      return;
    }
    if (command === "record" && rest.length > 0 && rest.every(isReleaseVersion)) {
      record(rest);
      return;
    }
    const [version, flag, dir, ...more] = rest;
    const keep = more.length === 1 && more[0] === "--keep";
    if (command === "verify" && version !== undefined && isReleaseVersion(version) && flag === "--dir" && dir !== undefined && (more.length === 0 || keep)) {
      process.exit((await verify(version, path.resolve(dir), keep)) ? 0 : 1);
    }
    console.error(USAGE);
    process.exit(2);
  } catch (error) {
    console.error(`verify-claude-code: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

await main();
