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
