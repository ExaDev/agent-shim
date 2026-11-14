//! The harness that runs the conformance corpus against the Rust crates.
//!
//! The harness has no Rust implementation to run the corpus against, so it executes nothing. It is a plain
//! `main` (the test target sets `harness = false`) so that, once a case fails, the output names the case id.

fn main() {}
