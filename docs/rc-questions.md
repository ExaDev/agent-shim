# Remote Control questions

How a Remote Control session's own multiple-choice question (the agent's `AskUserQuestion` dialog) reaches the door, how `frontdoor rc pending` lists it, and the answer `frontdoor rc answer` writes. Everything here was observed on a rig session against the door's self-hosted surface (see [rc-interception-rig.md](rc-interception-rig.md)), driven by the mock provider's `RC_MOCK_QUESTION=1` walk, with Claude Code 2.1.319 (the version the proof pinned). The protocol is the CLI's, not this project's, so these shapes must be re-verified when the CLI moves.

## The path

The question rides the same path as a tool approval. The worker sends a `control_request` on the client read stream, `source: "worker"`, with `subtype: "can_use_tool"`, `tool_name: "AskUserQuestion"`, `requires_user_interaction: true` and the tool's own input:

```json
{"type": "control_request", "request_id": "<id>", "request": {"subtype": "can_use_tool", "tool_name": "AskUserQuestion", "input": {"questions": [{"question": "Which database?", "header": "Database", "multiSelect": false, "options": [{"label": "Postgres", "description": "the relational choice"}, {"label": "SQLite", "description": "the embedded choice"}]}]}, "tool_use_id": "<id>", "requires_user_interaction": true}}
```

While it waits the worker reports `worker_status: requires_action`. It sets no deadline of its own, so a pending request stays pending until one of the retirements below; `src/frontdoor/fixtures/rc-question-2.1.319.json` holds a captured question and the later answer the session continued on. The `requires_action_details` the worker attaches to that registration cannot identify the question: for a question or a plan its `request_id` is blank and the id moves to `suppressed_request_id` (read from the 2.1.319 bundle).

The door therefore lists a pending request for exactly as long as the worker waits on it, and retires it on:

- a matching `control_response`, from any writer (the door, the session's terminal, another attached client);
- the worker's own `control_cancel_request` for that id, whose envelope is `{"type": "control_cancel_request", "request_id": "<id>", "session_id": "cse_...", "uuid": "<the event's own id>"}`;
- an accepted worker registration naming `idle`, or naming a new `worker_epoch`, for the requests observed before that registration was sent (`running` retires nothing, since the worker reports it between parallel requests);
- the session's own expiry.

A retired id is remembered, up to `RC_RETIRED_TOMBSTONES_MAX` ids per session (the bounds named here are constants in `src/frontdoor/rcSessions.ts`) with the oldest forgotten first, so a late duplicate of its request is not listed again while its id is remembered; a duplicate arriving after its id was forgotten is a new request. A request seen twice keeps the instant it was first seen. A session holds at most `RC_PENDING_PER_SESSION_MAX` pending requests and keys them by ids of at most `RC_REQUEST_ID_MAX_CHARS`; anything past either is counted rather than stored, shown as `pendingDropped` in `rc status` and as `dropped` (session and count) in `rc pending`, its JSON, the typed API and the web page, and a replay of a dropped request is not counted twice while its id is remembered (a dropped id takes a place in the same bounded record). A drop is not an event on the session event stream: a follower sees it in `rc pending` and `rc status`. The newest request is the one refused rather than the oldest evicted, because the tracker cannot tell a long-waiting request from a stale one (the worker sets no deadline), and evicting one the worker still waits on would hide a live question while reporting it gone. A question read from the stream whose serialised payload is past `RC_REQUEST_PARSE_CAP_BYTES` (UTF-8 bytes) is listed with `oversized: true` and its summary only, and cannot be answered through the door; any other request that large is listed and answered as usual, since approving or denying it carries none of its input. A worker event write whose whole body is past that cap is not read at all, so a request inside it is neither listed nor counted from that write; the stream copy of the same request is still read.

A question the door cannot answer faithfully is still listed, with `unanswerable` saying why, and the answer path refuses to approve it (denying it still dismisses it, since a denial carries none of the input): a malformed question, more than `RC_QUESTIONS_MAX` questions or `RC_QUESTION_OPTIONS_MAX` options, a question, header, label or description past `RC_QUESTION_FIELD_MAX_CHARS`, a question text asked twice (answers are filed under it) or an option label listed twice in one question (answers name it). Answer such a question in the session.

The CLI also has a separate `request_user_dialog` control request for host-rendered dialogs (refusal fallback, auto-mode notices, MCP elicitation). The question dialog does not use it.

## What `rc pending` lists

A question request is listed with its questions beside the usual fields: each question's text, `header` when it has one, `multiSelect`, and its options (`label`, and `description` when it has one) in the order the dialog numbers them. The plain listing prints them numbered, and those numbers are the ones `rc answer --choose` takes:

```
cse_...  <request id>  question  observed 2026-11-07T09:55:42.814Z
  1. [Database] Which database?  (choose one)
     1) Postgres: the relational choice
     2) SQLite: the embedded choice
```

The input the worker asked with is held in memory only, because the answer carries it back.

## The answer

Two answers written for the same request at once are not both sent: the first claims it, and the second is refused while the first is in flight.

Answering a question means choosing an option for every question, in order: one option for a single-select question, one or more for a multi-select one, each named by its label (matched exactly, or ignoring case when that names one option), by its number, or as free text in place of an option. The CLI takes `--choose <question>:<option>` (repeat it for every question and for each option of a multi-select question; an option written only in digits is always its number, so a label made only of digits is chosen by its number, or typed as `--other <question>:<label>`) and `--other <question>:<text>`; the REST route, the MCP tool and the typed API take `choices`, one list per question, each entry a label, a one-based number or `{"text": "..."}`. The door checks the choices against the observed options before writing anything, and refuses with the options listed: an unknown label, a number out of range, several options for a single-select question, the same option twice, or a question left without a selection. A single option for a multi-select question is a valid answer.

Free text is accepted in place of an option (`--other`, or `{"text": "..."}`), because the dialog itself offers a "Type something" row and the tool reads the text as that question's answer: for a single-select question the text is the answer, and for a multi-select one it is joined with the chosen labels. A live session answered `--other 1:CockroachDB --choose 2:lint --other "2:fmt check"` printed `Which database should the rig proof use? → CockroachDB` and `Which rig checks should run? → lint, fmt check`; the fixture holds that exchange. Blank text is refused. The dialog's other escape, "Chat about this" (a reply to the agent instead of an answer), is not offered: it is a separate result the tool reads differently, and a caller wanting it can deny the question with a message.

The write is the `control_response` the CLI's own clients send: an allow whose `updatedInput` is the input the worker asked with plus `answers`, a record from each question's text to the chosen label, the labels of a multi-select question joined with `", "`:

```json
{"type": "control_response", "response": {"subtype": "success", "request_id": "<id>", "response": {"behavior": "allow", "updatedInput": {"questions": [...], "answers": {"Which database?": "SQLite", "Which checks?": "lint, test"}}}}}
```

The CLI's own question dialog, answered in the terminal, returns the same permission result with `annotations` beside `answers` (`{behavior: "allow", updatedInput: {...input, answers, annotations}}` in the 2.1.319 bundle); the door sends no `annotations` (they carry a selected option's preview and a person's notes), and the live answers show the worker accepts the result without them. The joined form is the tool's own: its input schema accepts an array of labels and joins it with `", "` itself, so no unambiguous form exists on the wire, and a multi-select label that itself contains `", "` reads to the model as two. The door does not refuse such labels, since the agent chose them; the limit is the tool's.

The session continued with exactly those answers: its terminal printed `User answered Claude's questions: · Which database? → SQLite · Which checks? → lint, test` and the tool result the model read was `"Which database?"="SQLite", "Which checks?"="lint, test"`.

`--deny` (or `approve: false`) dismisses a question; choices never come with a denial, and an approval of a question without choices is refused, since the tool would run with no answers.

## Dismissed in the terminal

When the question is dismissed in the session's own terminal (Escape), the stream carries the worker's own `control_response` for the request (`behavior: "deny"`, `message: "User denied permission"`) and then a worker `control_cancel_request` for the same id, and the worker reports `idle`. Either retires the pending entry, so a later `rc answer` is refused as no longer pending.

## Support by mode

The door reaches a session's Remote Control in one of two ways, and the question support is written against the tracker and the one write port both share (`RcEventDial`), so the same code serves both:

| | Real service | Self-hosted |
|---|---|---|
| Sessions | an Anthropic OAuth login, with or without a provider for inference | no Anthropic login: a third-party provider, or none (`frontdoor rc selfhost mint`) |
| Where the question is observed | the client read stream the door attaches to on the real service, with the observed OAuth bearer | the same stream, served by the door's own surface |
| Where the answer goes | `POST /v1/code/sessions/{id}/events` on the real service, which relays it to the worker | the same route on the door's own surface |
| Listing questions, choosing options, dismissing | implemented, not run against the real service | run live |
| Evidence | tests of the tracker and the answer write over an injected dial (`rcSessions.test.ts`, `rcWrites.test.ts`, `rcQuestionsFixture.test.ts`) | a real 2.1.319 session on the isolated lab (`scripts/rc-self-host-lab.mts`, with its leak checks clean): the answer, the terminal dismissal and the refusals, captured in the fixture |

Nothing in this feature is mode-specific. What a real-service run would add over the tests is the service's own acceptance of the larger `control_response`, which the self-hosted proof cannot show because the door is that service there; the service relays a `control_response` payload to the worker opaquely, as it already does for the approvals this door answers there, but no run against the real service was made for this feature.
