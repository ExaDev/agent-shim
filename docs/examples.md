# Examples

Worked configuration examples and a permutation reference, from the simplest single-identity setup through a portable committed `.agent-shim.json`. Verbatim from an earlier README.md.

## Examples

### The core example: one login, two isolated clients, a few shared skills

```json
// ~/.agent-shim/config-profiles/client-base.json
{
  "categories": { "knowledge": false, "history": false },
  "entries": {
    "knowledge/skills/commit": true,
    "knowledge/skills/pr-feedback": true,
    "knowledge/rules": true
  }
}
```

```json
// ~/.agent-shim/config-profiles/client-acme.json
{ "extends": ["client-base"] }
```

```json
// ~/.agent-shim/config-profiles/client-widget.json
{ "extends": ["client-base"] }
```

```json
// ~/.agent-shim/directory-rules.json
{
  "rules": [
    { "path": "~/work/clients/acme",   "configProfile": "client-acme" },
    { "path": "~/work/clients/widget", "configProfile": "client-widget" }
  ]
}
```

One login serves both clients. History is fully isolated between them; `commit`, `pr-feedback`, and `rules` stay available in both. If "isolated" should mean each client still sees its own past sessions rather than none at all, add a glob entry override scoped to that client's own encoded project directories (see [Pattern matching](configuration-model.md#pattern-matching-against-claudeprojects)) rather than opening `history` wholesale.

### More scenarios

**Two logins, a directory rule as a safety net independent of which one is active.** A `personal` identity defaults to sharing history everywhere; a `work` identity defaults to not sharing it. One client is under a strict no-cross-contamination requirement:

```json
{ "rules": [{ "path": "~/work/clients/regulated-client", "configProfile": "client-strict" }] }
```

If `claude @personal` is ever run from inside that same directory — intentionally or by habit — the rule still applies, because rules aren't tied to identity. History stays off no matter which login is active.

**A team repo ships its own config; a new teammate needs zero setup.** A project commits `.agent-shim.json` at its root:

```json
{ "categories": { "history": false }, "entries": { "knowledge/skills/commit": true, "knowledge/skills/pr-feedback": true } }
```

A new teammate installs `agent-shim`, creates their own identity, clones the repo, and runs `claude` from inside it — they get the isolation-plus-shared-skills behaviour immediately, with no local configuration. If they want to see their own past sessions there too, that's a personal, local addition that composes on top of the committed file.

**Share-by-default, with narrow exceptions.** The inverse posture — broad sharing, a couple of carve-outs:

```json
{
  "rules": [
    { "path": "~/oss",                     "categories": { "history": true } },
    { "path": "~/oss/private-experiments", "categories": { "history": false } }
  ]
}
```

The deeper rule narrows what the shallower one opened up.

### Configuration permutation reference

A minimal progression, each adding one mechanism on top of the last:

1. **Bare minimum** — an identity, nothing else configured. Shipped defaults apply as-is.
2. **One configuration profile, no directory scoping** — `{ "categories": { "history": true } }` as an identity's default: that identity shares history everywhere.
3. **Directory rules switching profiles under one identity** — a `personal` profile and a `work` profile, a rule sending `~/work` to the latter.
4. **Linear `extends` chain** — `base` → `work` (extends `base`) → `client-acme` (extends `work`), each layer stating only what's different.
5. **Diamond `extends`** — a profile extending two others that disagree on one category; the later one in the list wins.
6. **A path-level override with the parent category closed** — one skill shared without opening the whole category.
7. **A directory rule adding an inline override deeper than the profile it selected** — a shared `client-strict` profile for `~/work/clients`, one extra skill for `~/work/clients/acme` specifically, no new profile needed.
8. **A glob entry override against `~/.claude/projects/`** — sharing history for every project matching a pattern, without listing each one.
9. **A portable `.agent-shim.json`** — works identically for every clone location.
10. **Two identities sharing one configuration profile** — both declare the same `defaultConfigProfile`; nothing else needs to stay in sync between them.

