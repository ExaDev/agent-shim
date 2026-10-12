import { describe, expect, it } from "vitest";

import { createFakeFarmFs } from "../test-helpers";
import { contextTokensOfTranscript, projectDirNameOf, resumeTargetOf, resumedContextTokens } from "./resumeContext";

const FIVE = 5;
const assistantLine = (usage: Readonly<Record<string, number>>): string => JSON.stringify({ type: "assistant", message: { role: "assistant", usage } });

describe("resumeTargetOf", () => {
  it("names the conversation --resume takes, in either spelling", () => {
    expect(resumeTargetOf(["--resume", "abc"])).toEqual({ kind: "id", id: "abc" });
    expect(resumeTargetOf(["-r", "abc"])).toEqual({ kind: "id", id: "abc" });
    expect(resumeTargetOf(["--resume=abc"])).toEqual({ kind: "id", id: "abc" });
  });

  it("takes the latest conversation for --continue", () => {
    expect(resumeTargetOf(["--continue"])).toEqual({ kind: "latest" });
    expect(resumeTargetOf(["-c", "--print"])).toEqual({ kind: "latest" });
  });

  it("names nothing for a bare --resume, which opens a picker, and ignores tokens after the terminator", () => {
    expect(resumeTargetOf(["--resume"])).toBeUndefined();
    expect(resumeTargetOf(["--resume", "--print"])).toBeUndefined();
    expect(resumeTargetOf(["--", "--continue"])).toBeUndefined();
  });
});

describe("projectDirNameOf", () => {
  it("turns every non-alphanumeric character into a hyphen", () => {
    expect(projectDirNameOf("/Users/a.b/my_repo")).toBe("-Users-a-b-my-repo");
  });
});

describe("contextTokensOfTranscript", () => {
  it("sums input, cache reads and cache writes of the last assistant turn that reports usage", () => {
    const earlier = assistantLine({ input_tokens: 1, cache_read_input_tokens: 1, cache_creation_input_tokens: 1 });
    const last = assistantLine({ input_tokens: FIVE, cache_read_input_tokens: FIVE * FIVE, cache_creation_input_tokens: FIVE * FIVE * FIVE, output_tokens: 1 });
    const text = [earlier, JSON.stringify({ type: "user" }), last, "not json", ""].join("\n");
    expect(contextTokensOfTranscript(text)).toBe(FIVE + FIVE * FIVE + FIVE * FIVE * FIVE);
  });

  it("is undefined for a transcript with no assistant usage", () => {
    expect(contextTokensOfTranscript(JSON.stringify({ type: "user" }))).toBeUndefined();
  });
});

describe("resumedContextTokens", () => {
  const claudeHome = "/home/testuser/.claude";
  const dir = `${claudeHome}/projects/-work-repo`;

  it("reads the named conversation's transcript", () => {
    const fs = createFakeFarmFs({ [`${dir}/abc.jsonl`]: assistantLine({ input_tokens: FIVE, cache_read_input_tokens: 0, cache_creation_input_tokens: FIVE }) });
    expect(resumedContextTokens(fs, { claudeHome, cwd: "/work/repo", passthrough: ["--resume", "abc"] })).toBe(FIVE + FIVE);
  });

  it("is undefined when the transcript does not exist or nothing is resumed", () => {
    const fs = createFakeFarmFs({});
    expect(resumedContextTokens(fs, { claudeHome, cwd: "/work/repo", passthrough: ["--resume", "abc"] })).toBeUndefined();
    expect(resumedContextTokens(fs, { claudeHome, cwd: "/work/repo", passthrough: ["--print"] })).toBeUndefined();
  });
});
