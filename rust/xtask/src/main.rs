//! Repository tasks, run through `scripts/rust.sh xtask <task>` (the entry point that runs every cargo command):
//!
//! - `lint-config` fails unless every workspace member takes the shared lint table and package settings.
//! - `corpus scrub-check` fails when a file under `conformance/` holds something shaped like a real credential,
//!   identifier, address or home-directory path.

mod error;
mod lint_config;
mod scrub;

use std::process::ExitCode;

/// Exit status for a task that could not run, apart from one that ran and found problems.
const USAGE_OR_FAULT: u8 = 2;

fn main() -> ExitCode {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let arguments: Vec<&str> = arguments.iter().map(String::as_str).collect();
    let outcome = match arguments.as_slice() {
        ["lint-config"] => lint_config::run(),
        ["corpus", "scrub-check"] => scrub::run(),
        _ => {
            eprintln!("usage: xtask lint-config | corpus scrub-check");
            return ExitCode::from(USAGE_OR_FAULT);
        }
    };
    match outcome {
        Ok(problems) if problems.is_empty() => ExitCode::SUCCESS,
        Ok(problems) => {
            for problem in problems {
                println!("{problem}");
            }
            ExitCode::FAILURE
        }
        Err(fault) => {
            eprintln!("xtask: {fault}");
            ExitCode::from(USAGE_OR_FAULT)
        }
    }
}
