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

describe("the Rust and corpus jobs", () => {
  /** The job ids and the names they report, which the gate and the branch's reviewers look for: cargo-deny by that name, since it is how the check enforcing the dependency allowlist is recognised. */
  const RUST_JOBS: Readonly<Record<string, string>> = { rust: "Rust", "cargo-deny": "cargo-deny", "conformance-scrub": "conformance-scrub" };

  it("are in the workflow under their names", () => {
    for (const [id, name] of Object.entries(RUST_JOBS)) {
      expect(workflow.jobs[id]?.name, id).toBe(name);
    }
  });

  it("are needed by the aggregate, so a failure in one blocks the merge", () => {
    const needs = workflow.jobs[AGGREGATE]?.needs;
    expect(needs).toEqual(expect.arrayContaining(Object.keys(RUST_JOBS)));
  });
});

describe("the deleted-test check", () => {
  const JobSchema = z.object({ jobs: z.record(z.string(), z.looseObject({ if: z.string().optional(), "continue-on-error": z.unknown().optional(), steps: z.array(z.looseObject({ uses: z.string().optional(), with: z.looseObject({}).optional() })) })) });
  const job = JobSchema.parse(parse(fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", "ci.yml"), "utf8"))).jobs["deleted-tests"];

  it("is a job that runs on pull requests, can fail the merge and is needed by the aggregate", () => {
    expect(job?.name).toBe("Deleted tests");
    expect(job?.if).toBe("github.event_name == 'pull_request'");
    expect(job?.["continue-on-error"]).toBeUndefined();
    expect(workflow.jobs[AGGREGATE]?.needs).toEqual(expect.arrayContaining(["deleted-tests"]));
  });

  it("checks out the whole history, which the base of the run's merge commit needs, and runs the script against that base", () => {
    const checkout = job?.steps.find((step) => step.uses?.startsWith("actions/checkout@") === true);
    expect(checkout?.with?.["fetch-depth"]).toBe(0);
    const command = job?.steps.map((step) => step.with?.command).find((value) => typeof value === "string");
    expect(command).toBe("node scripts/deleted-tests.mts --base HEAD^1");
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

describe("the Windows smoke jobs", () => {
  const WORKFLOWS_DIR = path.join(__dirname, "..", ".github", "workflows");
  const ACTION = "./.github/actions/dial-smoke";
  const SMOKE_JOBS = ["smoke-test-windows-x64", "smoke-test-windows-arm64"];
  const JobsSchema = z.object({ jobs: z.record(z.string(), z.looseObject({ steps: z.array(z.looseObject({ uses: z.string().optional(), with: z.looseObject({}).optional() })) })) });

  it("check the repository out for the dial action and then use it, since a Windows bind inside an excluded port range is refused only when a dial is made", () => {
    const jobs = JobsSchema.parse(parse(fs.readFileSync(path.join(WORKFLOWS_DIR, "ci.yml"), "utf8"))).jobs;
    for (const id of SMOKE_JOBS) {
      const steps = jobs[id]?.steps ?? [];
      const checkout = steps.findIndex((step) => step.uses?.startsWith("actions/checkout@") === true);
      const dial = steps.findIndex((step) => step.uses === ACTION);
      expect(checkout, `${id} checks out`).toBeGreaterThanOrEqual(0);
      expect(dial, `${id} dials`).toBeGreaterThan(checkout);
    }
  });

  it("run the dial in the job that runs the binary, with no job of its own", () => {
    const jobs = JobsSchema.parse(parse(fs.readFileSync(path.join(WORKFLOWS_DIR, "ci.yml"), "utf8"))).jobs;
    const users = Object.entries(jobs).filter(([, job]) => job.steps.some((step) => step.uses === ACTION)).map(([id]) => id);
    expect(users.sort()).toEqual([...SMOKE_JOBS].sort());
  });
});

describe("the release step", () => {
  const EnvStepsSchema = z.looseObject({ steps: z.array(z.looseObject({ run: z.string().optional(), env: z.record(z.string(), z.unknown()).optional() })) });
  const jobs = z.object({ jobs: z.record(z.string(), EnvStepsSchema) }).parse(parse(fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", "ci.yml"), "utf8"))).jobs;
  const releaseSteps = Object.values(jobs).flatMap((job) => job.steps).filter((step) => step.run?.includes("npx semantic-release") === true);

  it("is found, so the check below cannot pass on nothing", () => {
    expect(releaseSteps).toHaveLength(1);
  });

  it("turns the git hooks off, since the pre-push hook reruns the suite for the release commit and outlasts the push's connection", () => {
    expect(releaseSteps.map((step) => step.env?.HUSKY)).toEqual(["0"]);
  });
});
