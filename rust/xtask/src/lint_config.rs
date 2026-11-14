//! `lint-config`: every workspace member takes its lints and shared package settings from the workspace.
//!
//! Cargo applies `[workspace.lints]` and `[workspace.package]` to a member only when the member opts in, so a crate
//! added without the stanzas silently escapes `unsafe_code = "forbid"` and the shared edition, toolchain floor and
//! licence. The members come from the workspace metadata that cargo reports, which lists every crate in the workspace including path
//! dependencies outside the `members` globs.
//!
//! Exactly two crates may allow `unsafe_code`, and a crate that does restates the workspace lint table instead of
//! inheriting it:
//!
//! - `agent-shim-win`, the Windows-only crate that wraps the operating system's own calls by hand. Its table is the
//!   workspace's with `unsafe_code` allowed and two clippy lints that make each `unsafe` block carry a safety comment
//!   and hold one operation, and no other difference is accepted.
//! - `agent-shim-wasm`, the binding crate, whose only `unsafe` is the code the `wasm-bindgen` macro generates. Its
//!   table differs from the workspace's only in `unsafe_code = "allow"`, and the word `unsafe` must appear nowhere in
//!   its hand-written source, so no hand-written `unsafe` hides behind the allowance.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::process::Command;

use serde_json::Value;

use crate::error::TaskError;

/// Package keys every member inherits from `[workspace.package]`.
const INHERITED: [&str; 3] = ["edition", "rust-version", "license"];

/// The Windows-only member that may allow `unsafe_code`, by package name.
const WINDOWS_CRATE: &str = "agent-shim-win";

/// The binding member that may allow `unsafe_code` for macro-generated code only, by package name.
const WASM_CRATE: &str = "agent-shim-wasm";

/// The lints the Windows crate adds to the workspace table: each `unsafe` block carries a safety comment and holds
/// one operation.
const WINDOWS_EXTRA_LINTS: [(&str, &str, &str); 2] = [
    ("clippy", "undocumented_unsafe_blocks", "\"deny\""),
    ("clippy", "multiple_unsafe_ops_per_block", "\"deny\""),
];

/// The lint tables a member or the workspace may hold, as the part of the header after `lints.`.
const LINT_TABLES: [&str; 2] = ["rust", "clippy"];

/// One `table`, `key`, `value` entry of a lint table, the value as written.
type LintEntry = (String, String, String);

/// What is wrong with the workspace and its members, in a stable order, or the fault that stopped the check.
pub fn run() -> Result<Vec<String>, TaskError> {
    let cargo = std::env::var("CARGO").map_err(|_| {
        TaskError::Metadata("the CARGO variable is not set; run through scripts/rust.sh".to_owned())
    })?;
    let output = Command::new(cargo)
        .args(["metadata", "--locked", "--no-deps", "--format-version", "1"])
        .output()
        .map_err(|source| TaskError::Metadata(source.to_string()))?;
    if !output.status.success() {
        return Err(TaskError::Metadata(
            String::from_utf8_lossy(&output.stderr).into_owned(),
        ));
    }
    let metadata: Value =
        serde_json::from_slice(&output.stdout).map_err(|source| TaskError::Json {
            what: "cargo metadata".to_owned(),
            detail: source.to_string(),
        })?;
    let root = metadata
        .get("workspace_root")
        .and_then(Value::as_str)
        .ok_or_else(|| TaskError::Metadata("no workspace_root in the output".to_owned()))?;
    let packages = metadata
        .get("packages")
        .and_then(Value::as_array)
        .ok_or_else(|| TaskError::Metadata("no packages in the output".to_owned()))?;
    let mut members = BTreeMap::new();
    let mut wasm_sources = Vec::new();
    for package in packages {
        let name = package
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| TaskError::Metadata("a package has no name".to_owned()))?;
        let manifest = package
            .get("manifest_path")
            .and_then(Value::as_str)
            .ok_or_else(|| TaskError::Metadata("a package has no manifest_path".to_owned()))?;
        members.insert(name.to_owned(), read(Path::new(manifest))?);
        if name == WASM_CRATE
            && let Some(directory) = Path::new(manifest).parent()
        {
            rust_sources(directory, &mut wasm_sources)?;
        }
    }
    let workspace = read(&Path::new(root).join("Cargo.toml"))?;
    Ok(problems_in(&workspace, &members, &wasm_sources))
}

/// Every `.rs` file under `directory`, as its path and text, leaving out a `target` directory of build output.
fn rust_sources(directory: &Path, found: &mut Vec<(String, String)>) -> Result<(), TaskError> {
    let mut entries: Vec<_> = std::fs::read_dir(directory)
        .and_then(|listing| {
            listing
                .map(|entry| entry.map(|entry| entry.path()))
                .collect()
        })
        .map_err(|source| TaskError::Io {
            path: directory.to_path_buf(),
            source,
        })?;
    entries.sort();
    for entry in entries {
        if entry.is_dir() {
            if entry.file_name().is_some_and(|name| name != "target") {
                rust_sources(&entry, found)?;
            }
        } else if entry.extension().is_some_and(|extension| extension == "rs") {
            found.push((entry.display().to_string(), read(&entry)?));
        }
    }
    Ok(())
}

/// Whether `text` holds the word `unsafe`, as a whole word and in any case of context (code, comment or string).
fn mentions_unsafe(text: &str) -> bool {
    text.match_indices("unsafe").any(|(index, word)| {
        let before = text[..index].chars().next_back();
        let after = text[index + word.len()..].chars().next();
        let part_of_word =
            |character: Option<char>| character.is_some_and(|c| c.is_alphanumeric() || c == '_');
        !part_of_word(before) && !part_of_word(after)
    })
}

fn read(path: &Path) -> Result<String, TaskError> {
    std::fs::read_to_string(path).map_err(|source| TaskError::Io {
        path: path.to_path_buf(),
        source,
    })
}

/// What is wrong with the workspace manifest, with each member's manifest text by member name, and with the
/// hand-written source of the binding crate as file and text pairs.
fn problems_in(
    workspace: &str,
    members: &BTreeMap<String, String>,
    wasm_sources: &[(String, String)],
) -> Vec<String> {
    let mut problems = Vec::new();
    let shared = table(workspace, "workspace.package");
    for key in INHERITED {
        if !shared.iter().any(|line| key_of(line) == Some(key)) {
            problems.push(format!("[workspace.package] does not set {key}"));
        }
    }
    let workspace_lints = lint_entries(workspace, "workspace.lints");
    if workspace_lints.is_empty() {
        problems.push("[workspace.lints] is not set".to_owned());
    } else if !workspace_lints.contains(&(
        "rust".to_owned(),
        "unsafe_code".to_owned(),
        "\"forbid\"".to_owned(),
    )) {
        problems.push("[workspace.lints.rust] does not set unsafe_code = \"forbid\"".to_owned());
    }
    if members.is_empty() {
        problems.push("the workspace has no member crates".to_owned());
    }
    for (name, manifest) in members {
        for key in INHERITED {
            if !inherits(manifest, key) {
                problems.push(format!(
                    "{name}: {key} is not inherited with {key}.workspace = true"
                ));
            }
        }
        if name == WINDOWS_CRATE {
            problems.extend(exception_problems(
                name,
                manifest,
                &workspace_lints,
                &WINDOWS_EXTRA_LINTS,
            ));
        } else if name == WASM_CRATE {
            problems.extend(exception_problems(name, manifest, &workspace_lints, &[]));
            for (file, text) in wasm_sources {
                if mentions_unsafe(text) {
                    problems.push(format!("{name}: {file} holds the word unsafe, which only the macro's generated code may"));
                }
            }
        } else if !takes_lints(manifest) {
            problems.push(format!("{name}: [lints] workspace = true is missing"));
        }
    }
    problems
}

/// What is wrong with the exception member's own lint table: it must equal the workspace's with `unsafe_code`
/// allowed and `extra` added, and must not inherit the workspace table.
fn exception_problems(
    name: &str,
    manifest: &str,
    workspace_lints: &BTreeSet<LintEntry>,
    extra: &[(&str, &str, &str)],
) -> Vec<String> {
    let mut problems = Vec::new();
    if takes_lints(manifest) {
        problems.push(format!("{name}: it restates the lint table instead of inheriting it, since it allows unsafe_code"));
    }
    let mut expected: BTreeSet<LintEntry> = workspace_lints
        .iter()
        .filter(|(table, key, _)| !(table == "rust" && key == "unsafe_code"))
        .cloned()
        .collect();
    expected.insert((
        "rust".to_owned(),
        "unsafe_code".to_owned(),
        "\"allow\"".to_owned(),
    ));
    for (table, key, value) in extra {
        expected.insert(((*table).to_owned(), (*key).to_owned(), (*value).to_owned()));
    }
    let actual = lint_entries(manifest, "lints");
    for (table, key, value) in expected.difference(&actual) {
        problems.push(format!(
            "{name}: [lints.{table}] {key} = {value} is missing"
        ));
    }
    for (table, key, value) in actual.difference(&expected) {
        problems.push(format!(
            "{name}: [lints.{table}] {key} = {value} is not in the workspace table or the exception"
        ));
    }
    problems
}

/// The lines of the table with this exact header, up to the next header, comments and blanks removed.
fn table<'a>(manifest: &'a str, header: &str) -> Vec<&'a str> {
    let mut lines = Vec::new();
    let mut inside = false;
    for raw in manifest.lines() {
        let line = raw.trim();
        if line.starts_with('[') {
            inside = line == format!("[{header}]");
        } else if inside && !line.is_empty() && !line.starts_with('#') {
            lines.push(line);
        }
    }
    lines
}

/// The key of a `key = value` or `key.workspace = true` line: the text before the first `=`, `.` or space.
fn key_of(line: &str) -> Option<&str> {
    line.split(['=', '.', ' '])
        .next()
        .filter(|key| !key.is_empty())
}

/// Whether the manifest takes `key` from the workspace, written `key.workspace = true` or `key = { workspace = true }`.
fn inherits(manifest: &str, key: &str) -> bool {
    let dotted = format!("{key}.workspace");
    manifest.lines().map(str::trim).any(|line| {
        let compact: String = line
            .chars()
            .filter(|character| !character.is_whitespace())
            .collect();
        compact == format!("{dotted}=true") || compact == format!("{key}={{workspace=true}}")
    })
}

/// Whether the manifest has `[lints]` holding `workspace = true`, or `lints.workspace = true`.
fn takes_lints(manifest: &str) -> bool {
    if table(manifest, "lints")
        .iter()
        .any(|line| line.split_whitespace().collect::<String>() == "workspace=true")
    {
        return true;
    }
    manifest.lines().map(str::trim).any(|line| {
        let compact: String = line
            .chars()
            .filter(|character| !character.is_whitespace())
            .collect();
        compact == "lints.workspace=true" || compact == "lints={workspace=true}"
    })
}

/// The `[<prefix>.rust]` and `[<prefix>.clippy]` entries, as table, key and value text.
fn lint_entries(manifest: &str, prefix: &str) -> BTreeSet<LintEntry> {
    let mut entries = BTreeSet::new();
    for lint_table in LINT_TABLES {
        for line in table(manifest, &format!("{prefix}.{lint_table}")) {
            if let Some((key, value)) = line.split_once('=') {
                let value = value.split('#').next().unwrap_or("").trim();
                entries.insert((
                    lint_table.to_owned(),
                    key.trim().to_owned(),
                    value.to_owned(),
                ));
            }
        }
    }
    entries
}

#[cfg(test)]
mod tests {
    use super::*;

    const WORKSPACE: &str = "\
[workspace]
members = [\"a\"]

[workspace.package]
edition = \"2024\"
rust-version = \"1.99.1\"
license = \"MIT\"

[workspace.lints.rust]
unsafe_code = \"forbid\"

[workspace.lints.clippy]
dbg_macro = \"deny\"
";

    const MEMBER: &str = "\
[package]
name = \"a\"
edition.workspace = true
rust-version.workspace = true
license = { workspace = true }

[lints]
workspace = true
";

    const EXCEPTION: &str = "\
[package]
name = \"agent-shim-win\"
edition.workspace = true
rust-version.workspace = true
license.workspace = true

[lints.rust]
unsafe_code = \"allow\"

[lints.clippy]
dbg_macro = \"deny\"
undocumented_unsafe_blocks = \"deny\"
multiple_unsafe_ops_per_block = \"deny\"
";

    const WASM: &str = "\
[package]
name = \"agent-shim-wasm\"
edition.workspace = true
rust-version.workspace = true
license.workspace = true

[lints.rust]
unsafe_code = \"allow\"

[lints.clippy]
dbg_macro = \"deny\"
";

    /// The check with no hand-written binding source, which is every case but the source ones.
    fn check(workspace: &str, members: &BTreeMap<String, String>) -> Vec<String> {
        problems_in(workspace, members, &[])
    }

    fn members(entries: &[(&str, &str)]) -> BTreeMap<String, String> {
        entries
            .iter()
            .map(|(name, text)| ((*name).to_owned(), (*text).to_owned()))
            .collect()
    }

    #[test]
    fn a_member_that_inherits_everything_passes() {
        assert_eq!(
            check(WORKSPACE, &members(&[("a", MEMBER)])),
            Vec::<String>::new()
        );
    }

    #[test]
    fn a_member_without_the_lints_stanza_fails() {
        let member = MEMBER.replace("[lints]\nworkspace = true\n", "");
        assert_eq!(
            check(WORKSPACE, &members(&[("a", &member)])),
            ["a: [lints] workspace = true is missing"]
        );
    }

    #[test]
    fn a_lints_table_that_does_not_inherit_fails() {
        let member = MEMBER.replace(
            "[lints]\nworkspace = true\n",
            "[lints]\n\n[lints.rust]\nunsafe_code = \"allow\"\n",
        );
        assert_eq!(
            check(WORKSPACE, &members(&[("a", &member)])),
            ["a: [lints] workspace = true is missing"]
        );
    }

    #[test]
    fn dotted_and_inline_forms_of_the_lints_stanza_pass() {
        for stanza in ["lints.workspace = true", "lints = { workspace = true }"] {
            let member = MEMBER.replace("[lints]\nworkspace = true\n", "");
            let member = member.replace("[package]\n", &format!("{stanza}\n\n[package]\n"));
            assert_eq!(
                check(WORKSPACE, &members(&[("a", &member)])),
                Vec::<String>::new(),
                "{stanza}"
            );
        }
    }

    #[test]
    fn a_member_that_writes_a_package_key_itself_fails() {
        let member = MEMBER.replace("edition.workspace = true", "edition = \"2021\"");
        assert_eq!(
            check(WORKSPACE, &members(&[("a", &member)])),
            ["a: edition is not inherited with edition.workspace = true"]
        );
    }

    #[test]
    fn a_workspace_that_does_not_forbid_unsafe_code_fails() {
        for lints in [
            "unsafe_code = \"allow\"",
            "unsafe_code = \"deny\"",
            "other = \"deny\"",
        ] {
            let workspace = WORKSPACE.replace("unsafe_code = \"forbid\"", lints);
            assert_eq!(
                check(&workspace, &members(&[("a", MEMBER)])),
                ["[workspace.lints.rust] does not set unsafe_code = \"forbid\""],
                "{lints}"
            );
        }
    }

    #[test]
    fn a_workspace_that_sets_nothing_fails_for_each_missing_part() {
        assert_eq!(
            check("[workspace]\nmembers = []\n", &members(&[])),
            [
                "[workspace.package] does not set edition",
                "[workspace.package] does not set rust-version",
                "[workspace.package] does not set license",
                "[workspace.lints] is not set",
                "the workspace has no member crates",
            ]
        );
    }

    #[test]
    fn the_windows_crate_may_restate_the_table_with_unsafe_allowed() {
        assert_eq!(
            check(
                WORKSPACE,
                &members(&[("a", MEMBER), ("agent-shim-win", EXCEPTION)])
            ),
            Vec::<String>::new()
        );
    }

    #[test]
    fn the_windows_crate_may_not_inherit_the_table() {
        let exception = format!("{EXCEPTION}\n[lints]\nworkspace = true\n");
        let problems = check(WORKSPACE, &members(&[("agent-shim-win", &exception)]));
        assert_eq!(
            problems,
            [
                "agent-shim-win: it restates the lint table instead of inheriting it, since it allows unsafe_code"
            ]
        );
    }

    #[test]
    fn the_windows_crate_may_not_differ_from_the_workspace_table_beyond_the_exception() {
        let dropped = EXCEPTION.replace("undocumented_unsafe_blocks = \"deny\"\n", "");
        assert_eq!(
            check(WORKSPACE, &members(&[("agent-shim-win", &dropped)])),
            ["agent-shim-win: [lints.clippy] undocumented_unsafe_blocks = \"deny\" is missing"]
        );
        let extra = format!("{EXCEPTION}todo = \"allow\"\n");
        assert_eq!(
            check(WORKSPACE, &members(&[("agent-shim-win", &extra)])),
            [
                "agent-shim-win: [lints.clippy] todo = \"allow\" is not in the workspace table or the exception"
            ]
        );
        let weakened = EXCEPTION.replace("dbg_macro = \"deny\"", "dbg_macro = \"warn\"");
        assert_eq!(
            check(WORKSPACE, &members(&[("agent-shim-win", &weakened)])).len(),
            2
        );
    }

    #[test]
    fn no_other_member_may_allow_unsafe_code() {
        let member = EXCEPTION.replace("agent-shim-win", "agent-shim-other");
        assert_eq!(
            check(WORKSPACE, &members(&[("agent-shim-other", &member)])),
            ["agent-shim-other: [lints] workspace = true is missing"]
        );
    }

    fn source(text: &str) -> Vec<(String, String)> {
        vec![("src/lib.rs".to_owned(), text.to_owned())]
    }

    #[test]
    fn the_binding_crate_may_restate_the_table_with_unsafe_allowed_and_no_hand_written_unsafe() {
        let members = members(&[("a", MEMBER), ("agent-shim-wasm", WASM)]);
        let sources = source("use wasm_bindgen::prelude::*;\n#[wasm_bindgen]\npub fn f() {}\n");
        assert_eq!(
            problems_in(WORKSPACE, &members, &sources),
            Vec::<String>::new()
        );
    }

    #[test]
    fn the_binding_crate_fails_on_hand_written_unsafe_in_code_comment_or_string() {
        let members = members(&[("agent-shim-wasm", WASM)]);
        for text in [
            "unsafe { x() }",
            "// unsafe",
            "let s = \"an unsafe word\";",
            "pub unsafe fn f() {}",
        ] {
            assert_eq!(
                problems_in(WORKSPACE, &members, &source(text)),
                [
                    "agent-shim-wasm: src/lib.rs holds the word unsafe, which only the macro's generated code may"
                ],
                "{text}"
            );
        }
    }

    #[test]
    fn the_word_unsafe_inside_a_longer_identifier_is_not_the_word() {
        let members = members(&[("agent-shim-wasm", WASM)]);
        for text in [
            "fn is_unsafely() {}",
            "let unsafe_code_count = 0;",
            "fn notunsafe() {}",
        ] {
            assert_eq!(
                problems_in(WORKSPACE, &members, &source(text)),
                Vec::<String>::new(),
                "{text}"
            );
        }
    }

    #[test]
    fn the_binding_crate_may_not_inherit_or_differ_beyond_unsafe_code() {
        let inheriting = format!("{WASM}\n[lints]\nworkspace = true\n");
        assert_eq!(
            check(WORKSPACE, &members(&[("agent-shim-wasm", &inheriting)])),
            [
                "agent-shim-wasm: it restates the lint table instead of inheriting it, since it allows unsafe_code"
            ]
        );
        let extra = format!("{WASM}undocumented_unsafe_blocks = \"deny\"\n");
        assert_eq!(
            check(WORKSPACE, &members(&[("agent-shim-wasm", &extra)])),
            [
                "agent-shim-wasm: [lints.clippy] undocumented_unsafe_blocks = \"deny\" is not in the workspace table or the exception"
            ]
        );
    }

    #[test]
    fn a_third_crate_that_opts_out_fails_whatever_it_is_named() {
        let third = WASM.replace("agent-shim-wasm", "agent-shim-third");
        assert_eq!(
            problems_in(
                WORKSPACE,
                &members(&[("agent-shim-third", &third)]),
                &source("unsafe")
            ),
            ["agent-shim-third: [lints] workspace = true is missing"]
        );
    }
}
