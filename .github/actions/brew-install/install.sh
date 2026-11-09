#!/usr/bin/env bash
# Taps ExaDev/agent-shim and installs the formula, and judges the install by what it produced: the job passes only when the formula is installed at the expected version and the installed binary reports that version, whatever brew's exit status was, and a brew failure other than the broken pipe fails with its output.
#
# Usage: install.sh <tap> <formula> <expected-version>
#
# brew's output goes to a file, never through the runner's stdout pipe, because the pipe is what has closed under it (a Ruby `Broken pipe` out of `brew install`, or exit 141 out of `brew tap`) on Linux arm runners. A failure with that signature is tolerated (a tap also needs its directory), and every path then ends in the check of the installed version. Any other failure fails the step with brew's own output.
set -euo pipefail

tap="$1"
formula="$2"
expected="$3"
name="${formula##*/}"
log="$(mktemp)"
trap 'rm -f "$log"' EXIT

# The signature of the failing `brew install` runs, read from the captured output: brew prints its own `<formula>: Broken pipe` line (its `ofail` for a Ruby EPIPE, with the formula named as brew normalises it, in lower case) and exits 1. An exit 141 is the tap's signal-death, not this one.
install_broken_pipe() {
  # Lower-cased with tr, not `${formula,,}`: macOS runners run this under bash 3.2.
  local lowered
  lowered="$(printf '%s' "$formula" | tr '[:upper:]' '[:lower:]')"
  grep -qxF "$lowered: Broken pipe" "$log"
}

run_brew() {
  local status=0
  brew "$@" >"$log" 2>&1 || status=$?
  cat "$log" || true
  return "$status"
}

status=0
run_brew tap "$tap" || status=$?
if [ "$status" -ne 0 ]; then
  # `brew tap` dies of SIGPIPE (exit 141); the tap itself has succeeded when its directory is there.
  if [ "$status" -eq 141 ] && [ -d "$(brew --repository "$tap")" ]; then
    echo "brew tap ended with a broken pipe (status $status), and the tap is in place: continuing."
  else
    echo "error: brew tap $tap failed with status $status" >&2
    exit "$status"
  fi
fi

status=0
run_brew install "$formula" || status=$?
if [ "$status" -ne 0 ]; then
  if [ "$status" -ne 1 ] || ! install_broken_pipe; then
    echo "error: brew install $formula failed with status $status" >&2
    exit "$status"
  fi
  echo "brew install ended with a broken pipe (status $status): judging the install by what it produced."
fi

# Whatever brew said, the job passes only when the formula is installed at the released version and the installed binary reports it.
installed="$(brew list --versions "$name" 2>/dev/null || true)"
if [ "$installed" != "$name $expected" ]; then
  echo "error: expected $name $expected to be installed, brew lists: ${installed:-nothing}" >&2
  exit 1
fi
reported="$("$(brew --prefix)/bin/$name" --version 2>&1)" || {
  echo "error: the installed $name does not run: $reported" >&2
  exit 1
}
if [ "$reported" != "$expected" ]; then
  echo "error: the installed $name reports version $reported, expected $expected" >&2
  exit 1
fi
echo "$name $expected is installed and reports its version."
