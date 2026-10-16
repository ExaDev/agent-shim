import { describe, expect, it } from "vitest";

import { initialConversationOf, withConversation } from "./claudeSession";

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
