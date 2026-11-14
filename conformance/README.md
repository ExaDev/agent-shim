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

The files are UTF-8 (a loader refuses a file that is not, rather than reading replacement characters) and canonical JSON, which a loader refuses any other form of, so a case changes in a diff and in no other way:

- Object keys are in UTF-16 code unit order, so `"10"` comes before `"9"`. A loader that builds objects must not let its language reorder integer-like keys (JavaScript puts them first, in numeric order); it writes and compares keys in the sorted order. A key holds no unpaired surrogate.
- Two-space indent, one element per line, an empty array or object as `[]` or `{}`, a final newline, and a space after the colon.
- A number is written as JavaScript writes it: an integer as digits, a fraction in its shortest form that reads back as the same number (`1.5`, never `1.50`), and no exponent form for a number that is within the integer cap. A number the cap or this form cannot hold is not in a corpus file.
- A string is written with only the escapes JSON requires: `\"`, `\\`, `\b`, `\f`, `\n`, `\r`, `\t`, and `\u00xx` in lower case for any other control character. Everything else is written as itself, a non-ASCII character, a solidus, U+2028 and U+007F included.

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
- `{ "$undefined": true }`: the JavaScript value `undefined`. Where the language has it, an object member with it is kept as a member whose value is undefined; where it does not, the member is left out and an expected result with it is no result. A case that depends on the member being kept (`canonical-json.members-and-undefined`) tests nothing in an implementation with no undefined, and that implementation marks it `skip` with the reason.
- `{ "$object": [["b", 1], ["a", 2]] }`: an object whose members are in the order given. A canonical file sorts every object's keys, so this is how a case gives an input whose behaviour depends on member order. A name is not an integer index (`"1"`), which JavaScript orders first whatever the pair order, and no name is repeated: the schema refuses the first and every loader the second, each with a fixture. Trilean's corpus format also writes canonical JSON and has no such encoding, so a case there cannot pin member order; the two formats can adopt this one when it needs to.
- `{ "codeUnits": [97, 98] }`: text, below. An object whose only key is `codeUnits` is always text.

Integers are at most 2^53-1, the largest the JavaScript runners hold exactly. A file with a larger integer is refused, and so is one that writes an integer as `97.0`, which is not canonical.

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
- `files`, optional: a file tree made before the steps, in a fresh directory of its own. A path is relative and has no `..`; an entry is text, `{ "base64": ... }` for exact bytes, `{ "symlink": <target> }` or `{ "directory": true }`. A string argument, expected result or link target that starts with `$TMP` has the directory's real path (with every link in it resolved) in its place, so a case holds wherever it runs.
- Paths in `function` cases are POSIX paths.

## Rules the schema cannot express

Each loader enforces these beside the schema:

- A file is canonical JSON, and holds no integer above 2^53-1, no `-0` and no unpaired surrogate in a string or an object key.
- No `$object` names a member twice.
- A case id is not used twice, within a file or across files.
- A case's `kind` is the name of its file's directory.
- A manifest's `skip` lists are in ascending order.
- The corpus matches the manifest: the same files, each with the same case count and the same skipped ids for each implementation.

Every rule above has a negative fixture, and every negative fixture has a repaired twin of the same name that differs by that one defect and is valid, so a fixture cannot stay rejected for another reason: a loader asserts both. A rule about one file has a file in `fixtures/invalid-cases` (twin in `fixtures/repaired-cases`); a rule about the manifest has a file in `fixtures/manifests/invalid` (twin in `fixtures/manifests/repaired`); a rule across files, or between the corpus and its manifest, has a whole corpus root in `fixtures/corpora/invalid` (twin in `fixtures/corpora/repaired`), loaded the way the real corpus is, with the real schemas. `fixtures/valid-cases` and `fixtures/manifests/valid` hold files every loader must accept, the bounds of every number among them. A file a loader cannot parse counts as rejected, which is how a loader meets an unpaired surrogate escape. Every real corpus file must be accepted by every loader. A rule added to the format gets a fixture and its twin in the same commit.

### Which loader asserts what

The TypeScript runner (`conformance/runner/run.mjs`, run by `src/conformance.repo.test.ts` inside `pnpm test`) is the only loader that exists, and it asserts all of it: that every invalid file is refused and its repaired twin accepted, the same for manifests and for whole corpus roots, that every valid file is accepted, the loader-selection tree, the text forms, and the real corpus against its manifest. The Rust harness (`rust/tests/agent-shim-conformance`) has no loader and asserts none of these; it executes nothing. A Rust module is ported only once the Rust loader asserts every fixture pair and the loader-selection and text-form fixtures, so that until then the corpus pins the TypeScript behaviour and nothing in Rust.

## Nothing real in the corpus

The corpus is public. No case holds a credential, a token, an account or organisation identifier, a session identifier, a host name or a personal detail, and anything copied from a real run is replaced first by a made-up value of the same shape. `sh scripts/rust.sh xtask corpus scrub-check`, the `conformance-scrub` job of CI, searches every file under this directory for what such a value looks like. It knows shapes and not values, so a name it has no shape for is for the author and the reviewer to keep out: a person's name, an account's name, and a host name that does not end in one of the suffixes below (`my-laptop`, a machine name on its own).

It reads what the files mean and what they spell. A JSON file is parsed, so a value written with `\u` escapes is found as the text it stands for, and every string and every object key is scanned; the raw lines are scanned as well, so a value that a duplicate key hides from the parse is still found at its line. These forms are decoded and scanned: the bytes of a `base64` file body (one level, and again as JSON when they parse), the units of a `codeUnits` array, percent-encoded text, and the `startsWith` and `contains` fragments of a message expectation joined in order as the one running text a loader reads. The members of `$object` and `$number` wrappers are plain strings and arrays and are walked as they are. These are not decoded: a second layer of base64, base64 held as plain text or in a `codeUnits` array, and any compression. A `base64` body that starts with a compression header is refused, and so is a case whose kind has no registered decoder (a file under `fixtures/` is never run as a case and is exempt from this one rule), so a recorded HTTP body may not enter the corpus until the scan decodes the encodings such bodies use. A test lists the forms `case.schema.json` defines and fails when it gains one the scan does not handle. A problem names the class, the file and where in it (a JSON pointer, or the line for a file that is not JSON or that the parse does not account for) and never the text found.

A value of these classes passes only in the form a scrubber writes: a filler of `FAKE` followed by digits and the letter `A`, the signature `ZmFrZQ` followed by `A` padding, the UUID namespace `00000000-0000-4000-8000-`, a hexadecimal id of sixteen zeros first, a MAC address that is all zeros, all ones or in the documentation range, an IPv6 address in `2001:db8::/32` or loopback, an id whose filler is digits only, `example.com`, `example.org`, loopback and `192.0.2.0/24`. The list below is generated from the check's table of classes (`sh scripts/rust.sh xtask corpus scrub-classes`) and a test fails when they differ.

<!-- scrub-classes:start -->
- `anthropic-key`: an Anthropic key (the `sk-ant-` prefix) whose filler is not the made-up form (never an exception)
- `api-key`: an `sk-` or `sk-proj-` key of 20 or more characters whose filler is not the made-up form (never an exception)
- `github-token`: a GitHub token (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_` or `github_pat_` with its filler) (never an exception)
- `aws-key-id`: an AWS access key id (`AKIA` or `ASIA` and 16 upper-case letters or digits) (never an exception)
- `jwt`: a JWT whose signature is not the made-up form (never an exception)
- `bearer-token`: a bearer value in any case that is not the made-up form (never an exception)
- `basic-auth`: a `Basic` authorisation value that decodes to a user and password (never an exception)
- `cookie-value`: the value of any pair of a `Cookie` header, and of a session cookie named anywhere (never an exception)
- `private-key`: a PEM or OpenSSH private key, by its header line or its base64 body (never an exception)
- `uuid`: a UUID outside the made-up namespace (never an exception)
- `prefixed-id`: an id with a known prefix (`cse_`, `session_`, `env_`, `msg_`, `req_`, `toolu_`, `srvtoolu_`, `org_`, `user_`, `acct_`, `account_`, `worker_`) whose filler is not made-up (never an exception)
- `hex-id`: 32 or 64 hexadecimal digits not starting with sixteen zeros (never an exception)
- `google-token`: a Google OAuth access token (`ya29.`) or refresh token (`1//`) with its filler (never an exception)
- `vendor-token`: a Slack (`xoxb-`, `xoxa-`, `xoxp-`, `xoxr-`, `xoxs-`), npm (`npm_`), GitLab (`glpat-`) or Stripe (`sk_live_`, `rk_live_`, `sk_test_`, `rk_test_`) token with its filler (never an exception)
- `credential-parameter`: the value of an `x-api-key`, `x-auth-token` or `api-key` header, of an `Authorization: token` header, or of an `access_token`, `refresh_token`, `id_token`, `auth_token`, `api_key`, `apikey` or `client_secret` parameter (never an exception)
- `email`: an email address, or a URL with userinfo, outside `example.com` and `example.org` (an exception may be recorded)
- `ipv4-address`: an IPv4 address outside loopback and 192.0.2.0/24 (an exception may be recorded)
- `ipv6-address`: an IPv6 address outside loopback and 2001:db8::/32 (an exception may be recorded)
- `mac-address`: a MAC address that is not all zeros, all ones or in the documentation range (an exception may be recorded)
- `home-path`: a path under a home directory (`/Users/`, `/home/`, `/root/` or `C:\Users\`) (an exception may be recorded)
- `host-name`: a host name ending `.local`, `.lan`, `.internal`, `.localdomain`, `.home.arpa` or `.ts.net` (an exception may be recorded)
- `ssh-target`: the `user@host` an `ssh` command names, outside `example.com` and `example.org` (an exception may be recorded)
<!-- scrub-classes:end -->

A deliberate exception is an entry of `scrub-allow.json`, `{ "class", "file", "pointer", "sha256", "reason" }`, bound to one class, one file, one location in it and the SHA-256 of the exact text found, so a value that changes, moves or appears a second time is a new finding, and the file holds a digest and never a value. A class marked "never an exception" cannot be named at all. `sh scripts/rust.sh xtask corpus scrub-suggest` prints the entries the current findings of an allowable class would need, to be given a reason. An entry nothing matches fails the check, and the allow file is scanned like every other file.

## Adding a case

Add it to the file for the test file it belongs to, with a fresh `id`, update `manifest.json`, and run the corpus (`pnpm test` runs the TypeScript runner). When a behaviour changes on purpose, change the case in the same commit as the code. A module whose tests have moved into the corpus takes its new tests as cases, not as unit tests.
