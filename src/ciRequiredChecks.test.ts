import fs from "node:fs";
import path from "node:path";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const WorkflowSchema = z.object({
  jobs: z.record(z.string(), z.object({ name: z.string().optional(), needs: z.union([z.string(), z.array(z.string())]).optional() })),
});

const workflow = WorkflowSchema.parse(parse(fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", "ci.yml"), "utf8")));

/** The job merge-when-green waits on. */
const AGGREGATE = "required-checks";

describe("ci.yml required-checks", () => {
  it("is named as merge-when-green is told to wait for it", () => {
    expect(workflow.jobs[AGGREGATE]?.name).toBe("Required checks");
  });

  it("needs every other job, so none can be ignored by the merge", () => {
    const needs = workflow.jobs[AGGREGATE]?.needs;
    if (!Array.isArray(needs)) {
      throw new Error(`${AGGREGATE} has no needs list`);
    }
    expect([...needs].sort()).toEqual(Object.keys(workflow.jobs).filter((id) => id !== AGGREGATE).sort());
  });
});

describe("the Homebrew verification", () => {
  const WORKFLOWS_DIR = path.join(__dirname, "..", ".github", "workflows");
  const ACTIONS_DIR = path.join(__dirname, "..", ".github", "actions");
  const SHARED_ACTION = "./.github/actions/brew-install";
  /** A `brew install`, `tap`, `reinstall` or `upgrade` as a command: at the start of a line, or after `&&`, `||`, `;`, `|`, `(`, or `sudo`, `time`, `xargs`, `command`, `exec` or `env` with its assignments. */
  const brewCall = /(?:^\s*|[;&|(]\s*|\b(?:sudo|time|xargs|command|exec|env)\s+(?:\w+=\S+\s+)*)brew\s+(?:install|tap|reinstall|upgrade)\b/mu;

  /** The jobs that verify the formula by id: macOS, macOS on Intel, and Linux (one job whose matrix covers both architectures). */
  const VERIFY_JOBS = ["verify-tap-macos", "verify-tap-macos-x64", "verify-tap-linux"];

  const StepsSchema = z.looseObject({ steps: z.array(z.looseObject({ uses: z.string().optional(), run: z.string().optional() })) });
  const JobsSchema = z.object({ jobs: z.record(z.string(), StepsSchema) });
  const ActionSchema = z.object({ runs: z.object({ steps: z.array(z.looseObject({ run: z.string().optional() })) }) });

  /** Every shell command of every run step, in every workflow and composite action of the repository, with where it is. */
  function allRunCommands(): readonly { readonly where: string; readonly command: string }[] {
    const found: { readonly where: string; readonly command: string }[] = [];
    for (const file of fs.readdirSync(WORKFLOWS_DIR).filter((name) => name.endsWith(".yml"))) {
      const parsed = JobsSchema.parse(parse(fs.readFileSync(path.join(WORKFLOWS_DIR, file), "utf8")));
      for (const [jobId, job] of Object.entries(parsed.jobs)) {
        for (const step of job.steps) {
          if (step.run !== undefined) {
            found.push({ where: `${file} ${jobId}`, command: step.run });
          }
        }
      }
    }
    for (const dir of fs.readdirSync(ACTIONS_DIR)) {
      const parsed = ActionSchema.parse(parse(fs.readFileSync(path.join(ACTIONS_DIR, dir, "action.yml"), "utf8")));
      for (const step of parsed.runs.steps) {
        if (step.run !== undefined) {
          found.push({ where: `action ${dir}`, command: step.run });
        }
      }
    }
    return found;
  }

  it("has a step that uses the shared install action in each verification job, found by id", () => {
    const jobs = JobsSchema.parse(parse(fs.readFileSync(path.join(WORKFLOWS_DIR, "ci.yml"), "utf8"))).jobs;
    for (const id of VERIFY_JOBS) {
      const job = jobs[id];
      expect(job, id).toBeDefined();
      expect(job?.steps.some((step) => step.uses === SHARED_ACTION), id).toBe(true);
    }
  });

  it("runs brew tap or brew install nowhere but the shared action's own script, in any run step of any workflow or composite action, whatever precedes the command", () => {
    // The command at the start of a line or after `&&`, `||`, `;`, `|`, `(`, `sudo`, `time`, `xargs`, `command` or `env` and its assignments.
    const offenders = allRunCommands().filter(({ command }) => brewCall.test(command));
    expect(offenders).toEqual([]);
  });

  it("finds the calls it is meant to refuse, in each shape", () => {
    for (const shape of ["brew install x", "  brew tap x", "cd y && brew install x", "true; brew tap x", "sudo brew install x", "echo x | brew install", "(brew install x)", "env CI=1 brew install x", "set -e\nbrew install x"]) {
      expect(brewCall.test(shape), shape).toBe(true);
    }
    for (const shape of ["echo brewing", "brew list --versions x", "$(brew --prefix)/bin/x", "# brew install x"]) {
      expect(brewCall.test(shape), shape).toBe(false);
    }
  });
});
