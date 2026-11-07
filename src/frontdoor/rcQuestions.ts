/**
 * The multiple-choice questions a Remote Control session's agent puts to its user, as the door observes and answers them. Claude Code delivers the question dialog on the same path as a tool approval: one worker-sourced `control_request` on the client read stream, subtype `can_use_tool`, whose `tool_name` is `AskUserQuestion` and whose `input` is that tool's own input (`questions`, each with `question`, `header`, `multiSelect` and `options` of `label` and `description`). The worker waits on it like any approval, and an attached client answers it with a `control_response` allowing the tool with an `updatedInput` that adds `answers`: a record from each question's text to the chosen option labels, several labels of a multi-select question joined with ", ". The door holds the observed input verbatim (in memory only) so the answer it writes carries the input the worker asked with, plus the answers. Everything here is pure: parsing an observed input and resolving a caller's choices against it.
 */

/** The tool name a `can_use_tool` request carries when it is the question dialog rather than an approval. */
export const RC_QUESTION_TOOL_NAME = "AskUserQuestion";

/** How the tool joins the labels of a multi-select question into its one answer string (its own input preprocessing joins an array the same way, and its result reads the string back as comma-separated). */
const MULTI_SELECT_SEPARATOR = ", ";

/** One option of an observed question. */
export interface RcQuestionOption {
  readonly label: string;
  /** The option's helper text, when the question carried one. */
  readonly description?: string;
}

/** One question of an observed `AskUserQuestion` request, as the pending surfaces list it. */
export interface RcPendingQuestion {
  /** The question text, which is also the key its answer is filed under. */
  readonly question: string;
  /** The short tab label the dialog shows, when the question carried one. */
  readonly header?: string;
  /** Whether more than one option may be chosen. */
  readonly multiSelect: boolean;
  readonly options: readonly RcQuestionOption[];
}

/**
 * One selection a caller makes for one question: an option's label (matched exactly, or case-insensitively when that names exactly one option), its one-based number in the order the question lists its options (the numbering the dialog itself shows), or free text in place of an option (the dialog's own "Type something" row).
 */
export type RcQuestionSelection = string | number | { readonly text: string };

/** The guard every narrowing of the observed input goes through. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One observed option, or undefined when it names no label an answer could carry. */
function optionOf(value: unknown): RcQuestionOption | undefined {
  if (!isRecord(value) || typeof value.label !== "string" || value.label === "") {
    return undefined;
  }
  return typeof value.description === "string" && value.description !== "" ? { label: value.label, description: value.description } : { label: value.label };
}

/** One observed question, or undefined when it is not a choice question this surface can answer (no text, or no options at all). */
function questionOf(value: unknown): RcPendingQuestion | undefined {
  if (!isRecord(value) || typeof value.question !== "string" || value.question === "" || !Array.isArray(value.options)) {
    return undefined;
  }
  const options: RcQuestionOption[] = [];
  for (const candidate of value.options) {
    const option = optionOf(candidate);
    if (option === undefined) {
      return undefined;
    }
    options.push(option);
  }
  if (options.length === 0) {
    return undefined;
  }
  const header = typeof value.header === "string" && value.header !== "" ? value.header : undefined;
  return { question: value.question, ...(header === undefined ? {} : { header }), multiSelect: value.multiSelect === true, options };
}

/**
 * The questions one `can_use_tool` request puts to the user, or undefined when the request is not the question dialog or its input does not have the shape this surface can answer. One malformed question makes the whole request unanswerable here rather than partly listed, because an answer must name every question the worker asked.
 */
export function rcQuestionsOfToolRequest(toolName: string | undefined, input: unknown): readonly RcPendingQuestion[] | undefined {
  if (toolName !== RC_QUESTION_TOOL_NAME || !isRecord(input) || !Array.isArray(input.questions) || input.questions.length === 0) {
    return undefined;
  }
  const questions: RcPendingQuestion[] = [];
  for (const candidate of input.questions) {
    const question = questionOf(candidate);
    if (question === undefined) {
      return undefined;
    }
    questions.push(question);
  }
  return questions;
}

/** One selection resolved to the answer text it contributes, or the refusal naming why it cannot be. */
function resolveSelection(question: RcPendingQuestion, questionNumber: number, selection: RcQuestionSelection): { readonly text: string } | { readonly error: string } {
  if (typeof selection === "number") {
    const option = Number.isInteger(selection) ? question.options[selection - 1] : undefined;
    return option === undefined ? { error: `question ${String(questionNumber)} has no option ${String(selection)}: its options are numbered 1 to ${String(question.options.length)}` } : { text: option.label };
  }
  if (typeof selection === "object") {
    return selection.text === "" ? { error: `question ${String(questionNumber)}'s free-text answer is empty` } : { text: selection.text };
  }
  const exact = question.options.find((option) => option.label === selection);
  if (exact !== undefined) {
    return { text: exact.label };
  }
  const folded = question.options.filter((option) => option.label.toLowerCase() === selection.toLowerCase());
  const [only] = folded;
  if (only !== undefined && folded.length === 1) {
    return { text: only.label };
  }
  return { error: `question ${String(questionNumber)} has no option labelled ${JSON.stringify(selection)}: its options are ${question.options.map((option) => JSON.stringify(option.label)).join(", ")}` };
}

/**
 * Resolves a caller's choices against the observed questions into the `answers` record the tool reads: one entry per question, in the order the request asked them, each a non-empty list of selections. A single-select question takes exactly one selection; a multi-select question takes one or more, distinct, joined the way the tool joins them. Every refusal names the question by its one-based number and says exactly what was wrong, so a caller never writes an answer the worker would misread.
 */
export function resolveRcQuestionAnswers(questions: readonly RcPendingQuestion[], choices: readonly (readonly RcQuestionSelection[])[]): { readonly answers: Readonly<Record<string, string>> } | { readonly error: string } {
  if (choices.length !== questions.length) {
    return { error: `the request asks ${String(questions.length)} question(s), so the answer must choose for each of them in order, but it chose for ${String(choices.length)}` };
  }
  const answers: Record<string, string> = {};
  for (const [index, question] of questions.entries()) {
    const questionNumber = index + 1;
    const selections = choices[index] ?? [];
    if (selections.length === 0) {
      return { error: `question ${String(questionNumber)} has no selection` };
    }
    if (!question.multiSelect && selections.length > 1) {
      return { error: `question ${String(questionNumber)} takes one option, but ${String(selections.length)} were chosen` };
    }
    const texts: string[] = [];
    for (const selection of selections) {
      const resolved = resolveSelection(question, questionNumber, selection);
      if ("error" in resolved) {
        return resolved;
      }
      if (texts.includes(resolved.text)) {
        return { error: `question ${String(questionNumber)} chose ${JSON.stringify(resolved.text)} twice` };
      }
      texts.push(resolved.text);
    }
    answers[question.question] = texts.join(MULTI_SELECT_SEPARATOR);
  }
  return { answers };
}
