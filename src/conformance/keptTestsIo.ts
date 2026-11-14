import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

import { loadCorpus } from "../../conformance/runner/run.mjs";
import { accountingFrom, ListingSchema, type Accounting, type Listing } from "./keptTests.ts";

/** Mebibytes of output read from `vitest list --json`. */
const LISTING_MEBIBYTES = 256;

/** Bytes in a mebibyte. */
const MEBIBYTE = 1_048_576;

/** The most output of `vitest list --json` read: the listing of a suite of thousands of tests is a few megabytes. */
const LISTING_MAX_BYTES = LISTING_MEBIBYTES * MEBIBYTE;

/** Runs a program to its end and gives its standard output, rejecting with its error and standard error when it fails. */
export async function runCommand(file: string, args: readonly string[], options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv; readonly maxBuffer?: number } = {}): Promise<string> {
  return await new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error === null) {
        resolve(stdout);
      } else {
        reject(new Error(`${file} ${args.join(" ")} failed: ${error.message}\n${stderr}`));
      }
    });
  });
}

const CaseFromSchema = z.object({ from: z.string() });

/** The suite's own listing of `root`: `vitest list --json`, run with the checkout's own vitest and the environment of a person's shell with the variables of an enclosing vitest removed, so a run inside a test lists and does not inherit its worker. */
export async function listSuite(root: string): Promise<Listing> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("VITEST") && name !== "NODE_OPTIONS"));
  // `--json` stays last: it takes the next argument that does not start with a dash as the file to write to.
  const stdout = await runCommand(process.execPath, [path.join(root, "node_modules", "vitest", "vitest.mjs"), "list", "--json"], { cwd: root, env, maxBuffer: LISTING_MAX_BYTES });
  return ListingSchema.parse(JSON.parse(stdout));
}

/** The `from` of every case of `root`'s corpus. Throws for a corpus that does not load. */
export function corpusFroms(root: string): string[] {
  const corpus = loadCorpus(path.join(root, "conformance"));
  if (corpus.problems.length > 0) {
    throw new Error(`the corpus does not load: ${corpus.problems.join("; ")}`);
  }
  return corpus.files.flatMap(({ cases }) => cases.map((entry) => CaseFromSchema.parse(entry).from));
}

/** The accounting of `root`'s corpus and README tables. Throws for a corpus that does not load or a table that does not parse. */
export function readAccounting(root: string): Accounting {
  return accountingFrom(fs.readFileSync(path.join(root, "conformance", "README.md"), "utf8"), corpusFroms(root));
}
