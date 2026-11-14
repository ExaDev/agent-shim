//! `corpus scrub-check`: nothing under `conformance/` is shaped like a real credential, identifier, address or home
//! directory.
//!
//! The corpus is public and its cases are written from real tests and recorded traffic, so the check knows shapes and
//! not values. A value of a known class (see [`CLASSES`]) passes only in the form a scrubber writes: a made-up filler,
//! a reserved namespace or a documentation address.
//!
//! What is scanned is what the files mean, not only what they spell. A JSON file is parsed, so a value written with
//! `\u` escapes is read as the text it stands for, and every string and every object key is scanned. The encodings the
//! case format gives for content are decoded and scanned too: the bytes of a `base64` file body (as text, and as JSON
//! when they parse), the code units of a `codeUnits` array, and the members of `$object` and `$number` wrappers, which
//! are plain strings and arrays. A test lists the forms in `case.schema.json` and fails when the schema gains one this
//! file does not handle. The format never concatenates fields, so nothing is assembled from several strings.
//!
//! A finding is located by file and JSON pointer (`line N` for a file that is not JSON). A deliberate exception is an
//! entry in `conformance/scrub-allow.json` bound to one class, one file, one pointer and the SHA-256 of the finding's
//! text, with a reason: a value that changes, moves or appears a second time is a new finding, an entry holds a hash
//! and never a value, and a class that must never be committed cannot be allowed at all. An entry nothing matches is
//! itself a problem. The allow file is scanned like every other file.
//!
//! A problem names the class, the file and the location and never the text, since the log of a public repository must
//! not carry what the check found. The location of a finding inside an object key is the index of the key, for the
//! same reason.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::error::TaskError;
use crate::sha256::hex_digest;

/// The file of exceptions, directly under the corpus root.
const ALLOW_FILE: &str = "scrub-allow.json";

/// The least filler length of a prefixed id that counts as an id, so identifiers in prose and code (`session_id`) do not.
const ID_FILLER_MIN: usize = 16;

/// The least length of a token or value that counts as a credential.
const VALUE_MIN: usize = 8;

/// The least length of the body of an `sk-` key.
const API_KEY_MIN: usize = 20;

/// Digits of the two lengths of a hexadecimal session id: 128 bits and 256 bits.
const HEX_ID_LENGTHS: [usize; 2] = [32, 64];

/// The namespace of made-up UUIDs.
const FAKE_UUID_PREFIX: &str = "00000000-0000-4000-8000-";

/// Zeros a made-up hexadecimal id starts with.
const FAKE_HEX_PREFIX: &str = "0000000000000000";

/// What the loader does with a class: the name a finding carries, whether an exception may name it, and the sentence
/// the README gives. The README's list is generated from this table (`xtask corpus scrub-classes`) and a test fails
/// when they differ.
pub struct Class {
    pub name: &'static str,
    pub allowable: bool,
    pub summary: &'static str,
}

/// Every class the check knows, in the order the README lists them.
pub const CLASSES: &[Class] = &[
    Class {
        name: "anthropic-key",
        allowable: false,
        summary: "an Anthropic key (the `sk-ant-` prefix) whose filler is not the made-up form",
    },
    Class {
        name: "api-key",
        allowable: false,
        summary: "an `sk-` or `sk-proj-` key of 20 or more characters whose filler is not the made-up form",
    },
    Class {
        name: "github-token",
        allowable: false,
        summary: "a GitHub token (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_` or `github_pat_` with its filler)",
    },
    Class {
        name: "aws-key-id",
        allowable: false,
        summary: "an AWS access key id (`AKIA` or `ASIA` and 16 upper-case letters or digits)",
    },
    Class {
        name: "jwt",
        allowable: false,
        summary: "a JWT whose signature is not the made-up form",
    },
    Class {
        name: "bearer-token",
        allowable: false,
        summary: "a bearer value in any case that is not the made-up form",
    },
    Class {
        name: "basic-auth",
        allowable: false,
        summary: "a `Basic` authorisation value that decodes to a user and password",
    },
    Class {
        name: "cookie-value",
        allowable: false,
        summary: "the value of any pair of a `Cookie` header, and of a session cookie named anywhere",
    },
    Class {
        name: "private-key",
        allowable: false,
        summary: "a PEM or OpenSSH private key, by its header line or its base64 body",
    },
    Class {
        name: "uuid",
        allowable: false,
        summary: "a UUID outside the made-up namespace",
    },
    Class {
        name: "prefixed-id",
        allowable: false,
        summary: "an id with a known prefix (`cse_`, `session_`, `env_`, `msg_`, `req_`, `toolu_`, `srvtoolu_`, `org_`, `user_`, `acct_`, `account_`, `worker_`) whose filler is not made-up",
    },
    Class {
        name: "hex-id",
        allowable: true,
        summary: "32 or 64 hexadecimal digits not starting with sixteen zeros",
    },
    Class {
        name: "email",
        allowable: true,
        summary: "an email address, or a URL with userinfo, outside `example.com` and `example.org`",
    },
    Class {
        name: "ipv4-address",
        allowable: true,
        summary: "an IPv4 address outside loopback and 192.0.2.0/24",
    },
    Class {
        name: "home-path",
        allowable: true,
        summary: "a path under a home directory (`/Users/`, `/home/`, `/root/` or `C:\\Users\\`)",
    },
    Class {
        name: "host-name",
        allowable: true,
        summary: "a host name ending `.local`, `.lan`, `.internal`, `.localdomain`, `.home.arpa` or `.ts.net`",
    },
    Class {
        name: "ssh-target",
        allowable: true,
        summary: "the `user@host` an `ssh` command names, outside `example.com` and `example.org`",
    },
];

/// The line the README gives a class, with the start and end markers around the lot.
pub fn class_lines() -> Vec<String> {
    CLASSES
        .iter()
        .map(|class| {
            let exception = if class.allowable {
                "an exception may be recorded"
            } else {
                "never an exception"
            };
            format!("- `{}`: {} ({exception})", class.name, class.summary)
        })
        .collect()
}

/// A made-up filler: `FAKE` and then only digits and the letter `A`, which is how a scrubber writes a counter and
/// padding. A real value with `FAKE` put in front of it is not this form.
fn is_fake(text: &str) -> bool {
    text.strip_prefix("FAKE").is_some_and(|rest| {
        rest.bytes()
            .all(|byte| byte.is_ascii_digit() || byte == b'A')
    })
}

/// One thing found in a piece of text: its class and the text, which is hashed to match an exception and never shown.
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

/// A finding and where it is: a JSON pointer, or `line N`.
#[derive(Debug, PartialEq, Eq)]
struct Located {
    pointer: String,
    finding: Finding,
}

/// One exception, as written in `scrub-allow.json`.
#[derive(Debug, PartialEq, Eq)]
struct Allowance {
    class: String,
    file: String,
    pointer: String,
    sha256: String,
}

/// What is wrong under the corpus root, or the fault that stopped the check.
pub fn run() -> Result<Vec<String>, TaskError> {
    check_tree(&corpus_root())
}

/// The exceptions every current finding of an allowable class would need, as the JSON entries to complete with a
/// reason and add to the allow file.
pub fn suggest() -> Result<Vec<String>, TaskError> {
    let root = corpus_root();
    let mut entries = Vec::new();
    for (file, located) in findings_under(&root)? {
        let allowable = CLASSES
            .iter()
            .any(|class| class.name == located.finding.class && class.allowable);
        if allowable {
            entries.push(serde_json::json!({
                "class": located.finding.class,
                "file": file,
                "pointer": located.pointer,
                "sha256": hex_digest(located.finding.text.as_bytes()),
                "reason": "",
            }));
        }
    }
    Ok(vec![
        serde_json::to_string_pretty(&serde_json::json!({ "allow": entries })).map_err(
            |source| TaskError::Json {
                what: "the suggested exceptions".to_owned(),
                detail: source.to_string(),
            },
        )?,
    ])
}

fn corpus_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../conformance")
}

fn check_tree(root: &Path) -> Result<Vec<String>, TaskError> {
    let (allowances, mut problems) = read_allowances(&root.join(ALLOW_FILE))?;
    let mut used = BTreeSet::new();
    for (file, located) in findings_under(root)? {
        let hash = hex_digest(located.finding.text.as_bytes());
        let allowed = CLASSES
            .iter()
            .any(|class| class.name == located.finding.class && class.allowable);
        let matching = allowances.iter().enumerate().find(|(position, allowance)| {
            allowed
                && !used.contains(position)
                && allowance.class == located.finding.class
                && allowance.file == file
                && allowance.pointer == located.pointer
                && allowance.sha256 == hash
        });
        match matching {
            Some((position, _)) => {
                used.insert(position);
            }
            None => problems.push(format!(
                "{file}: {}: {}",
                located.pointer, located.finding.class
            )),
        }
    }
    for (position, allowance) in allowances.iter().enumerate() {
        if !used.contains(&position) {
            problems.push(format!(
                "{ALLOW_FILE}: the {} exception for {} at {} matches nothing",
                allowance.class, allowance.file, allowance.pointer
            ));
        }
    }
    Ok(problems)
}

/// Every finding in every file under `root`, with the file's path relative to it.
fn findings_under(root: &Path) -> Result<Vec<(String, Located)>, TaskError> {
    let mut found = Vec::new();
    for path in files_under(root)? {
        let relative = path.strip_prefix(root).map_or_else(
            |_| path.display().to_string(),
            |rest| rest.to_string_lossy().replace('\\', "/"),
        );
        let bytes = std::fs::read(&path).map_err(|source| TaskError::Io {
            path: path.clone(),
            source,
        })?;
        let text = String::from_utf8_lossy(&bytes);
        let mut located = Vec::new();
        match serde_json::from_str::<Value>(&text) {
            Ok(document) if relative.ends_with(".json") => walk(&document, "", &mut located),
            _ => {
                for (index, line) in text.lines().enumerate() {
                    for finding in scan_line(line) {
                        located.push(Located {
                            pointer: format!("line {}", index + 1),
                            finding,
                        });
                    }
                }
            }
        }
        for entry in located {
            // The allow file's digests are 64 hexadecimal digits by construction.
            let a_digest = relative == ALLOW_FILE
                && entry.finding.class == "hex-id"
                && entry.pointer.ends_with("/sha256");
            if !a_digest {
                found.push((relative.clone(), entry));
            }
        }
    }
    Ok(found)
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

/// The exceptions in the file, and what is wrong with the file itself.
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
        let well_formed = entry.as_object().is_some_and(|object| object.len() == 5);
        let digest = field("sha256").filter(|text| {
            text.len() == 64
                && text
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        });
        match (field("class"), field("file"), field("pointer"), digest, field("reason")) {
            (Some(class), Some(file), Some(pointer), Some(sha256), Some(_)) if well_formed => {
                match CLASSES.iter().find(|known| known.name == class) {
                    Some(known) if known.allowable => allowances.push(Allowance { class: class.to_owned(), file: file.to_owned(), pointer: pointer.to_owned(), sha256: sha256.to_owned() }),
                    Some(_) => problems.push(format!("{ALLOW_FILE}: entry {index} names {class}, which is never an exception")),
                    None => problems.push(format!("{ALLOW_FILE}: entry {index} names a class the check does not know")),
                }
            }
            _ => problems.push(format!("{ALLOW_FILE}: entry {index} must have exactly the non-empty strings class, file, pointer, reason and a lower-case sha256 of 64 digits")),
        }
    }
    (allowances, problems)
}

// ---- reading the files as what they mean

/// The pointer segment for an object key, as RFC 6901 writes it.
fn escape(key: &str) -> String {
    key.replace('~', "~0").replace('/', "~1")
}

fn walk(value: &Value, pointer: &str, out: &mut Vec<Located>) {
    match value {
        Value::String(text) => scan_string(text, pointer, out),
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                walk(item, &format!("{pointer}/{index}"), out);
            }
        }
        Value::Object(map) => {
            if let Some(text) = code_units_text(value) {
                scan_string(&text, &format!("{pointer}/codeUnits"), out);
            }
            if let Some(Value::String(encoded)) = map.get("base64")
                && let Some(bytes) = decode_base64(encoded)
            {
                let text = String::from_utf8_lossy(&bytes);
                scan_string(&text, &format!("{pointer}/base64|decoded"), out);
                if let Ok(inner) = serde_json::from_str::<Value>(&text) {
                    walk(&inner, &format!("{pointer}/base64|json"), out);
                }
            }
            for (position, (key, item)) in map.iter().enumerate() {
                let found = scan_text(key);
                let segment = if found.is_empty() {
                    escape(key)
                } else {
                    format!("[{position}]")
                };
                for finding in found {
                    out.push(Located {
                        pointer: format!("{pointer}/{segment}#key"),
                        finding,
                    });
                }
                walk(item, &format!("{pointer}/{segment}"), out);
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

/// The text a `{ "codeUnits": [...] }` object stands for, with an unpaired surrogate read as U+FFFD.
fn code_units_text(value: &Value) -> Option<String> {
    let units = value
        .as_object()
        .filter(|object| object.len() == 1)?
        .get("codeUnits")?
        .as_array()?;
    let decoded: Option<Vec<u16>> = units
        .iter()
        .map(|unit| unit.as_u64().and_then(|number| u16::try_from(number).ok()))
        .collect();
    decoded.map(|units| String::from_utf16_lossy(&units))
}

fn scan_string(text: &str, pointer: &str, out: &mut Vec<Located>) {
    for finding in scan_text(text) {
        out.push(Located {
            pointer: pointer.to_owned(),
            finding,
        });
    }
}

fn scan_text(text: &str) -> Vec<Finding> {
    text.lines().flat_map(scan_line).collect()
}

/// Bytes of standard or URL-safe base64 with or without padding, or `None` when the text is not base64.
fn decode_base64(text: &str) -> Option<Vec<u8>> {
    let mut bits = 0_u32;
    let mut count = 0_u32;
    let mut bytes = Vec::new();
    for byte in text
        .trim()
        .trim_end_matches('=')
        .bytes()
        .filter(|byte| !byte.is_ascii_whitespace())
    {
        let digit = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            _ => return None,
        };
        bits = (bits << 6) | u32::from(digit);
        count += 6;
        if count >= 8 {
            count -= 8;
            bytes.push(u8::try_from((bits >> count) & 0xff).ok()?);
        }
    }
    Some(bytes)
}

// ---- the classes

/// Everything of a known class on one line, in the order of [`CLASSES`].
fn scan_line(line: &str) -> Vec<Finding> {
    let mut found = Vec::new();
    anthropic_keys(line, &mut found);
    api_keys(line, &mut found);
    github_tokens(line, &mut found);
    aws_key_ids(line, &mut found);
    jwts(line, &mut found);
    bearer_tokens(line, &mut found);
    basic_auth(line, &mut found);
    cookie_values(line, &mut found);
    private_keys(line, &mut found);
    uuids(line, &mut found);
    prefixed_ids(line, &mut found);
    hex_ids(line, &mut found);
    emails(line, &mut found);
    addresses(line, &mut found);
    home_paths(line, &mut found);
    host_names(line, &mut found);
    ssh_targets(line, &mut found);
    found
}

fn is_base64url(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-'
}

fn is_credential_char(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || b"._~+/%=-".contains(&byte)
}

/// The longest run from `start` of bytes satisfying `accept`, which must only accept ASCII.
fn run_from(bytes: &[u8], start: usize, accept: impl Fn(u8) -> bool) -> &str {
    let length = bytes.get(start..).map_or(0, |rest| {
        rest.iter().take_while(|byte| accept(**byte)).count()
    });
    std::str::from_utf8(&bytes[start..start + length]).unwrap_or("")
}

/// Whether the byte before `index` is a letter or digit, which makes the match the tail of a longer word.
fn follows_alphanumeric(bytes: &[u8], index: usize) -> bool {
    index > 0 && bytes[index - 1].is_ascii_alphanumeric()
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
            .is_some_and(|(_, filler)| is_fake(filler));
        if body.len() >= VALUE_MIN && !made_up {
            found.push(finding(
                "anthropic-key",
                &line[index..index + "sk-ant-".len() + body.len()],
            ));
        }
    }
}

fn api_keys(line: &str, found: &mut Vec<Finding>) {
    let bytes = line.as_bytes();
    for index in occurrences(line, "sk-") {
        if index > 0
            && (bytes[index - 1].is_ascii_alphanumeric() || b"_-".contains(&bytes[index - 1]))
        {
            continue;
        }
        let body = run_from(bytes, index + "sk-".len(), is_base64url);
        if body.starts_with("ant-") {
            continue;
        }
        let filler = body.strip_prefix("proj-").unwrap_or(body);
        if body.len() >= API_KEY_MIN && !is_fake(filler) {
            found.push(finding(
                "api-key",
                &line[index..index + "sk-".len() + body.len()],
            ));
        }
    }
}

fn github_tokens(line: &str, found: &mut Vec<Finding>) {
    const CLASSIC_FILLER: usize = 36;
    const FINE_GRAINED_FILLER: usize = 22;
    let bytes = line.as_bytes();
    for prefix in ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"] {
        for index in occurrences(line, prefix) {
            let filler = run_from(bytes, index + prefix.len(), |byte| {
                byte.is_ascii_alphanumeric()
            });
            if !follows_alphanumeric(bytes, index)
                && filler.len() >= CLASSIC_FILLER
                && !is_fake(filler)
            {
                found.push(finding(
                    "github-token",
                    &line[index..index + prefix.len() + filler.len()],
                ));
            }
        }
    }
    for index in occurrences(line, "github_pat_") {
        let filler = run_from(bytes, index + "github_pat_".len(), |byte| {
            byte.is_ascii_alphanumeric() || byte == b'_'
        });
        if !follows_alphanumeric(bytes, index)
            && filler.len() >= FINE_GRAINED_FILLER
            && !is_fake(filler)
        {
            found.push(finding(
                "github-token",
                &line[index..index + "github_pat_".len() + filler.len()],
            ));
        }
    }
}

fn aws_key_ids(line: &str, found: &mut Vec<Finding>) {
    const FILLER: usize = 16;
    let bytes = line.as_bytes();
    for prefix in ["AKIA", "ASIA"] {
        for index in occurrences(line, prefix) {
            let filler = run_from(bytes, index + prefix.len(), |byte| {
                byte.is_ascii_uppercase() || byte.is_ascii_digit()
            });
            let ends_here = bytes
                .get(index + prefix.len() + filler.len())
                .is_none_or(|next| !next.is_ascii_alphanumeric());
            if !follows_alphanumeric(bytes, index)
                && filler.len() == FILLER
                && ends_here
                && !is_fake(filler)
            {
                found.push(finding(
                    "aws-key-id",
                    &line[index..index + prefix.len() + FILLER],
                ));
            }
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
        let made_up = signature
            .strip_prefix("ZmFrZQ")
            .is_some_and(|rest| rest.bytes().all(|byte| byte == b'A'));
        if header.len() >= 10 && !made_up {
            found.push(finding(
                "jwt",
                &line[index..signature_start + signature.len()],
            ));
        }
    }
}

fn bearer_tokens(line: &str, found: &mut Vec<Finding>) {
    let bytes = line.as_bytes();
    let lower = line.to_ascii_lowercase();
    for index in occurrences(&lower, "bearer ") {
        if follows_alphanumeric(bytes, index) {
            continue;
        }
        let value = run_from(bytes, index + "bearer ".len(), is_credential_char);
        if value.len() >= VALUE_MIN && !is_fake(value) {
            found.push(finding("bearer-token", value));
        }
    }
}

fn basic_auth(line: &str, found: &mut Vec<Finding>) {
    let bytes = line.as_bytes();
    let lower = line.to_ascii_lowercase();
    for index in occurrences(&lower, "basic ") {
        if follows_alphanumeric(bytes, index) {
            continue;
        }
        let value = run_from(bytes, index + "basic ".len(), is_credential_char);
        let pair = decode_base64(value).is_some_and(|decoded| decoded.contains(&b':'));
        if value.len() >= VALUE_MIN && !is_fake(value) && pair {
            found.push(finding("basic-auth", value));
        }
    }
}

fn cookie_values(line: &str, found: &mut Vec<Finding>) {
    const SESSION_NAMES: [&str; 6] = [
        "sessionkey",
        "sessionid",
        "session_id",
        "sid",
        "auth_token",
        "refresh_token",
    ];
    let bytes = line.as_bytes();
    let lower = line.to_ascii_lowercase();
    let mut report = |value: &str| {
        if value.len() >= VALUE_MIN && !is_fake(value) {
            found.push(finding("cookie-value", value));
        }
    };
    for index in occurrences(&lower, "cookie") {
        let after = index + "cookie".len();
        let separators = run_from(bytes, after, |byte| b"\"': =".contains(&byte));
        if !separators.contains([':', '=']) {
            continue;
        }
        let start = after + separators.len();
        let end = line[start..]
            .find(['"', '\'', '\\'])
            .map_or(line.len(), |offset| start + offset);
        for pair in line[start..end].split(';') {
            let value = pair.split_once('=').map_or(pair, |(_, value)| value).trim();
            report(run_from(value.as_bytes(), 0, is_credential_char));
        }
    }
    for name in SESSION_NAMES {
        for index in occurrences(&lower, name) {
            if follows_alphanumeric(bytes, index) || bytes.get(index + name.len()) != Some(&b'=') {
                continue;
            }
            report(run_from(bytes, index + name.len() + 1, is_credential_char));
        }
    }
}

fn private_keys(line: &str, found: &mut Vec<Finding>) {
    const DER_START: &str = "MII";
    const OPENSSH_START: &str = "b3BlbnNzaC1rZXk";
    const BODY_MIN: usize = 40;
    if let Some(index) = line.find("-----BEGIN ")
        && line[index..].contains("PRIVATE KEY-----")
    {
        found.push(finding("private-key", line.trim()));
    }
    let bytes = line.as_bytes();
    for start in [DER_START, OPENSSH_START] {
        for index in occurrences(line, start) {
            let continues_a_token = index > 0
                && (bytes[index - 1].is_ascii_alphanumeric() || b"+/=".contains(&bytes[index - 1]));
            let body = run_from(bytes, index, |byte| {
                byte.is_ascii_alphanumeric() || b"+/=".contains(&byte)
            });
            if !continues_a_token && body.len() >= BODY_MIN {
                found.push(finding("private-key", body));
            }
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
        if !follows_alphanumeric(bytes, index) && is_uuid_at(bytes, index) {
            let text = &line[index..index + LENGTH];
            if !text.starts_with(FAKE_UUID_PREFIX) {
                found.push(finding("uuid", text));
            }
        }
    }
}

fn prefixed_ids(line: &str, found: &mut Vec<Finding>) {
    const PREFIXES: [&str; 12] = [
        "cse_",
        "session_",
        "env_",
        "msg_",
        "req_",
        "toolu_",
        "srvtoolu_",
        "org_",
        "user_",
        "acct_",
        "account_",
        "worker_",
    ];
    let bytes = line.as_bytes();
    for prefix in PREFIXES {
        for index in occurrences(line, prefix) {
            if follows_alphanumeric(bytes, index) {
                continue;
            }
            let filler = run_from(bytes, index + prefix.len(), |byte| {
                byte.is_ascii_alphanumeric()
            });
            let digits_only = filler.bytes().all(|byte| byte.is_ascii_digit());
            if filler.len() >= ID_FILLER_MIN && !digits_only && !is_fake(filler) {
                found.push(finding(
                    "prefixed-id",
                    &line[index..index + prefix.len() + filler.len()],
                ));
            }
        }
    }
}

fn hex_ids(line: &str, found: &mut Vec<Finding>) {
    let bytes = line.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        let run = run_from(bytes, index, |byte| byte.is_ascii_alphanumeric());
        if run.is_empty() {
            index += 1;
            continue;
        }
        let is_hex = run.bytes().all(|byte| byte.is_ascii_hexdigit());
        if is_hex && HEX_ID_LENGTHS.contains(&run.len()) && !run.starts_with(FAKE_HEX_PREFIX) {
            found.push(finding("hex-id", run));
        }
        index += run.len();
    }
}

fn is_allowed_domain(domain: &str) -> bool {
    matches!(
        domain.to_ascii_lowercase().as_str(),
        "example.com" | "example.org"
    )
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
        if looks_like_a_domain && !is_allowed_domain(domain) {
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
    let is_name_char = |byte: u8| byte.is_ascii_alphanumeric() || b"._-".contains(&byte);
    for needle in ["/Users/", "/home/", "/root/"] {
        for index in occurrences(line, needle) {
            if follows_alphanumeric(bytes, index) {
                continue;
            }
            let name = run_from(bytes, index + needle.len(), is_name_char);
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
            let name = run_from(bytes, index + needle.len(), is_name_char);
            // The drive letter is one ASCII byte before the colon when there is one, so the start is a character boundary.
            let start = if index > 0 && bytes[index - 1].is_ascii_alphabetic() {
                index - 1
            } else {
                index
            };
            if !name.is_empty() && name != "." {
                found.push(finding(
                    "home-path",
                    &line[start..index + needle.len() + name.len()],
                ));
            }
        }
    }
}

fn host_names(line: &str, found: &mut Vec<Finding>) {
    const SUFFIXES: [&str; 6] = [
        ".local",
        ".lan",
        ".internal",
        ".localdomain",
        ".home.arpa",
        ".ts.net",
    ];
    let bytes = line.as_bytes();
    let lower = line.to_ascii_lowercase();
    for suffix in SUFFIXES {
        for index in occurrences(&lower, suffix) {
            let end = index + suffix.len();
            let continues = bytes.get(end).is_some_and(|next| {
                next.is_ascii_alphanumeric()
                    || *next == b'-'
                    || (*next == b'.' && bytes.get(end + 1).is_some_and(u8::is_ascii_alphanumeric))
            });
            let label_start = (0..index)
                .rev()
                .take_while(|position| {
                    bytes[*position].is_ascii_alphanumeric() || b"-.".contains(&bytes[*position])
                })
                .last();
            if let Some(start) = label_start
                && !continues
            {
                found.push(finding("host-name", &line[start..end]));
            }
        }
    }
}

/// How many words after `ssh` are searched for the target: options and their arguments come first.
const WORDS_BEFORE_TARGET: usize = 6;

fn ssh_targets(line: &str, found: &mut Vec<Finding>) {
    let lower = line.to_ascii_lowercase();
    let bytes = line.as_bytes();
    for index in occurrences(&lower, "ssh ") {
        if follows_alphanumeric(bytes, index) {
            continue;
        }
        // The target is the first word with an `@` among the words an `ssh` command line holds before its remote command, after any options and their arguments.
        let target = line[index + "ssh ".len()..]
            .split_whitespace()
            .take(WORDS_BEFORE_TARGET)
            .find(|word| word.contains('@'))
            .map(|word| word.trim_matches(['"', '\'', ';', ',']));
        if let Some(target) = target
            && let Some((_, host)) = target.split_once('@')
            && !is_allowed_domain(host)
        {
            found.push(finding("ssh-target", target));
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
                "anthropic-key",
                join(&["sk", "-ant-", "oat01-", "FAKEZk3Jq8Lm2Xv9Rt5Wy7Nb4"]),
            ),
            (
                "api-key",
                join(&["s", "k-proj-", "Zk3Jq8Lm2Xv9Rt5Wy7Nb4Hc6"]),
            ),
            ("api-key", join(&["s", "k-", "Zk3Jq8Lm2Xv9Rt5Wy7Nb4Hc6Pd"])),
            (
                "github-token",
                join(&["gh", "p_", "Zk3Jq8Lm2Xv9Rt5Wy7Nb4Hc6Pd1Qe2Rf3SgT"]),
            ),
            (
                "github-token",
                join(&["github", "_pat_", "Zk3Jq8Lm2Xv9Rt5Wy7Nb4Hc6Pd1Qe"]),
            ),
            ("aws-key-id", join(&["AK", "IA", "ZK3JQ8LM2XV9RT5W"])),
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
                "jwt",
                join(&[
                    "ey",
                    "JhbGciOiJIUzI1NiJ9.",
                    "eyJmYWtlIjp0cnVlfQ.",
                    "ZmFrZQreal",
                ]),
            ),
            (
                "bearer-token",
                join(&["Authorization: Bear", "er ", "q8Zk3Jm2Xv9Rt5Wy7Nb4"]),
            ),
            (
                "bearer-token",
                join(&["authorization: bear", "er ", "q8Zk3Jm2Xv9Rt5Wy7Nb4"]),
            ),
            (
                "bearer-token",
                join(&["Bear", "er ", "FAKEq8Zk3Jm2Xv9Rt5Wy7Nb4"]),
            ),
            (
                "basic-auth",
                join(&["Authorization: Bas", "ic ", "dXNlcjpwYXNzd29yZDEyMw=="]),
            ),
            (
                "cookie-value",
                join(&["Set-Coo", "kie: sess=", "q8Zk3Jm2Xv9Rt5Wy7Nb4"]),
            ),
            (
                "cookie-value",
                join(&["Coo", "kie: a=1; sessionKey=", "q8Zk3Jm2Xv9Rt5Wy7Nb4"]),
            ),
            (
                "cookie-value",
                join(&["\"coo", "kie\": \"sess=", "q8Zk3Jm2Xv9Rt5Wy7Nb4\""]),
            ),
            (
                "cookie-value",
                join(&["session", "Key=", "q8Zk3Jm2Xv9Rt5Wy7Nb4"]),
            ),
            (
                "cookie-value",
                join(&["Coo", "kie: a=1; tracker=", "q8Zk3Jm2Xv9Rt5Wy7Nb4"]),
            ),
            ("private-key", join(&["-----BEG", "IN PRIVATE KEY-----"])),
            (
                "private-key",
                join(&["-----BEG", "IN OPENSSH PRIVATE KEY-----"]),
            ),
            (
                "private-key",
                join(&["-----BEG", "IN RSA PRIVATE KEY-----"]),
            ),
            (
                "private-key",
                join(&["MI", "IEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7"]),
            ),
            (
                "private-key",
                join(&[
                    "b3BlbnNz",
                    "aC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAA",
                ]),
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
                "prefixed-id",
                join(&["or", "g_", "01XFDUDYJgAACzvnptvVoYEL"]),
            ),
            (
                "prefixed-id",
                join(&["parent_sess", "ion_", "01XFDUDYJgAACzvnptvVoYEL"]),
            ),
            (
                "hex-id",
                join(&["3f2a9c1d", "7be4408ea1c25d9f", "0b6e7a41"]),
            ),
            (
                "hex-id",
                join(&[
                    "3f2a9c1d7be4408ea1c25d9f0b6e7a41",
                    "3f2a9c1d7be4408ea1c25d9f0b6e7a41",
                ]),
            ),
            ("email", join(&["jane.doe", "@", "company.co.uk"])),
            ("email", join(&["a", "@", "mail.example.com"])),
            (
                "email",
                join(&["https://jane:", "hunter22", "@", "api.company.io/v1"]),
            ),
            ("ipv4-address", join(&["10", ".4.", "17.201"])),
            ("ipv4-address", join(&["192", ".0.", "3.1"])),
            ("ipv4-address", join(&["128", ".1.", "2.3"])),
            ("home-path", join(&["/Us", "ers/", "jane/project"])),
            ("home-path", join(&["/ho", "me/", "jane/.config"])),
            ("home-path", join(&["/ro", "ot/", ".ssh"])),
            ("home-path", join(&["C:", "\\Users\\", "jane\\project"])),
            ("home-path", join(&["C:", "\\\\Users\\\\", "jane"])),
            ("host-name", join(&["Janes-MacBook-Pro", ".lo", "cal"])),
            ("host-name", join(&["build-box", ".int", "ernal"])),
            ("host-name", join(&["mac-mini", ".tail1234", ".ts", ".net"])),
            (
                "ssh-target",
                join(&["s", "sh ", "-i key ", "jane@", "buildbox"]),
            ),
            ("ssh-target", join(&["s", "sh ", "jane@", "localhost"])),
        ]
    }

    /// The same classes in the made-up forms a scrubber writes, and near misses of each, none of which may be
    /// reported.
    fn near_misses() -> Vec<(&'static str, String)> {
        vec![
            (
                "anthropic-key",
                join(&["sk", "-ant-", "oat01-", "FAKE000000000000000001"]),
            ),
            ("anthropic-key", "the sk-ant- prefix".to_owned()),
            (
                "api-key",
                join(&["s", "k-proj-", "FAKE0000000000000000001"]),
            ),
            (
                "api-key",
                "task-queue-with-a-long-name-here and sk-short".to_owned(),
            ),
            (
                "github-token",
                join(&["gh", "p_", "FAKE000000000000000000000000000000000001"]),
            ),
            ("github-token", "ghp_short and the ghs_ prefix".to_owned()),
            ("aws-key-id", join(&["AK", "IA", "FAKE000000000001"])),
            (
                "aws-key-id",
                "AKIA short and AKIAZK3JQ8LM2XV9RT5WEXTRA".to_owned(),
            ),
            (
                "jwt",
                join(&[
                    "ey",
                    "JhbGciOiJIUzI1NiJ9.",
                    "eyJmYWtlIjp0cnVlfQ.",
                    "ZmFrZQAAAAAAAAAA",
                ]),
            ),
            ("jwt", "eyJ and eyJhbGciOiJIUzI1NiJ9 alone".to_owned()),
            (
                "bearer-token",
                join(&["Authorization: Bear", "er ", "FAKE0000000001"]),
            ),
            (
                "bearer-token",
                "a bearer or cookie, and the bearer of bad news".to_owned(),
            ),
            ("basic-auth", join(&["Bas", "ic ", "FAKE0000000001"])),
            (
                "basic-auth",
                "basic authentication and a basic setup".to_owned(),
            ),
            (
                "cookie-value",
                join(&["Set-Coo", "kie: sess=", "FAKE0000000001"]),
            ),
            (
                "cookie-value",
                "the cookie value, a=1; b=2 and Cookie: a=1; b=2".to_owned(),
            ),
            (
                "private-key",
                "a PEM private key, or an OpenSSH one".to_owned(),
            ),
            ("private-key", "-----BEGIN CERTIFICATE-----".to_owned()),
            ("uuid", "00000000-0000-4000-8000-000000000001".to_owned()),
            ("uuid", "123e4567-e89b-12d3-a456-42661417400".to_owned()),
            ("prefixed-id", join(&["ms", "g_", "0000000000000000000001"])),
            ("prefixed-id", join(&["or", "g_", "FAKE000000000000001"])),
            (
                "prefixed-id",
                "session_id, request_id, env_file, user_name and org_chart".to_owned(),
            ),
            (
                "hex-id",
                join(&["00000000", "00000000", "00000000", "00000001"]),
            ),
            (
                "hex-id",
                "3f2a9c1d7be4408ea1c25d9f0b6e7a4 and 3f2a9c1d7be4408ea1c25d9f0b6e7a411".to_owned(),
            ),
            (
                "email",
                "user1@example.com and user2@example.org and A@Example.COM".to_owned(),
            ),
            (
                "email",
                "pnpm@12.4.1 taiki-e/install-action@v2 cargo-deny@0.20.2 @types/node".to_owned(),
            ),
            (
                "ipv4-address",
                "127.0.0.1 and 192.0.2.7 and 192.0.2.255 and 127.8.9.10".to_owned(),
            ),
            (
                "ipv4-address",
                "1.2.3 version 10.20.30 and 256.1.1".to_owned(),
            ),
            (
                "home-path",
                "$HOME/project and /tmp/work and /home and /Users and /root".to_owned(),
            ),
            ("home-path", "\u{e9}:\\Users\\".to_owned()),
            (
                "host-name",
                "categories.local.json and host1.example and localhost".to_owned(),
            ),
            (
                "host-name",
                "an internal matter, the .internal suffix".to_owned(),
            ),
            ("ssh-target", join(&["s", "sh ", "user@", "example.com"])),
            ("ssh-target", "ssh -V and a sshd line".to_owned()),
        ]
    }

    #[test]
    fn every_class_has_a_positive_and_a_near_miss_fixture() {
        for class in CLASSES {
            assert!(
                real_shaped().iter().any(|(name, _)| *name == class.name),
                "{} has no value that must be reported",
                class.name
            );
            assert!(
                near_misses().iter().any(|(name, _)| *name == class.name),
                "{} has no near miss",
                class.name
            );
        }
        let known: BTreeSet<&str> = CLASSES.iter().map(|class| class.name).collect();
        for (name, _) in real_shaped().into_iter().chain(near_misses()) {
            assert!(
                known.contains(name),
                "{name} is not in the table of classes"
            );
        }
    }

    #[test]
    fn every_real_shaped_value_is_reported_as_its_class() {
        for (class, value) in real_shaped() {
            let classes: Vec<&str> = scan_text(&format!("\"value\": \"{value}\""))
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
    fn near_misses_and_made_up_forms_are_not_reported_as_their_class() {
        for (class, text) in near_misses() {
            let classes: Vec<&str> = scan_text(&text).iter().map(|found| found.class).collect();
            assert!(
                !classes.contains(&class),
                "{class} was reported for {text:?}"
            );
        }
    }

    #[test]
    fn a_made_up_marker_put_in_front_of_a_real_value_does_not_make_it_made_up() {
        for value in [
            join(&["Bear", "er FAKEq8Zk3Jm2Xv9Rt5Wy7Nb4"]),
            join(&["s", "k-ant-oat01-", "FAKEZk3Jq8Lm2Xv9Rt5Wy7Nb4"]),
            join(&["ms", "g_", "FAKEXFDUDYJgAACzvnptvVoYEL"]),
        ] {
            assert!(!scan_text(&value).is_empty(), "{value}");
        }
    }

    #[test]
    fn the_readme_lists_exactly_the_classes_of_the_table() {
        let readme = std::fs::read_to_string(corpus_root().join("README.md"))
            .expect("the README is readable");
        let start = readme
            .find("<!-- scrub-classes:start -->\n")
            .expect("the README has the start marker")
            + "<!-- scrub-classes:start -->\n".len();
        let end = readme
            .find("<!-- scrub-classes:end -->")
            .expect("the README has the end marker");
        let listed: Vec<&str> = readme[start..end].lines().collect();
        assert_eq!(listed, class_lines());
    }

    #[test]
    fn the_schema_holds_only_the_content_forms_the_scan_decodes() {
        let schema: Value = serde_json::from_str(
            &std::fs::read_to_string(corpus_root().join("case.schema.json"))
                .expect("the schema is readable"),
        )
        .expect("the schema is JSON");
        let definitions: BTreeSet<&str> = schema["$defs"]
            .as_object()
            .expect("the schema has definitions")
            .keys()
            .map(String::as_str)
            .collect();
        // Each definition and what the scan does with it. A new one fails here until it is handled and listed.
        let handled: BTreeSet<&str> = [
            "id",
            "from",
            "case",
            "functionCase",
            "step",
            "expect",
            "tree",
            // Strings and arrays, walked as they are, with the object keys.
            "value",
            "text",
            // Decoded to text: the code units of `codeUnits`, and the bytes of an `entry`'s `base64`.
            "codeUnits",
            "entry",
            // Plain strings and arrays inside a wrapper, walked as they are.
            "number",
            "undefined",
            "object",
        ]
        .into_iter()
        .collect();
        assert_eq!(definitions, handled);
        let forms: BTreeSet<&str> = schema["$defs"]["entry"]["anyOf"]
            .as_array()
            .expect("an entry is a choice of forms")
            .iter()
            .filter_map(|form| form["properties"].as_object())
            .flat_map(|properties| properties.keys().map(String::as_str))
            .collect();
        assert_eq!(
            forms,
            ["base64", "directory", "symlink"].into_iter().collect()
        );
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

    const NO_EXCEPTIONS: &str = r#"{"allow":[]}"#;

    fn problems_of(name: &str, files: &[(&str, &str)]) -> Vec<String> {
        let root = Root::new(name, NO_EXCEPTIONS, files);
        check_tree(&root.0).expect("the check runs")
    }

    fn base64_of(text: &str) -> String {
        const DIGITS: &[u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::new();
        for chunk in text.as_bytes().chunks(3) {
            let value = chunk
                .iter()
                .enumerate()
                .fold(0_u32, |acc, (position, byte)| {
                    acc | (u32::from(*byte) << (16 - 8 * position))
                });
            for step in 0..4 {
                if step <= chunk.len() {
                    out.push(char::from(
                        DIGITS[((value >> (18 - 6 * step)) & 63) as usize],
                    ));
                } else {
                    out.push('=');
                }
            }
        }
        out
    }

    #[test]
    fn a_secret_is_found_in_every_form_the_format_gives_for_content() {
        let key = join(&["sk", "-ant-", "oat01-", "Zk3Jq8Lm2Xv9Rt5Wy7Nb4Hc6"]);
        let header = join(&["Authorization: Bear", "er ", "q8Zk3Jm2Xv9Rt5Wy7Nb4"]);
        let units = key
            .bytes()
            .map(|byte| byte.to_string())
            .collect::<Vec<_>>()
            .join(",");
        let escaped: String = key
            .chars()
            .map(|character| format!("\\u{:04x}", u32::from(character)))
            .collect();
        let nested = base64_of(&format!("{{\"headers\":\"{header}\"}}"));
        let cases = [
            ("a plain string", format!("{{\"a\":\"{key}\"}}"), "/a"),
            (
                "a string spelt with escapes",
                format!("{{\"a\":\"{escaped}\"}}"),
                "/a",
            ),
            ("an object key", format!("{{\"{key}\":1}}"), "/[0]#key"),
            (
                "code units",
                format!("{{\"a\":{{\"codeUnits\":[{units}]}}}}"),
                "/a/codeUnits",
            ),
            (
                "a base64 file body",
                format!(
                    "{{\"files\":{{\"x\":{{\"base64\":\"{}\"}}}}}}",
                    base64_of(&header)
                ),
                "/files/x/base64|decoded",
            ),
            (
                "a base64 body holding JSON",
                format!("{{\"files\":{{\"x\":{{\"base64\":\"{nested}\"}}}}}}"),
                "/files/x/base64|decoded",
            ),
            (
                "an $object pair",
                format!("{{\"a\":{{\"$object\":[[\"k\",\"{key}\"]]}}}}"),
                "/a/$object/0/1",
            ),
            (
                "an $object member name",
                format!("{{\"a\":{{\"$object\":[[\"{key}\",1]]}}}}"),
                "/a/$object/0/0",
            ),
            (
                "a line of a file that is not JSON",
                format!("text {key}"),
                "line 1",
            ),
        ];
        for (label, text, location) in cases {
            let problems = problems_of("forms", &[("function/x.json", &text)]);
            assert!(
                problems
                    .iter()
                    .any(|problem| problem.starts_with(&format!("function/x.json: {location}"))),
                "{label}: {problems:?}"
            );
            assert!(
                problems
                    .iter()
                    .all(|problem| !problem.contains(&key) && !problem.contains("q8Zk3Jm2")),
                "{label} printed a value: {problems:?}"
            );
        }
    }

    #[test]
    fn a_tree_of_real_shaped_values_is_reported_by_file_and_never_by_value() {
        let text = real_shaped()
            .iter()
            .map(|(_, value)| value.clone())
            .collect::<Vec<_>>()
            .join("\n");
        let problems = problems_of(
            "reports",
            &[("function/x.json", &text), ("function/clean.json", "{}")],
        );
        assert!(problems.len() >= real_shaped().len(), "{problems:?}");
        assert!(
            problems
                .iter()
                .all(|problem| problem.starts_with("function/x.json: ")),
            "{problems:?}"
        );
        for (_, value) in real_shaped() {
            assert!(
                problems.iter().all(|problem| !problem.contains(&value)),
                "a value was printed: {problems:?}"
            );
        }
    }

    fn entry(class: &str, file: &str, pointer: &str, text: &str, reason: &str) -> String {
        format!(
            "{{\"class\":\"{class}\",\"file\":\"{file}\",\"pointer\":\"{pointer}\",\"sha256\":\"{}\",\"reason\":\"{reason}\"}}",
            hex_digest(text.as_bytes())
        )
    }

    #[test]
    fn an_exception_is_bound_to_one_class_file_pointer_and_value() {
        let home = join(&["/Us", "ers/", "jane"]);
        let file = format!("{{\"a\":\"{home}/x\",\"b\":[\"{home}/x\"]}}");
        let allow = |pointer: &str, text: &str| {
            format!(
                "{{\"allow\":[{}]}}",
                entry("home-path", "function/x.json", pointer, text, "made up")
            )
        };
        // The value in place is allowed, and nothing else: the same text at another place is a new finding.
        let root = Root::new("bound", &allow("/a", &home), &[("function/x.json", &file)]);
        assert_eq!(
            check_tree(&root.0).expect("runs"),
            ["function/x.json: /b/0: home-path"]
        );
        // The same text at the other place is what an entry for that place covers, and not the first place.
        let later = Root::new(
            "later",
            &allow("/b/0", &home),
            &[("function/x.json", &file)],
        );
        assert_eq!(
            check_tree(&later.0).expect("runs"),
            ["function/x.json: /a: home-path"]
        );
        // A value that changed is a new finding, and the old entry matches nothing.
        let changed = Root::new(
            "changed",
            &allow("/a", &format!("{home}2")),
            &[("function/x.json", &file)],
        );
        let problems = check_tree(&changed.0).expect("runs");
        assert_eq!(problems.len(), 3, "{problems:?}");
        assert!(
            problems
                .iter()
                .any(|problem| problem.contains("matches nothing"))
        );
        // Another file with the same value is not covered.
        let other = Root::new(
            "other-file",
            &allow("/a", &home),
            &[("function/x.json", &file), ("function/y.json", &file)],
        );
        assert_eq!(check_tree(&other.0).expect("runs").len(), 3);
        // An entry covers one finding even when two have the same class, file, pointer and value.
        let twice = format!("{{\"a\":\"{home}/x {home}/x\"}}");
        let both = Root::new("twice", &allow("/a", &home), &[("function/x.json", &twice)]);
        assert_eq!(
            check_tree(&both.0).expect("runs"),
            ["function/x.json: /a: home-path"]
        );
    }

    #[test]
    fn a_class_that_is_never_committed_cannot_be_allowed() {
        let key = join(&["sk", "-ant-", "oat01-", "Zk3Jq8Lm2Xv9Rt5Wy7Nb4Hc6"]);
        let allow = format!(
            "{{\"allow\":[{}]}}",
            entry("anthropic-key", "function/x.json", "/a", &key, "recorded")
        );
        let root = Root::new(
            "refused",
            &allow,
            &[("function/x.json", &format!("{{\"a\":\"{key}\"}}"))],
        );
        let problems = check_tree(&root.0).expect("runs");
        assert!(
            problems.contains(&format!(
                "{ALLOW_FILE}: entry 0 names anthropic-key, which is never an exception"
            )),
            "{problems:?}"
        );
        assert!(
            problems.contains(&"function/x.json: /a: anthropic-key".to_owned()),
            "{problems:?}"
        );
        for class in CLASSES.iter().filter(|class| !class.allowable) {
            let refused = format!(
                "{{\"allow\":[{}]}}",
                entry(class.name, "f.json", "/a", "x", "r")
            );
            let root = Root::new("refused-each", &refused, &[]);
            assert!(
                check_tree(&root.0)
                    .expect("runs")
                    .iter()
                    .any(|problem| problem.contains("never an exception")),
                "{}",
                class.name
            );
        }
    }

    #[test]
    fn the_allow_file_is_scanned_and_holds_a_digest_never_a_value() {
        let key = join(&["sk", "-ant-", "oat01-", "Zk3Jq8Lm2Xv9Rt5Wy7Nb4Hc6"]);
        let home = join(&["/Us", "ers/", "jane"]);
        let leaking = format!(
            "{{\"allow\":[{}]}}",
            entry("home-path", "function/x.json", "/a", &home, &key)
        );
        let root = Root::new(
            "leaks",
            &leaking,
            &[("function/x.json", &format!("{{\"a\":\"{home}/x\"}}"))],
        );
        assert_eq!(
            check_tree(&root.0).expect("runs"),
            [format!("{ALLOW_FILE}: /allow/0/reason: anthropic-key")]
        );
        let clean = format!(
            "{{\"allow\":[{}]}}",
            entry("home-path", "function/x.json", "/a", &home, "made up")
        );
        let root = Root::new(
            "digest",
            &clean,
            &[("function/x.json", &format!("{{\"a\":\"{home}/x\"}}"))],
        );
        assert_eq!(check_tree(&root.0).expect("runs"), Vec::<String>::new());
    }

    #[test]
    fn a_malformed_exception_is_a_problem() {
        let digest = hex_digest(b"x");
        for text in [
            format!("{{\"allow\":[{{\"class\":\"home-path\",\"file\":\"a\",\"pointer\":\"/a\",\"sha256\":\"{digest}\"}}]}}"),
            format!("{{\"allow\":[{{\"class\":\"home-path\",\"file\":\"a\",\"pointer\":\"/a\",\"sha256\":\"{digest}\",\"reason\":\"\"}}]}}"),
            format!("{{\"allow\":[{{\"class\":\"home-path\",\"file\":\"a\",\"pointer\":\"/a\",\"sha256\":\"{digest}\",\"reason\":\"r\",\"match\":\"x\"}}]}}"),
            "{\"allow\":[{\"class\":\"home-path\",\"file\":\"a\",\"pointer\":\"/a\",\"sha256\":\"ABC\",\"reason\":\"r\"}]}".to_owned(),
            format!("{{\"allow\":[{{\"class\":\"nonsense\",\"file\":\"a\",\"pointer\":\"/a\",\"sha256\":\"{digest}\",\"reason\":\"r\"}}]}}"),
            "{\"allow\":[],\"other\":1}".to_owned(),
            "[]".to_owned(),
        ] {
            let document: Value = serde_json::from_str(&text).expect("valid JSON");
            assert_eq!(allowances_from(&document).1.len(), 1, "{text}");
        }
    }

    #[test]
    fn an_exception_nothing_matches_is_a_problem() {
        let allow = format!(
            "{{\"allow\":[{}]}}",
            entry("email", "function/x.json", "/a", "a@b.example", "r")
        );
        let root = Root::new("unused", &allow, &[("function/x.json", "{}")]);
        assert_eq!(
            check_tree(&root.0).expect("runs"),
            ["scrub-allow.json: the email exception for function/x.json at /a matches nothing"]
        );
    }

    #[test]
    fn a_file_that_is_not_utf8_is_read_lossily() {
        let root = Root::new("lossy", NO_EXCEPTIONS, &[]);
        std::fs::write(root.0.join("binary.json"), [0xff_u8, 0xfe, b'{', b'}'])
            .expect("write the file");
        assert_eq!(check_tree(&root.0).expect("runs"), Vec::<String>::new());
    }

    #[test]
    fn a_character_before_a_windows_home_path_does_not_stop_the_check() {
        let text = join(&["\u{e9}", ":\\Users\\", "jane"]);
        assert!(
            scan_line(&text)
                .iter()
                .any(|found| found.class == "home-path")
        );
    }
}
