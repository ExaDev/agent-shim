# Remote Control questions

How a Remote Control session's own multiple-choice question (the agent's `AskUserQuestion` dialog) reaches the door, how `frontdoor rc pending` lists it, and the answer `frontdoor rc answer` writes. Everything here was observed on a rig session against the door's self-hosted surface (see [rc-interception-rig.md](rc-interception-rig.md)), driven by the mock provider's `RC_MOCK_QUESTION=1` walk, with Claude Code 2.1.319 (the version the proof pinned). The protocol is the CLI's, not this project's, so these shapes must be re-verified when the CLI moves.

## The path

The question rides the same path as a tool approval. The worker sends a `control_request` on the client read stream, `source: "worker"`, with `subtype: "can_use_tool"`, `tool_name: "AskUserQuestion"`, `requires_user_interaction: true` and the tool's own input:

```json
{"type": "control_request", "request_id": "<id>", "request": {"subtype": "can_use_tool", "tool_name": "AskUserQuestion", "input": {"questions": [{"question": "Which database?", "header": "Database", "multiSelect": false, "options": [{"label": "Postgres", "description": "the relational choice"}, {"label": "SQLite", "description": "the embedded choice"}]}]}, "tool_use_id": "<id>", "requires_user_interaction": true}}
```

While it waits the worker reports `worker_status: requires_action`. It sets no deadline of its own: an answer written about a minute after the question continued the session. The door therefore lists a pending request for exactly as long as the worker waits on it, retiring it on a matching `control_response`, on the worker's own `control_cancel_request` for that id, on a worker registration naming a state other than `requires_action`, or with the session.

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

Answering a question means choosing an option for every question, in order: one option for a single-select question, one or more for a multi-select one, each named by its label (matched exactly, or ignoring case when that names one option), by its number, or as free text in place of an option. The CLI takes `--choose <question>:<option>` (repeat it for every question and for each option of a multi-select question; an option written only in digits is its number) and `--other <question>:<text>`; the REST route, the MCP tool and the typed API take `choices`, one list per question, each entry a label, a one-based number or `{"text": "..."}`. The door checks the choices against the observed options before writing anything.

The write is the `control_response` the CLI's own clients send: an allow whose `updatedInput` is the input the worker asked with plus `answers`, a record from each question's text to the chosen label, the labels of a multi-select question joined with `", "`:

```json
{"type": "control_response", "response": {"subtype": "success", "request_id": "<id>", "response": {"behavior": "allow", "updatedInput": {"questions": [...], "answers": {"Which database?": "SQLite", "Which checks?": "lint, test"}}}}}
```

The session continued with exactly those answers: its terminal printed `User answered Claude's questions: · Which database? → SQLite · Which checks? → lint, test` and the tool result the model read was `"Which database?"="SQLite", "Which checks?"="lint, test"`.

`--deny` (or `approve: false`) dismisses a question; choices never come with a denial, and an approval of a question without choices is refused, since the tool would run with no answers.

## Dismissed in the terminal

When the question is dismissed in the session's own terminal (Escape), the stream carries the worker's own `control_response` for the request (`behavior: "deny"`, `message: "User denied permission"`) and then a worker `control_cancel_request` for the same id, and the worker reports `idle`. Either retires the pending entry, so a later `rc answer` is refused as no longer pending.
