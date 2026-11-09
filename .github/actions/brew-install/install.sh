#!/usr/bin/env bash
# Taps ExaDev/agent-shim and installs the formula, and judges the install by what it produced: the job passes only when the formula is installed at the expected version and the installed binary reports that version, whatever brew's exit status was, and a brew failure other than the broken pipe fails with its output.
#
# Usage: install.sh <tap> <formula>        (the released tag, vX.Y.Z, is read from RELEASE_TAG, the variable every verification job already sets)
#
# brew's output goes to a file, never through the runner's stdout pipe, because the pipe is what has closed under it (a Ruby `Broken pipe` out of `brew install`, or exit 141 out of `brew tap`) on Linux arm runners. A failure with that signature is tolerated (a tap also needs its directory), and every path then ends in the check of the installed version. Any other failure fails the step with brew's own output.
set -euo pipefail

tap="$1"
formula="$2"
# The one place the bare version is derived from the released tag.
expected="${RELEASE_TAG:?RELEASE_TAG must hold the released tag (vX.Y.Z)}"
expected="${expected#v}"
name="${formula##*/}"
log="$(mktemp)"
trap 'rm -f "$log"' EXIT

# The signature of the failing `brew install` runs, read from the captured output: brew's own `ofail` line for a Ruby EPIPE, `<formula>: Broken pipe` with the formula named as brew normalises it (lower case), whole on its line, and the exit status 1. Under Actions brew renders it as `::error::<formula>: Broken pipe` (the runner shows `##[error]`), and elsewhere as `Error: <formula>: Broken pipe`; those two prefixes are the only ones accepted, and nothing may follow the message. Compared as whole lines with awk, so the formula's characters are never read as a pattern. An exit 141 is the tap's signal-death, not this one.
install_broken_pipe() {
  # Lower-cased with tr, not `${formula,,}`: macOS runners run this under bash 3.2.
  local lowered
  lowered="$(printf '%s' "$formula" | tr '[:upper:]' '[:lower:]')"
  awk -v message="$lowered: Broken pipe" '$0 == message || $0 == "::error::" message || $0 == "Error: " message { found = 1 } END { exit !found }' "$log"
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
# Standard output alone is compared with the version: a warning the binary prints on standard error (a Node deprecation, as on the Intel macOS install) is not the version. Standard error is printed when the check fails.
errors="$(mktemp)"
trap 'rm -f "$log" "$errors"' EXIT
reported="$("$(brew --prefix)/bin/$name" --version 2>"$errors")" || {
  echo "error: the installed $name does not run: $reported $(cat "$errors")" >&2
  exit 1
}
if [ "$reported" != "$expected" ]; then
  echo "error: the installed $name reports version $reported, expected $expected: $(cat "$errors")" >&2
  exit 1
fi
echo "$name $expected is installed and reports its version."
