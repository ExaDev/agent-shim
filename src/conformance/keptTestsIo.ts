import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

import { loadCorpus } from "../../conformance/runner/run.mjs";
import { accountingFrom, listingBudgetMs, ListingSchema, slowListingMessage, type Accounting, type CaseRef, type Listing } from "./keptTests.ts";

/** Mebibytes of output read from `vitest list --json`. */
const LISTING_MEBIBYTES = 256;

/** Bytes in a mebibyte. */
const MEBIBYTE = 1_048_576;

/** The most output of `vitest list --json` read: the listing of a suite of thousands of tests is a few megabytes. */
const LISTING_MAX_BYTES = LISTING_MEBIBYTES * MEBIBYTE;

/** A program that was stopped because it ran past the time it was given. */
export class CommandTimeout extends Error {
  constructor(command: string) {
    super(`${command} did not finish in the time it was given`);
    this.name = "CommandTimeout";
  }
}

/** Runs a program to its end and gives its standard output, rejecting with its error and standard error when it fails, and with a `CommandTimeout` when it is stopped for running past `timeout` milliseconds. */
export async function runCommand(file: string, args: readonly string[], options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv; readonly maxBuffer?: number; readonly timeout?: number } = {}): Promise<string> {
  return await new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error === null) {
        resolve(stdout);
      } else if (error.killed === true && error.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
        reject(new CommandTimeout(file));
      } else {
        reject(new Error(`${file} ${args.join(" ")} failed: ${error.message}\n${stderr}`));
      }
    });
  });
}

const CaseRefSchema = z.object({ from: z.string(), skip: z.enum(["ts", "rust"]).optional() });

/** The suite's own listing of `root`: `vitest list --json`, run with the checkout's own vitest and the environment of a person's shell with the variables of an enclosing vitest removed, so a run inside a test lists and does not inherit its worker. The time it may take derives from the number of test files (`vitest list --filesOnly`, which only finds them), and a listing past its budget fails saying that the host was too slow. */
export async function listSuite(root: string): Promise<Listing> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("VITEST") && name !== "NODE_OPTIONS"));
  const vitest = path.join(root, "node_modules", "vitest", "vitest.mjs");
  const files = z.array(z.object({ file: z.string() })).parse(JSON.parse(await runCommand(process.execPath, [vitest, "list", "--filesOnly", "--json"], { cwd: root, env, maxBuffer: LISTING_MAX_BYTES }))).length;
  try {
    // `--json` stays last: it takes the next argument that does not start with a dash as the file to write to.
    const stdout = await runCommand(process.execPath, [vitest, "list", "--json"], { cwd: root, env, maxBuffer: LISTING_MAX_BYTES, timeout: listingBudgetMs(files) });
    return ListingSchema.parse(JSON.parse(stdout));
  } catch (error) {
    throw error instanceof CommandTimeout ? new Error(slowListingMessage(files)) : error;
  }
}

/** Every case of `root`'s corpus, as its `from` and the implementation that skips it. Throws for a corpus that does not load. */
export function corpusCases(root: string): CaseRef[] {
  const corpus = loadCorpus(path.join(root, "conformance"));
  if (corpus.problems.length > 0) {
    throw new Error(`the corpus does not load: ${corpus.problems.join("; ")}`);
  }
  return corpus.files.flatMap(({ cases }) => cases.map((entry) => CaseRefSchema.parse(entry)));
}

/** The accounting of `root`'s corpus and README tables. Throws for a corpus that does not load or a table that does not parse. */
export function readAccounting(root: string): Accounting {
  return accountingFrom(fs.readFileSync(path.join(root, "conformance", "README.md"), "utf8"), corpusCases(root));
}
