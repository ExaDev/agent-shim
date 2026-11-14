//! `corpus scrub-check`: nothing under `conformance/` is shaped like a real credential, identifier, address or home
//! directory.
//!
//! The corpus is public, and cases will come from recorded traffic and real tests, so the check knows shapes and not
//! values. A value of a known class passes only in the form a scrubber would have replaced it with: a made-up
//! filler, a reserved namespace or a documentation address. The classes:
//!
//! - an Anthropic key (`sk-ant-` prefix), unless its filler starts `FAKE`;
//! - a JWT, unless its signature starts `ZmFrZQ`;
//! - a bearer or cookie value, unless it starts `FAKE`;
//! - a UUID, unless it is in the `00000000-0000-4000-8000-` namespace;
//! - an id with a known prefix (`cse_`, `session_`, `env_`, `msg_`, `req_`, `toolu_`, `srvtoolu_`), unless its
//!   filler is digits only;
//! - an email address, unless its domain is `example.com` or `example.org`;
//! - an IPv4 address, unless loopback or in `192.0.2.0/24`;
//! - a path under a home directory (`/Users/<name>`, `/home/<name>`, `C:\Users\<name>`).
//!
//! A deliberate exception is an entry in `conformance/scrub-allow.json` naming the class, the file, the exact text
//! and the reason; an entry nothing matches is itself a problem, so the list holds only what is in use. The check
//! prints the class, file and line of a finding and never the text, since the log of a public repository must not
//! carry what it found. `scrub-allow.json` is not scanned: it is the list of exceptions and holds their text.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::error::TaskError;

/// The file of exceptions, directly under the corpus root.
const ALLOW_FILE: &str = "scrub-allow.json";

/// The least filler length of a prefixed id that counts as an id, so identifiers in prose and code (`session_id`) do not.
const ID_FILLER_MIN: usize = 16;

/// The least length of a token or value that counts as a credential.
const VALUE_MIN: usize = 8;

/// Prefixes of the third party's ids.
const ID_PREFIXES: [&str; 7] = [
    "cse_",
    "session_",
    "env_",
    "msg_",
    "req_",
    "toolu_",
    "srvtoolu_",
];

/// The namespace of made-up UUIDs.
const FAKE_UUID_PREFIX: &str = "00000000-0000-4000-8000-";

/// One thing found on a line: its class and the text, which is used only to match an exception.
#[derive(Debug, PartialEq, Eq, Clone)]
struct Finding {
    class: &'static str,
    text: String,
}

fn finding(class: &'static str, text: &str) -> Finding {
    Finding {
        class,
        text: text.to_owned(),
    }
}

/// One exception, as written in `scrub-allow.json`.
#[derive(Debug, PartialEq, Eq)]
struct Allowance {
    class: String,
    file: String,
    text: String,
}

/// What is wrong under the corpus root, or the fault that stopped the check.
pub fn run() -> Result<Vec<String>, TaskError> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../conformance");
    check_tree(&root)
}

fn check_tree(root: &Path) -> Result<Vec<String>, TaskError> {
    let allowances_path = root.join(ALLOW_FILE);
    let (allowances, mut problems) = read_allowances(&allowances_path)?;
    let mut used = BTreeSet::new();
    for path in files_under(root)? {
        let relative = path.strip_prefix(root).map_or_else(
            |_| path.display().to_string(),
            |rest| rest.to_string_lossy().replace('\\', "/"),
        );
        if relative == ALLOW_FILE {
            continue;
        }
        let bytes = std::fs::read(&path).map_err(|source| TaskError::Io {
            path: path.clone(),
            source,
        })?;
        for (index, line) in String::from_utf8_lossy(&bytes).lines().enumerate() {
            for found in scan_line(line) {
                match allowances.iter().position(|allowance| {
                    allowance.class == found.class
                        && allowance.file == relative
                        && allowance.text == found.text
                }) {
                    Some(position) => {
                        used.insert(position);
                    }
                    None => problems.push(format!("{relative}:{}: {}", index + 1, found.class)),
                }
            }
        }
    }
    for (position, allowance) in allowances.iter().enumerate() {
        if !used.contains(&position) {
            problems.push(format!(
                "{ALLOW_FILE}: the {} exception for {} matches nothing",
                allowance.class, allowance.file
            ));
        }
    }
    Ok(problems)
}

/// Every file under `root`, directories walked in name order.
fn files_under(root: &Path) -> Result<Vec<PathBuf>, TaskError> {
    let mut files = Vec::new();
    let mut entries: Vec<PathBuf> = std::fs::read_dir(root)
        .and_then(|listing| {
            listing
                .map(|entry| entry.map(|entry| entry.path()))
                .collect()
        })
        .map_err(|source| TaskError::Io {
            path: root.to_path_buf(),
            source,
        })?;
    entries.sort();
    for entry in entries {
        if entry.is_dir() {
            files.extend(files_under(&entry)?);
        } else {
            files.push(entry);
        }
    }
    Ok(files)
}

/// The exceptions in the file, and what is wrong with the file itself. A missing file is an error: the file is part of the corpus.
fn read_allowances(path: &Path) -> Result<(Vec<Allowance>, Vec<String>), TaskError> {
    let text = std::fs::read_to_string(path).map_err(|source| TaskError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    let document: Value = serde_json::from_str(&text).map_err(|source| TaskError::Json {
        what: path.display().to_string(),
        detail: source.to_string(),
    })?;
    Ok(allowances_from(&document))
}

fn allowances_from(document: &Value) -> (Vec<Allowance>, Vec<String>) {
    let mut allowances = Vec::new();
    let mut problems = Vec::new();
    let Some(entries) = document
        .get("allow")
        .and_then(Value::as_array)
        .filter(|_| document.as_object().is_some_and(|object| object.len() == 1))
    else {
        problems.push(format!(
            "{ALLOW_FILE}: must be an object whose only key is allow, a list"
        ));
        return (allowances, problems);
    };
    for (index, entry) in entries.iter().enumerate() {
        let field = |name: &str| {
            entry
                .get(name)
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())
        };
        let well_formed = entry.as_object().is_some_and(|object| object.len() == 4);
        match (field("class"), field("file"), field("match"), field("reason")) {
            (Some(class), Some(file), Some(text), Some(_)) if well_formed => allowances.push(Allowance { class: class.to_owned(), file: file.to_owned(), text: text.to_owned() }),
            _ => problems.push(format!("{ALLOW_FILE}: entry {index} must have exactly the non-empty strings class, file, match and reason")),
        }
    }
    (allowances, problems)
}

/// Everything of a known class on one line, in the order of the classes above.
fn scan_line(line: &str) -> Vec<Finding> {
    let mut found = Vec::new();
    anthropic_keys(line, &mut found);
    jwts(line, &mut found);
    bearers_and_cookies(line, &mut found);
    uuids(line, &mut found);
    prefixed_ids(line, &mut found);
    emails(line, &mut found);
    addresses(line, &mut found);
    home_paths(line, &mut found);
    found
}

fn is_base64url(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-'
}

/// The longest run from `start` of bytes satisfying `accept`.
fn run_from(bytes: &[u8], start: usize, accept: impl Fn(u8) -> bool) -> &str {
    let length = bytes[start..]
        .iter()
        .take_while(|byte| accept(**byte))
        .count();
    std::str::from_utf8(&bytes[start..start + length]).unwrap_or("")
}

/// Whether the byte before `index` is absent or neither a letter, digit nor underscore.
fn at_word_start(bytes: &[u8], index: usize) -> bool {
    index == 0 || !(bytes[index - 1].is_ascii_alphanumeric() || bytes[index - 1] == b'_')
}

fn occurrences<'a>(line: &'a str, needle: &'a str) -> impl Iterator<Item = usize> + 'a {
    line.match_indices(needle).map(|(index, _)| index)
}

fn anthropic_keys(line: &str, found: &mut Vec<Finding>) {
    let bytes = line.as_bytes();
    for index in occurrences(line, "sk-ant-") {
        let body = run_from(bytes, index + "sk-ant-".len(), is_base64url);
        let made_up = body
            .split_once('-')
            .is_some_and(|(_, filler)| filler.starts_with("FAKE"));
        if body.len() >= VALUE_MIN && !made_up {
            found.push(finding(
                "anthropic-key",
                &line[index..index + "sk-ant-".len() + body.len()],
            ));
        }
    }
}

fn jwts(line: &str, found: &mut Vec<Finding>) {
    let bytes = line.as_bytes();
    for index in occurrences(line, "eyJ") {
        if index > 0 && is_base64url(bytes[index - 1]) {
            continue;
        }
        let header = run_from(bytes, index, is_base64url);
        let payload_start = index + header.len() + 1;
        if bytes.get(payload_start - 1) != Some(&b'.') || payload_start >= bytes.len() {
            continue;
        }
        let payload = run_from(bytes, payload_start, is_base64url);
        let signature_start = payload_start + payload.len() + 1;
        if payload.len() < 2 || bytes.get(signature_start - 1) != Some(&b'.') {
            continue;
        }
        let signature = if signature_start <= bytes.len() {
            run_from(bytes, signature_start, is_base64url)
        } else {
            ""
        };
        if header.len() >= 10 && !signature.starts_with("ZmFrZQ") {
            found.push(finding(
                "jwt",
                &line[index..signature_start + signature.len()],
            ));
        }
    }
}

fn is_credential_char(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || b"._~+/%=-".contains(&byte)
}

fn bearers_and_cookies(line: &str, found: &mut Vec<Finding>) {
    let bytes = line.as_bytes();
    let lower = line.to_ascii_lowercase();
    for index in occurrences(&lower, "bearer ") {
        if !at_word_start(bytes, index) {
            continue;
        }
        let value = run_from(bytes, index + "bearer ".len(), is_credential_char);
        if value.len() >= VALUE_MIN && !value.starts_with("FAKE") {
            found.push(finding("bearer-token", value));
        }
    }
    for index in occurrences(&lower, "cookie") {
        let after = index + "cookie".len();
        let separators = run_from(bytes, after, |byte| b"\"': =".contains(&byte));
        if !separators.contains([':', '=']) {
            continue;
        }
        let pair = run_from(bytes, after + separators.len(), is_credential_char);
        let value = pair.split_once('=').map_or(pair, |(_, value)| value);
        if value.len() >= VALUE_MIN && !value.starts_with("FAKE") {
            found.push(finding("cookie-value", value));
        }
    }
}

fn is_uuid_at(bytes: &[u8], start: usize) -> bool {
    const SHAPE: [usize; 5] = [8, 4, 4, 4, 12];
    let mut index = start;
    for (position, length) in SHAPE.iter().enumerate() {
        if position > 0 {
            if bytes.get(index) != Some(&b'-') {
                return false;
            }
            index += 1;
        }
        if !bytes
            .get(index..index + length)
            .is_some_and(|group| group.iter().all(u8::is_ascii_hexdigit))
        {
            return false;
        }
        index += length;
    }
    bytes
        .get(index)
        .is_none_or(|next| !next.is_ascii_alphanumeric())
}

fn uuids(line: &str, found: &mut Vec<Finding>) {
    const LENGTH: usize = 36;
    let bytes = line.as_bytes();
    for index in 0..bytes.len() {
        let starts_here = index == 0 || !bytes[index - 1].is_ascii_alphanumeric();
        if starts_here && is_uuid_at(bytes, index) {
            let text = &line[index..index + LENGTH];
            if !text.starts_with(FAKE_UUID_PREFIX) {
                found.push(finding("uuid", text));
            }
        }
    }
}

fn prefixed_ids(line: &str, found: &mut Vec<Finding>) {
    let bytes = line.as_bytes();
    for prefix in ID_PREFIXES {
        for index in occurrences(line, prefix) {
            if !at_word_start(bytes, index) {
                continue;
            }
            let filler = run_from(bytes, index + prefix.len(), |byte| {
                byte.is_ascii_alphanumeric()
            });
            if filler.len() >= ID_FILLER_MIN && !filler.bytes().all(|byte| byte.is_ascii_digit()) {
                found.push(finding(
                    "prefixed-id",
                    &line[index..index + prefix.len() + filler.len()],
                ));
            }
        }
    }
}

fn emails(line: &str, found: &mut Vec<Finding>) {
    let bytes = line.as_bytes();
    for index in occurrences(line, "@") {
        let local_start = (0..index)
            .rev()
            .take_while(|position| {
                bytes[*position].is_ascii_alphanumeric() || b"._%+-".contains(&bytes[*position])
            })
            .last();
        let Some(local_start) = local_start else {
            continue;
        };
        let domain = run_from(bytes, index + 1, |byte| {
            byte.is_ascii_alphanumeric() || byte == b'.' || byte == b'-'
        })
        .trim_end_matches(['.', '-']);
        let last_label = domain.rsplit('.').next().unwrap_or("");
        let looks_like_a_domain = domain.contains('.')
            && last_label.len() >= 2
            && last_label.bytes().all(|byte| byte.is_ascii_alphabetic());
        if looks_like_a_domain
            && !matches!(
                domain.to_ascii_lowercase().as_str(),
                "example.com" | "example.org"
            )
        {
            found.push(finding(
                "email",
                &line[local_start..index + 1 + domain.len()],
            ));
        }
    }
}

fn addresses(line: &str, found: &mut Vec<Finding>) {
    let bytes = line.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if !bytes[index].is_ascii_digit() {
            index += 1;
            continue;
        }
        let candidate = run_from(bytes, index, |byte| byte.is_ascii_digit() || byte == b'.');
        let octets: Vec<&str> = candidate.trim_end_matches('.').split('.').collect();
        let numbers: Vec<u8> = octets
            .iter()
            .filter(|octet| (1..=3).contains(&octet.len()))
            .filter_map(|octet| octet.parse().ok())
            .collect();
        if octets.len() == 4 && numbers.len() == 4 {
            let documentation = numbers[..3] == [192, 0, 2];
            if numbers[0] != 127 && !documentation {
                found.push(finding("ipv4-address", candidate.trim_end_matches('.')));
            }
        }
        index += candidate.len();
    }
}

fn home_paths(line: &str, found: &mut Vec<Finding>) {
    let bytes = line.as_bytes();
    let lower = line.to_ascii_lowercase();
    for needle in ["/Users/", "/home/"] {
        for index in occurrences(line, needle) {
            if !at_word_start(bytes, index) {
                continue;
            }
            let name = run_from(bytes, index + needle.len(), |byte| {
                byte.is_ascii_alphanumeric() || b"._-".contains(&byte)
            });
            if !name.is_empty() && name != "." {
                found.push(finding(
                    "home-path",
                    &line[index..index + needle.len() + name.len()],
                ));
            }
        }
    }
    for needle in [":\\users\\", ":\\\\users\\\\"] {
        for index in occurrences(&lower, needle) {
            let name = run_from(bytes, index + needle.len(), |byte| {
                byte.is_ascii_alphanumeric() || b"._-".contains(&byte)
            });
            if !name.is_empty() && name != "." {
                found.push(finding(
                    "home-path",
                    &line[index.saturating_sub(1)..index + needle.len() + name.len()],
                ));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A value built from parts, so this file never holds a string a secret scanner would take for a real one.
    fn join(parts: &[&str]) -> String {
        parts.concat()
    }

    /// One made-up value of each class, in the shape a real one has, and the class each must be reported as.
    fn real_shaped() -> Vec<(&'static str, String)> {
        vec![
            (
                "anthropic-key",
                join(&["sk", "-ant-", "oat01-", "Zk3Jq8Lm2Xv9Rt5Wy7Nb4Hc6"]),
            ),
            (
                "jwt",
                join(&[
                    "ey",
                    "JhbGciOiJIUzI1NiJ9.",
                    "eyJzdWIiOiJ1c2VyIn0.",
                    "c2lnbmF0dXJlMTIzNDU2",
                ]),
            ),
            (
                "bearer-token",
                join(&["Authorization: Bear", "er ", "q8Zk3Jm2Xv9Rt5Wy7Nb4"]),
            ),
            (
                "cookie-value",
                join(&["Set-Coo", "kie: sess=", "q8Zk3Jm2Xv9Rt5Wy7Nb4"]),
            ),
            (
                "uuid",
                join(&["123e4567-", "e89b-12d3-", "a456-426614174000"]),
            ),
            (
                "prefixed-id",
                join(&["ms", "g_", "01XFDUDYJgAACzvnptvVoYEL"]),
            ),
            (
                "prefixed-id",
                join(&["toolu", "_", "01A09q90qw90lq917835lq9"]),
            ),
            (
                "prefixed-id",
                join(&["cs", "e_", "01XFDUDYJgAACzvnptvVoYEL"]),
            ),
            (
                "prefixed-id",
                join(&["sess", "ion_", "01XFDUDYJgAACzvnptvVoYEL"]),
            ),
            (
                "prefixed-id",
                join(&["en", "v_", "01XFDUDYJgAACzvnptvVoYEL"]),
            ),
            (
                "prefixed-id",
                join(&["re", "q_", "011CUDYJgAACzvnptvVoYEL"]),
            ),
            (
                "prefixed-id",
                join(&["srvtoo", "lu_", "01A09q90qw90lq917835lq9"]),
            ),
            (
                "cookie-value",
                join(&["\"coo", "kie\": \"sess=", "q8Zk3Jm2Xv9Rt5Wy7Nb4\""]),
            ),
            ("email", join(&["jane.doe", "@", "company.co.uk"])),
            ("email", join(&["a", "@", "mail.example.com"])),
            ("ipv4-address", join(&["10", ".4.", "17.201"])),
            ("ipv4-address", join(&["192", ".0.", "3.1"])),
            ("ipv4-address", join(&["128", ".1.", "2.3"])),
            ("home-path", join(&["/Us", "ers/", "jane/project"])),
            ("home-path", join(&["/ho", "me/", "jane/.config"])),
            ("home-path", join(&["C:", "\\Users\\", "jane\\project"])),
            ("home-path", join(&["C:", "\\\\Users\\\\", "jane"])),
        ]
    }

    /// The same classes in the made-up forms a scrubber writes, none of which may be reported.
    fn made_up() -> Vec<String> {
        vec![
            join(&["sk", "-ant-", "oat01-", "FAKEZk3Jq8Lm2Xv9Rt5Wy7Nb4"]),
            join(&[
                "ey",
                "JhbGciOiJIUzI1NiJ9.",
                "eyJmYWtlIjp0cnVlfQ.",
                "ZmFrZQAAAAAAAAAA",
            ]),
            join(&["Authorization: Bear", "er ", "FAKEq8Zk3Jm2Xv9Rt5Wy7Nb4"]),
            join(&["Set-Coo", "kie: sess=", "FAKEq8Zk3Jm2Xv9Rt5Wy7Nb4"]),
            "00000000-0000-4000-8000-000000000001".to_owned(),
            join(&["ms", "g_", "0000000000000000000001"]),
            "user1@example.com and user2@example.org".to_owned(),
            "127.0.0.1 and 192.0.2.7 and 192.0.2.255 and 127.8.9.10".to_owned(),
            "A@Example.COM".to_owned(),
            "$HOME/project and /tmp/work and /home".to_owned(),
            "session_id, request_id, env_file, the cookie value, a bearer or cookie".to_owned(),
            "pnpm@12.4.1 taiki-e/install-action@v2 cargo-deny@0.20.2 1.2.3 version 10.20.30"
                .to_owned(),
        ]
    }

    #[test]
    fn every_class_of_real_shaped_value_is_reported() {
        for (class, value) in real_shaped() {
            let classes: Vec<&str> = scan_line(&format!("\"value\": \"{value}\""))
                .iter()
                .map(|found| found.class)
                .collect();
            assert!(
                classes.contains(&class),
                "{class} was not reported for a value of its shape: got {classes:?}"
            );
        }
    }

    #[test]
    fn made_up_forms_and_prose_are_not_reported() {
        for value in made_up() {
            assert_eq!(scan_line(&value), Vec::<Finding>::new(), "{value}");
        }
    }

    #[test]
    fn an_exception_is_matched_by_class_file_and_exact_text() {
        let document: Value = serde_json::from_str(r#"{"allow":[{"class":"home-path","file":"a/b.json","match":"/home/u","reason":"made up"}]}"#).expect("valid JSON");
        let (allowances, problems) = allowances_from(&document);
        assert_eq!((allowances.len(), problems), (1, Vec::<String>::new()));
        assert_eq!(
            allowances[0],
            Allowance {
                class: "home-path".to_owned(),
                file: "a/b.json".to_owned(),
                text: "/home/u".to_owned()
            }
        );
    }

    #[test]
    fn a_malformed_exception_is_a_problem() {
        for text in [
            r#"{"allow":[{"class":"home-path","file":"a","match":"x"}]}"#,
            r#"{"allow":[{"class":"home-path","file":"a","match":"x","reason":""}]}"#,
            r#"{"allow":[{"class":"home-path","file":"a","match":"x","reason":"r","extra":1}]}"#,
            r#"{"allow":[],"other":1}"#,
            "[]",
        ] {
            let document: Value = serde_json::from_str(text).expect("valid JSON");
            assert_eq!(allowances_from(&document).1.len(), 1, "{text}");
        }
    }

    /// A throwaway corpus root under the system temporary directory, removed when dropped.
    struct Root(PathBuf);

    impl Root {
        fn new(name: &str, allow: &str, files: &[(&str, &str)]) -> Self {
            let path = std::env::temp_dir()
                .join(format!("agent-shim-scrub-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir_all(&path).expect("create the root");
            std::fs::write(path.join(ALLOW_FILE), allow).expect("write the exceptions");
            for (file, text) in files {
                let target = path.join(file);
                std::fs::create_dir_all(target.parent().expect("a parent"))
                    .expect("create the directory");
                std::fs::write(target, text).expect("write the file");
            }
            Self(path)
        }
    }

    impl Drop for Root {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn a_tree_of_real_shaped_values_is_reported_by_file_and_line_and_never_by_value() {
        let text = real_shaped()
            .iter()
            .map(|(_, value)| value.clone())
            .collect::<Vec<_>>()
            .join("\n");
        let root = Root::new(
            "reports",
            r#"{"allow":[]}"#,
            &[("function/x.json", &text), ("function/clean.json", "{}")],
        );
        let problems = check_tree(&root.0).expect("the check runs");
        assert!(problems.len() >= real_shaped().len(), "{problems:?}");
        assert!(
            problems
                .iter()
                .all(|problem| problem.starts_with("function/x.json:")),
            "{problems:?}"
        );
        for (_, value) in real_shaped() {
            assert!(
                problems.iter().all(|problem| !problem.contains(&value)),
                "a value was printed: {problems:?}"
            );
        }
    }

    #[test]
    fn a_clean_tree_passes_and_an_exception_exempts_exactly_its_file_and_text() {
        let home = join(&["/Us", "ers/", "jane"]);
        let allow = format!(
            r#"{{"allow":[{{"class":"home-path","file":"function/x.json","match":"{home}","reason":"made up"}}]}}"#
        );
        let covered = Root::new(
            "covered",
            &allow,
            &[
                ("function/x.json", &format!("\"{home}/a\"")),
                ("function/y.json", "{}"),
            ],
        );
        assert_eq!(
            check_tree(&covered.0).expect("the check runs"),
            Vec::<String>::new()
        );
        let other_file = Root::new(
            "other-file",
            &allow,
            &[
                ("function/x.json", &format!("\"{home}/a\"")),
                ("function/y.json", &format!("\"{home}/a\"")),
            ],
        );
        assert_eq!(
            check_tree(&other_file.0).expect("the check runs"),
            ["function/y.json:1: home-path"]
        );
        let other_text = Root::new(
            "other-text",
            &allow,
            &[("function/x.json", &format!("\"{home}2/a\""))],
        );
        assert_eq!(check_tree(&other_text.0).expect("the check runs").len(), 2);
    }

    #[test]
    fn an_exception_nothing_matches_is_a_problem() {
        let allow = r#"{"allow":[{"class":"email","file":"function/x.json","match":"a@b.example","reason":"r"}]}"#;
        let root = Root::new("unused", allow, &[("function/x.json", "{}")]);
        assert_eq!(
            check_tree(&root.0).expect("the check runs"),
            ["scrub-allow.json: the email exception for function/x.json matches nothing"]
        );
    }

    #[test]
    fn the_file_of_exceptions_is_not_scanned_and_a_file_that_is_not_utf8_is_read_lossily() {
        let home = join(&["/Us", "ers/", "jane"]);
        let allow = format!(
            r#"{{"allow":[{{"class":"home-path","file":"x.json","match":"{home}","reason":"made up"}}]}}"#
        );
        let root = Root::new("not-scanned", &allow, &[("x.json", &format!("\"{home}\""))]);
        std::fs::write(root.0.join("binary.json"), [0xff_u8, 0xfe, b'{', b'}'])
            .expect("write the file");
        assert_eq!(
            check_tree(&root.0).expect("the check runs"),
            Vec::<String>::new()
        );
    }
}
