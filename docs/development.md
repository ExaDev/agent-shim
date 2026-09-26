# Development conventions

Full detail behind the Development section's test isolation, commit hooks and secret-redaction filter setup. Verbatim from an earlier README.md.

## Test isolation

Every test run gets `CLAUDE_USE_HOME` set to a throwaway directory by `vitest.config.ts`, and a Vitest setup file (`src/test-setup.ts`) refuses to let any test run at all if that variable is unset or resolves to the real `~/.claude-use` — there is no path by which the test suite can touch a real identity. A farm test that also needs a canonical `~/.claude` to resync against injects its own fake filesystem port rather than touching a real path. Manual, non-test exploration of a locally built binary should follow the same discipline: export `CLAUDE_USE_HOME` (and, if exercising a real farm resync, `CLAUDE_USE_CLAUDE_HOME`) to point at scratch directories, never at your own real identities.

## Commit hooks

Commits are gated by Husky hooks (`pnpm install` wires them up via the `prepare` script): `commit-msg` enforces conventional-commit format, `pre-commit` rejects merge/squash commits on `main` and runs `eslint --fix` on staged files via lint-staged, `pre-push` runs the full test suite. Both `pre-commit` and `pre-push` also reject a commit or push that deletes more than 100 files, as a guard against a sparse-checkout or partial-worktree bug landing a mass deletion.

## Secret-redaction filter

A fresh clone needs one extra step before committing anything. The repository routes text files through a secret-redaction clean filter (`.gitattributes`), and git stores filter definitions in `.git/config` rather than in the repository, so cloning does not bring them along:

```sh
git config filter.secrets.clean 'python3 .githooks/git-filter-clean %f'
git config filter.secrets.smudge cat
```

Without this, `.gitattributes`' `filter=secrets` attribute resolves to nothing and content reaches the object store unredacted. The `%f` matters, not just the script path: it's what lets the filter tell a genuine `.jsonl` file (where its own per-line JSON redaction pass is correct) apart from every other file this repo routes through the same filter — without it, that pass would also fire on ordinary `.json`/`.md` files, compact-reformatting any line that happens to be valid JSON on its own (a pretty-printed file's last array element, a one-line JSON example in a code block) and silently discarding its indentation. Do not add a `diff.secrets.textconv` pointing at the same script: `git-filter-clean` is a stream filter (reads stdin, writes stdout), while a textconv driver is handed a path instead, so the script would sit waiting on a stdin nobody writes to — blocking forever under lint-staged on any commit touching a partially staged file.
