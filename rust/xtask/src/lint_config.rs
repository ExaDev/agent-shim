//! `lint-config`: every workspace member takes its lints and shared package settings from the workspace.
//!
//! Cargo applies `[workspace.lints]` and `[workspace.package]` to a member only when the member opts in, so a crate
//! added without the stanzas silently escapes `unsafe_code = "forbid"` and the shared edition, toolchain floor and
//! licence. The members come from the workspace metadata that cargo reports, which lists every crate in the workspace including path
//! dependencies outside the `members` globs.
//!
//! The one exception is `agent-shim-win`, the Windows-only crate that wraps the operating system's own calls. It
//! restates the workspace lint table with `unsafe_code` allowed and two clippy lints that make each `unsafe` block
//! carry a safety comment and hold one operation, and no other difference is accepted.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::process::Command;

use serde_json::Value;

use crate::error::TaskError;

/// Package keys every member inherits from `[workspace.package]`.
const INHERITED: [&str; 3] = ["edition", "rust-version", "license"];

/// The member that may allow `unsafe_code`, by package name.
const UNSAFE_EXCEPTION: &str = "agent-shim-win";

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
    }
    let workspace = read(&Path::new(root).join("Cargo.toml"))?;
    Ok(problems_in(&workspace, &members))
}

fn read(path: &Path) -> Result<String, TaskError> {
    std::fs::read_to_string(path).map_err(|source| TaskError::Io {
        path: path.to_path_buf(),
        source,
    })
}

/// What is wrong with the workspace manifest and with each member's manifest text, by member name.
fn problems_in(workspace: &str, members: &BTreeMap<String, String>) -> Vec<String> {
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
        if name == UNSAFE_EXCEPTION {
            problems.extend(exception_problems(name, manifest, &workspace_lints));
        } else if !takes_lints(manifest) {
            problems.push(format!("{name}: [lints] workspace = true is missing"));
        }
    }
    problems
}

/// What is wrong with the exception member's own lint table: it must equal the workspace's with `unsafe_code`
/// allowed and the two clippy lints added, and must not inherit the workspace table.
fn exception_problems(
    name: &str,
    manifest: &str,
    workspace_lints: &BTreeSet<LintEntry>,
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
    expected.insert((
        "clippy".to_owned(),
        "undocumented_unsafe_blocks".to_owned(),
        "\"deny\"".to_owned(),
    ));
    expected.insert((
        "clippy".to_owned(),
        "multiple_unsafe_ops_per_block".to_owned(),
        "\"deny\"".to_owned(),
    ));
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

    fn members(entries: &[(&str, &str)]) -> BTreeMap<String, String> {
        entries
            .iter()
            .map(|(name, text)| ((*name).to_owned(), (*text).to_owned()))
            .collect()
    }

    #[test]
    fn a_member_that_inherits_everything_passes() {
        assert_eq!(
            problems_in(WORKSPACE, &members(&[("a", MEMBER)])),
            Vec::<String>::new()
        );
    }

    #[test]
    fn a_member_without_the_lints_stanza_fails() {
        let member = MEMBER.replace("[lints]\nworkspace = true\n", "");
        assert_eq!(
            problems_in(WORKSPACE, &members(&[("a", &member)])),
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
            problems_in(WORKSPACE, &members(&[("a", &member)])),
            ["a: [lints] workspace = true is missing"]
        );
    }

    #[test]
    fn dotted_and_inline_forms_of_the_lints_stanza_pass() {
        for stanza in ["lints.workspace = true", "lints = { workspace = true }"] {
            let member = MEMBER.replace("[lints]\nworkspace = true\n", "");
            let member = member.replace("[package]\n", &format!("{stanza}\n\n[package]\n"));
            assert_eq!(
                problems_in(WORKSPACE, &members(&[("a", &member)])),
                Vec::<String>::new(),
                "{stanza}"
            );
        }
    }

    #[test]
    fn a_member_that_writes_a_package_key_itself_fails() {
        let member = MEMBER.replace("edition.workspace = true", "edition = \"2021\"");
        assert_eq!(
            problems_in(WORKSPACE, &members(&[("a", &member)])),
            ["a: edition is not inherited with edition.workspace = true"]
        );
    }

    #[test]
    fn a_workspace_that_sets_nothing_fails_for_each_missing_part() {
        assert_eq!(
            problems_in("[workspace]\nmembers = []\n", &members(&[])),
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
            problems_in(
                WORKSPACE,
                &members(&[("a", MEMBER), ("agent-shim-win", EXCEPTION)])
            ),
            Vec::<String>::new()
        );
    }

    #[test]
    fn the_windows_crate_may_not_inherit_the_table() {
        let exception = format!("{EXCEPTION}\n[lints]\nworkspace = true\n");
        let problems = problems_in(WORKSPACE, &members(&[("agent-shim-win", &exception)]));
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
            problems_in(WORKSPACE, &members(&[("agent-shim-win", &dropped)])),
            ["agent-shim-win: [lints.clippy] undocumented_unsafe_blocks = \"deny\" is missing"]
        );
        let extra = format!("{EXCEPTION}todo = \"allow\"\n");
        assert_eq!(
            problems_in(WORKSPACE, &members(&[("agent-shim-win", &extra)])),
            [
                "agent-shim-win: [lints.clippy] todo = \"allow\" is not in the workspace table or the exception"
            ]
        );
        let weakened = EXCEPTION.replace("dbg_macro = \"deny\"", "dbg_macro = \"warn\"");
        assert_eq!(
            problems_in(WORKSPACE, &members(&[("agent-shim-win", &weakened)])).len(),
            2
        );
    }

    #[test]
    fn no_other_member_may_allow_unsafe_code() {
        let member = EXCEPTION.replace("agent-shim-win", "agent-shim-other");
        assert_eq!(
            problems_in(WORKSPACE, &members(&[("agent-shim-other", &member)])),
            ["agent-shim-other: [lints] workspace = true is missing"]
        );
    }
}
