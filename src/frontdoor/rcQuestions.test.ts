import { describe, expect, it } from "vitest";

import { RC_QUESTION_TOOL_NAME, rcQuestionsOfToolRequest, resolveRcQuestionAnswers, type RcPendingQuestion } from "./rcQuestions";

/** The first question's options, shared by the observed input and the parsed form. */
const QUESTION_ONE_OPTIONS = [{ label: "Postgres", description: "relational" }, { label: "SQLite", description: "embedded" }];

/** The tool input the question proof's rig session asked with: one single-select question with a header and one multi-select question. */
const INPUT = {
  questions: [
    { question: "Which database?", header: "Database", multiSelect: false, options: QUESTION_ONE_OPTIONS },
    { question: "Which checks?", header: "Checks", multiSelect: true, options: [{ label: "lint", description: "style" }, { label: "typecheck", description: "types" }, { label: "test", description: "suite" }] },
  ],
};

/** How many options the first question lists, so the first number past them is named rather than typed. */
const DATABASE_OPTIONS = QUESTION_ONE_OPTIONS.length;

const QUESTIONS: readonly RcPendingQuestion[] = [
  { question: "Which database?", header: "Database", multiSelect: false, options: QUESTION_ONE_OPTIONS },
  { question: "Which checks?", header: "Checks", multiSelect: true, options: [{ label: "lint", description: "style" }, { label: "typecheck", description: "types" }, { label: "test", description: "suite" }] },
];

/** The refusal resolving these choices gives, or the empty string when they resolved, so a test asserts on the message itself. */
function answerErrorOf(choices: Parameters<typeof resolveRcQuestionAnswers>[1]): string {
  const resolved = resolveRcQuestionAnswers(QUESTIONS, choices);
  return "error" in resolved ? resolved.error : "";
}

describe("parsing the question dialog out of a can_use_tool request", () => {
  it("reads every question with its header, selection kind and options", () => {
    expect(rcQuestionsOfToolRequest(RC_QUESTION_TOOL_NAME, INPUT)).toEqual(QUESTIONS);
  });

  it("reads an absent multiSelect as single-select, and omits an absent header and description", () => {
    expect(rcQuestionsOfToolRequest(RC_QUESTION_TOOL_NAME, { questions: [{ question: "Q?", options: [{ label: "A" }] }] })).toEqual([{ question: "Q?", multiSelect: false, options: [{ label: "A" }] }]);
  });

  it("is not a question for any other tool, and not one this surface can answer when any question is malformed or has no options", () => {
    expect(rcQuestionsOfToolRequest("Bash", INPUT)).toBeUndefined();
    expect(rcQuestionsOfToolRequest(undefined, INPUT)).toBeUndefined();
    expect(rcQuestionsOfToolRequest(RC_QUESTION_TOOL_NAME, { questions: [] })).toBeUndefined();
    expect(rcQuestionsOfToolRequest(RC_QUESTION_TOOL_NAME, { questions: [{ question: "Q?", options: [] }] })).toBeUndefined();
    expect(rcQuestionsOfToolRequest(RC_QUESTION_TOOL_NAME, { questions: [...INPUT.questions, { question: "", options: [{ label: "A" }] }] })).toBeUndefined();
    expect(rcQuestionsOfToolRequest(RC_QUESTION_TOOL_NAME, { questions: [{ question: "Q?", options: [{ label: "" }] }] })).toBeUndefined();
    expect(rcQuestionsOfToolRequest(RC_QUESTION_TOOL_NAME, "not an object")).toBeUndefined();
  });
});

describe("resolving a caller's choices into the tool's answers", () => {
  it("files each question's chosen labels under its text, a multi-select's joined the way the tool joins them", () => {
    expect(resolveRcQuestionAnswers(QUESTIONS, [["SQLite"], ["lint", "test"]])).toEqual({ answers: { "Which database?": "SQLite", "Which checks?": "lint, test" } });
  });

  it("takes an option by its one-based number, by a label differing only in case when that names one option, and free text in place of an option", () => {
    expect(resolveRcQuestionAnswers(QUESTIONS, [[1], ["TEST", { text: "fmt" }]])).toEqual({ answers: { "Which database?": "Postgres", "Which checks?": "test, fmt" } });
  });

  it("refuses an answer that does not choose for every question in order", () => {
    expect(answerErrorOf([["SQLite"]])).toContain("asks 2 question(s)");
    expect(resolveRcQuestionAnswers(QUESTIONS, [["SQLite"], []])).toEqual({ error: "question 2 has no selection" });
  });

  it("refuses several options for a single-select question, an unknown label or number, an empty free text and a repeated option", () => {
    expect(resolveRcQuestionAnswers(QUESTIONS, [["SQLite", "Postgres"], ["lint"]])).toEqual({ error: "question 1 takes one option, but 2 were chosen" });
    expect(answerErrorOf([["MySQL"], ["lint"]])).toContain('question 1 has no option labelled "MySQL"');
    expect(answerErrorOf([[DATABASE_OPTIONS + 1], ["lint"]])).toContain(`question 1 has no option ${String(DATABASE_OPTIONS + 1)}`);
    expect(answerErrorOf([[0], ["lint"]])).toContain("has no option 0");
    expect(resolveRcQuestionAnswers(QUESTIONS, [["SQLite"], [{ text: "" }]])).toEqual({ error: "question 2's free-text answer is empty" });
    expect(resolveRcQuestionAnswers(QUESTIONS, [["SQLite"], ["lint", 1]])).toEqual({ error: 'question 2 chose "lint" twice' });
  });
});
