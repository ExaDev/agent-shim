#!/bin/sh
# The checks of CI's Rust job: the guards (only scripts/rust.sh runs cargo, every check script has a test and every test runs), the tests of those guards, formatting, clippy with warnings denied, the tests, and the workspace lint configuration. Every cargo invocation is in scripts/rust.sh, against the committed Cargo.lock and the pinned toolchain.
set -eu

cd "$(dirname "$0")/.."

sh scripts/check-cargo-entry.sh
sh scripts/check-scripts-tested.sh
sh scripts/test-check-cargo-entry.sh
sh scripts/test-check-scripts-tested.sh
sh scripts/test-rust-sh.sh
python3 -I scripts/test_check_tool_pins.py
sh scripts/rust.sh fmt
sh scripts/rust.sh clippy
sh scripts/rust.sh test
sh scripts/rust.sh xtask lint-config
