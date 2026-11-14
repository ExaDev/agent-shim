# Conformance corpus

Language-neutral cases that pin the behaviour of agent-shim. Every implementation of a module (the TypeScript source, the native Rust crates and the wasm builds) runs the same cases, so a port is correct when it passes what the original passes.

## Layout

```
conformance/
  README.md                  this file
  case.schema.json           JSON Schema of a corpus file
  manifest.json              what the corpus holds
  manifest.schema.json       JSON Schema of the manifest
  scrub-allow.json           deliberate exceptions to the scrub check, each with a reason
  runner/                    the TypeScript runner
  fixtures/                  data the runners test themselves with
  <kind>/<name>.json         the cases
```

The files are UTF-8 (a loader refuses a file that is not, rather than reading replacement characters) and canonical JSON: keys sorted in UTF-16 code unit order, two-space indent, one element per line, a final newline. A loader refuses a file that is valid JSON in any other form, so a case changes in a diff and in no other way.

### Which files are corpus files

Every loader applies this one rule, and each runs it over `fixtures/loader-selection` (a tree, and the files it must select and the entries it must refuse) so the loaders cannot disagree:

- A name that starts with a dot is ignored, at any depth.
- A directory called `fixtures`, `schema` or `runner` is skipped, at any depth, directly under the root included. It holds data cases refer to or the runners themselves, never cases.
- A name is lower-case ASCII letters, digits, dots, hyphens and underscores, and starts with a letter or digit, so every loader orders names the same way. The root's own files are the exception. A name that is not is a failure.
- A corpus file is a `.json` file at `<kind>/<name>.json`. The directory names the kind of the cases it holds, and a file takes its name from the test file it was extracted from (`names.json` from `names.test.ts`).
- The root holds only the files in the layout above.
- Files and problems are listed in UTF-16 code unit order, directory by directory.
- Anything else, a stray file, a file of another type, a file or directory at another depth, is a failure in every loader, never ignored by one.

### The manifest

`manifest.json` records, for every corpus file, its case count and the ids of the cases each implementation skips (`skip.ts` and `skip.rust`), each list in ascending order. Every runner checks the corpus against it and fails on any difference. A runner also counts, for its own implementation, the cases it executes and the cases it skips, and asserts that the sum is the manifest's total and that every case it skips is a case the manifest lists for it. The TypeScript runner counts the cases it registers when it collects them, so the check holds whatever the run does with the registered tests (a name filter, a bail, a retry, a shuffled order).

## Cases

Every case has:

- `id`: unique across the whole corpus, in lower-case ASCII letters, digits, dots, hyphens and underscores.
- `from`: either `<test file>.test.ts: <describe> > <test>`, the original test title the case came from, so a failure points back to the behaviour it pinned, or `recorded: <source file> (<what>)` for a recorded case. The schema and every loader refuse a `from` in neither form. Where the original asserted less than the case records, a case records the stronger expectation.
- `kind`: selects the shape below, and is the name of the directory the file is in.
- `skip`, optional, with a `reason` that says why: `ts` for a case the TypeScript implementation skips, `rust` for a case the Rust implementation skips. The axis is the implementation, never the host: a wasm build of the Rust code is `rust` wherever it runs (native, Node, a browser or Workers), and a skipped case is skipped in every build and on every host. A case one implementation cannot run carries it; nothing else does. A `reason` without `skip`, or a `skip` without a `reason`, is refused.

A case comes from an existing test, with the same inputs and the same expectation, and an expectation is never weaker than the original's. The exception is a recorded case: one written for the corpus because no test covered the behaviour, whose expectation is what the TypeScript implementation does today. Its `from` starts `recorded:` and names the source file the behaviour comes from, so a reader can tell a pinned original from a recorded behaviour, and a loader checks the form. A recorded behaviour that is a defect is fixed and its case changed together, never left pinned.

A behaviour that is not a function of a case's inputs (what the host's filesystem does with letter case, what the process environment holds) is not a case. Its test stays with the implementation that has it.

### Values

A value in `args` or `expect` is any JSON value, and an implementation may need a value JSON cannot carry. These objects stand for them, and any other object with a key that starts with `$` is refused:

- `{ "$number": "-0" }`, or `"NaN"`, `"Infinity"`, `"-Infinity"`: the number. A plain `-0` is refused, since canonical JSON cannot tell it from `0`.
- `{ "$undefined": true }`: the JavaScript value `undefined`, which an implementation with no such value reads as absent: an object member with it is left out, and an expected result with it is no result.
- `{ "$object": [["b", 1], ["a", 2]] }`: an object whose members are in the order given. A canonical file sorts every object's keys, so this is how a case gives an input whose behaviour depends on member order. A key that is an integer index (`"1"`) is ordered first by JavaScript whatever the pair order, so a case does not depend on one.
- `{ "codeUnits": [97, 98] }`: text, below. An object whose only key is `codeUnits` is always text.

Integers are at most 2^53-1, the largest the JavaScript runners hold exactly, and an integer written `97.0` is the integer 97, as in JSON Schema. A file with a larger integer is refused.

### Text

Every string in a value (an argument or an expected result) or in a message fragment is a sequence of UTF-16 code units, and every index counts UTF-16 code units, which is what the TypeScript implementation is in. Such a string takes either form:

- a JSON string, which must be well-formed Unicode (no unpaired surrogate escape), so every loader can read it; or
- `{ "codeUnits": [<0..65535>, ...] }`, for content a JSON string cannot carry, an unpaired surrogate.

A loader reads both into the same code unit sequence; `fixtures/text-forms/pairs.json` lists texts with their code units, and every loader checks they agree. A loader that cannot decode a string into code units, or that reads one in scalar values or bytes, is wrong: an emoji is two code units, and an index after it counts two.

### Kind `function`

A call of exported functions with plain inputs, for the pure helpers and the rules built on them.

```json
{
  "id": "paths.resolve-home.fresh-installation",
  "from": "paths.test.ts: resolveAgentShimHome > uses ~/.agent-shim on a fresh installation",
  "kind": "function",
  "steps": [
    { "fn": "resolveAgentShimHome", "args": [{}, "/h", false], "expect": { "value": "/h/.agent-shim" } }
  ]
}
```

- `steps`: one or more calls, run in order, each of which must hold. A function is named in `fn` and is looked up in a table the runner supplies, since the name is the contract and the implementation is each runner's own. A name with a dot (`FileNameSchema.accepts`) is still one name.
- `args`: the arguments. An argument an implementation cannot take as plain data is adapted by that implementation's table, and the case says what the data means: for `resolveAgentShimHome` the third argument is `true` (every directory exists), `false` (none does) or the list of paths that do.
- `select`, optional: a list of keys to follow into the result before comparing.
- `expect`: `{ "value": <value> }`, the result equals the value (strict equality, `-0` told from `0`), or `{ "throws": { "name": <error name>, "message": { "startsWith"?: <text>, "contains"?: [<text>, ...] } } }`, the call throws an error with that `name`, whose message starts with `startsWith` and holds each fragment of `contains` in order, each after the end of the one before. The `message` is optional, and holds at least one of its two keys.
- `files`, optional: a file tree made before the steps, in a fresh directory of its own. A path is relative and has no `..`; an entry is text, `{ "base64": ... }` for exact bytes, `{ "symlink": <target> }` or `{ "directory": true }`. A string argument, expected result or link target that starts with `$TMP` has the directory in its place, so a case holds wherever it runs.
- Paths in `function` cases are POSIX paths.

## Rules the schema cannot express

Each loader enforces these beside the schema:

- A file is canonical JSON, and holds no integer above 2^53-1, no `-0` and no unpaired surrogate in a string.
- A case id is not used twice, within a file or across files.
- A case's `kind` is the name of its file's directory.
- A manifest's `skip` lists are in ascending order.
- The corpus matches the manifest: the same files, each with the same case count and the same skipped ids for each implementation.

Every rule above has a negative fixture, and every negative fixture has a repaired twin of the same name that differs by that one defect and is valid, so a fixture cannot stay rejected for another reason: each loader asserts both. A rule about one file has a file in `fixtures/invalid-cases` (twin in `fixtures/repaired-cases`); a rule about the manifest has a file in `fixtures/manifests/invalid` (twin in `fixtures/manifests/repaired`); a rule across files, or between the corpus and its manifest, has a whole corpus root in `fixtures/corpora/invalid` (twin in `fixtures/corpora/repaired`), loaded the way the real corpus is, with the real schemas. `fixtures/valid-cases` and `fixtures/manifests/valid` hold files every loader must accept, the bounds of every number among them. A file a loader cannot parse counts as rejected, which is how a loader meets an unpaired surrogate escape. Every real corpus file must be accepted by all of them. A rule added to the format gets a fixture and its twin in the same commit.

## Nothing real in the corpus

The corpus is public. No case holds a credential, a token, an account or organisation identifier, a session identifier, a host name or a personal detail, and anything copied from a real run is replaced first by a made-up value of the same shape. `sh scripts/rust.sh xtask corpus scrub-check`, the `conformance-scrub` job of CI, searches every file under this directory for what such a value looks like: an Anthropic key, a JWT, a bearer or cookie value, a UUID outside the made-up namespace, an id with a known prefix, an email address outside `example.com` and `example.org`, an IPv4 address outside loopback and the documentation range, and a path under a home directory. A value passes only in the form a scrubber writes. A deliberate exception is an entry of `scrub-allow.json` giving the class, the file, the exact text and the reason, and an entry that matches nothing fails the check.

## Adding a case

Add it to the file for the test file it belongs to, with a fresh `id`, update `manifest.json`, and run the corpus (`pnpm test` runs the TypeScript runner). When a behaviour changes on purpose, change the case in the same commit as the code. A module whose tests have moved into the corpus takes its new tests as cases, not as unit tests.
