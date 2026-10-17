import { describe, expect, it } from "vitest";

import { hasSettingsArgument, initialConversationOf, mergeSettings, withConversation, withLauncherSettings, withSupervision } from "./claudeSession";

const ID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

describe("withConversation", () => {
  it("adds the launch's own conversation argument after what the caller passed", () => {
    expect(withConversation(["--model", "opus"], "start", ID)).toEqual(["--model", "opus", "--session-id", ID]);
    expect(withConversation(["--model", "opus"], "resume", ID)).toEqual(["--model", "opus", "--resume", ID]);
    expect(withConversation([], "resume", ID)).toEqual(["--resume", ID]);
  });

  it("removes every conversation argument of the caller's, in each form, before adding its own", () => {
    expect(withConversation(["--continue"], "resume", ID)).toEqual(["--resume", ID]);
    expect(withConversation(["-c", "--model", "opus"], "resume", ID)).toEqual(["--model", "opus", "--resume", ID]);
    expect(withConversation(["--resume", OTHER, "--model", "opus"], "resume", ID)).toEqual(["--model", "opus", "--resume", ID]);
    expect(withConversation(["-r", OTHER], "resume", ID)).toEqual(["--resume", ID]);
    expect(withConversation([`--resume=${OTHER}`], "resume", ID)).toEqual(["--resume", ID]);
    expect(withConversation(["--session-id", OTHER], "resume", ID)).toEqual(["--resume", ID]);
    expect(withConversation([`--session-id=${OTHER}`, "--verbose"], "start", ID)).toEqual(["--verbose", "--session-id", ID]);
  });

  it("does not take a following flag for the value of a bare --resume", () => {
    expect(withConversation(["--resume", "--model", "opus"], "resume", ID)).toEqual(["--model", "opus", "--resume", ID]);
  });

  it("leaves everything from a -- terminator alone and adds its own argument before it", () => {
    expect(withConversation(["--continue", "--", "--resume", OTHER], "resume", ID)).toEqual(["--resume", ID, "--", "--resume", OTHER]);
  });
});

describe("withSupervision", () => {
  it("applies the conversation argument and leaves the arguments alone when it takes the caller's as given", () => {
    expect(withSupervision(["--model", "opus"], { sessionId: ID, conversation: "start" })).toEqual(["--model", "opus", "--session-id", ID]);
    expect(withSupervision(["--resume", OTHER], { sessionId: OTHER, conversation: "as-given" })).toEqual(["--resume", OTHER]);
    // A model move's model replaces whatever the caller named, placed before any `--` terminator.
    expect(withSupervision(["--model", "opus", "--", "-x"], { sessionId: ID, conversation: "resume", model: "glm-5.3" })).toEqual(["--resume", ID, "--model", "glm-5.3", "--", "-x"]);
    expect(withSupervision(["--model=opus"], { sessionId: ID, conversation: "start", model: "glm-5.3" })).toEqual(["--session-id", ID, "--model", "glm-5.3"]);
  });
});

describe("withLauncherSettings", () => {
  const SETTINGS = '{"hooks":{}}';

  it("adds the settings after the arguments and before a -- terminator", () => {
    expect(withLauncherSettings(["--model", "opus"], SETTINGS)).toEqual(["--model", "opus", "--settings", SETTINGS]);
    expect(withLauncherSettings(["--session-id", ID, "--", "mcp"], SETTINGS)).toEqual(["--session-id", ID, "--settings", SETTINGS, "--", "mcp"]);
  });

  it("leaves the arguments alone when the launch adds no settings", () => {
    const args = ["--model", "opus"];
    expect(withLauncherSettings(args, undefined)).toBe(args);
  });
});

describe("mergeSettings", () => {
  it("is undefined when no part is present", () => {
    expect(mergeSettings([])).toBeUndefined();
    expect(mergeSettings([undefined, undefined])).toBeUndefined();
  });

  it("returns a single part's keys unchanged", () => {
    expect(JSON.parse(mergeSettings(['{"hooks":{"Stop":[]}}', undefined]) ?? "")).toEqual({ hooks: { Stop: [] } });
  });

  it("combines the top-level keys of every part into one object", () => {
    expect(JSON.parse(mergeSettings(['{"hooks":{"Stop":[]}}', '{"modelPicker":{"options":[]}}']) ?? "")).toEqual({ hooks: { Stop: [] }, modelPicker: { options: [] } });
  });

  it("refuses a key two parts both set rather than letting one win", () => {
    expect(() => mergeSettings(['{"hooks":{}}', '{"hooks":{"Stop":[]}}'])).toThrow('both set "hooks"');
  });

  it("refuses a part that is not a JSON object", () => {
    expect(() => mergeSettings(["[]"])).toThrow("not a JSON object");
  });
});

describe("hasSettingsArgument", () => {
  it("finds the caller's own --settings in either form, before a -- terminator only", () => {
    expect(hasSettingsArgument(["--settings", "a.json"])).toBe(true);
    expect(hasSettingsArgument(["--settings=a.json"])).toBe(true);
    expect(hasSettingsArgument(["--model", "opus"])).toBe(false);
    expect(hasSettingsArgument(["--", "--settings", "a.json"])).toBe(false);
  });
});

describe("initialConversationOf", () => {
  const context = { newId: () => ID, latestId: (): string | undefined => OTHER };

  it("starts a new conversation under a fresh id when the arguments name none", () => {
    expect(initialConversationOf(["--model", "opus"], context)).toEqual({ sessionId: ID, conversation: "start" });
    expect(initialConversationOf([], context)).toEqual({ sessionId: ID, conversation: "start" });
  });

  it("keeps the id of a --resume the caller named, as given", () => {
    expect(initialConversationOf(["--resume", OTHER], context)).toEqual({ sessionId: OTHER, conversation: "as-given" });
    expect(initialConversationOf([`--resume=${OTHER}`], context)).toEqual({ sessionId: OTHER, conversation: "as-given" });
  });

  it("pins --continue to the id of the directory's latest conversation", () => {
    expect(initialConversationOf(["--continue"], context)).toEqual({ sessionId: OTHER, conversation: "resume" });
    expect(initialConversationOf(["-c"], context)).toEqual({ sessionId: OTHER, conversation: "resume" });
  });

  it("cannot supervise a --continue with nothing to continue, a conversation picker or a print run", () => {
    expect(initialConversationOf(["--continue"], { ...context, latestId: () => undefined })).toEqual({ reason: "there is no conversation in this directory to continue" });
    expect(initialConversationOf(["--resume"], context)).toEqual({ reason: "the conversation picker names no conversation until one is chosen" });
    expect(initialConversationOf(["-r", "--model", "opus"], context)).toEqual({ reason: "the conversation picker names no conversation until one is chosen" });
    expect(initialConversationOf(["-p", "hello"], context)).toEqual({ reason: "a print run ends by itself" });
    expect(initialConversationOf(["--print", "--resume", OTHER], context)).toEqual({ reason: "a print run ends by itself" });
  });

  it("cannot supervise a conversation whose id is not safe to use as a file name", () => {
    expect(initialConversationOf(["--resume", "../outside"], context)).toEqual({ reason: "the conversation id is not a plain identifier" });
    expect(initialConversationOf(["--continue"], { ...context, latestId: () => "a/b" })).toEqual({ reason: "the latest conversation's id is not a plain identifier" });
  });

  it("ignores arguments after a -- terminator", () => {
    expect(initialConversationOf(["--", "-p", "--resume"], context)).toEqual({ sessionId: ID, conversation: "start" });
  });
});
