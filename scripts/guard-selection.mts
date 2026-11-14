import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { configDefaults } from "vitest/config";
import { z } from "zod";

import { guardSelected, tableModules, testFileMatcher } from "../src/conformance/guardSelection.ts";

/**
 * Reads, on standard input, the paths a push changes (one per line, listed without rename detection so the old name of a renamed file is among them) and prints `run` when the pre-push hook must run the kept-tests guard (`src/conformance/keptTests.repo.test.ts`) and `skip` when it need not. Anything else is a failure and exits non-zero, so the hook stops and does not take a broken selection for a skip.
 *
 * The guard collects the whole suite, so it can be wrong about a push only when the push changes the suite's listing or something the guard reads. What counts is read from vitest's own configuration (`vitest.config.ts`: the globs that take a file as a test, the files it runs first), from the tracked files (the modules a test with an `each` imports, whose contents can become titles) and from the two directories the guard reads. CI runs the guard on every pull request whatever the paths.
 */
const root = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));

/** The vitest configuration: the file that sets the globs, and the one thing a change to which changes the suite's listing. */
const CONFIG = "vitest.config.ts";

/** The files that fix the version of vitest and of the packages that expand an `each`. */
const VERSION_FILES = ["package.json", "pnpm-lock.yaml"];

/** The directories the guard reads: the corpus and README tables, and the guard's own modules and call tables. */
const GUARD_DIRECTORIES = ["conformance/", "src/conformance/"];

const Files = z.union([z.string(), z.array(z.string())]).transform((files) => (Array.isArray(files) ? files : [files]).map((file) => path.posix.normalize(file)));
const ConfigModule = z.object({
  default: z.object({
    test: z.object({ include: z.array(z.string()).optional(), exclude: z.array(z.string()).optional(), setupFiles: Files.optional(), globalSetup: Files.optional() }),
  }),
});
const { include = configDefaults.include, exclude = configDefaults.exclude, setupFiles = [], globalSetup = [] } = ConfigModule.parse(await import(pathToFileURL(path.join(root, CONFIG)).href)).default.test;

const tracked = new Set(execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 1 << 28 }).split("\0").filter((file) => file !== ""));
const isTest = testFileMatcher(include, exclude);
const tests = new Map([...tracked].filter((file) => isTest(file)).map((file) => [file, fs.readFileSync(path.join(root, file), "utf8")]));
const inputs = {
  include,
  exclude,
  listingInputs: new Set([CONFIG, ...setupFiles, ...globalSetup, ...VERSION_FILES]),
  guardDirectories: GUARD_DIRECTORIES,
  tableModules: tableModules(tests, (file) => (tracked.has(file) ? fs.readFileSync(path.join(root, file), "utf8") : undefined)),
};

const changed = fs.readFileSync(0, "utf8").split("\n").filter((line) => line !== "");
process.stdout.write(`${guardSelected(changed, inputs) ? "run" : "skip"}\n`);
