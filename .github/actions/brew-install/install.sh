#!/usr/bin/env bash
# Taps ExaDev/agent-shim and installs the formula, and counts the install as done by what it produced and not by brew's exit status when, and only when, brew died of a broken pipe.
#
# Usage: install.sh <tap> <formula> <expected-version>
#
# brew's output goes to a file, never through the runner's stdout pipe, because the pipe is what has closed under it (a Ruby `Broken pipe` out of `brew install`, or exit 141 out of `brew tap`) on Linux arm runners. A failure whose output carries that signature, or whose status is 141, is then judged by the result: the tap directory exists, or the formula is installed at the expected version. Any other failure, and a broken pipe that left nothing behind, fails the step with brew's own output.
set -euo pipefail

tap="$1"
formula="$2"
expected="$3"
name="${formula##*/}"
log="$(mktemp)"
trap 'rm -f "$log"' EXIT

# Whether the last brew run's status and output carry the broken-pipe signature.
broken_pipe() {
  [ "$1" -eq 141 ] || grep -q "Broken pipe" "$log"
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
  if broken_pipe "$status" && [ -d "$(brew --repository "$tap")" ]; then
    echo "brew tap ended with a broken pipe (status $status), and the tap is in place: continuing."
  else
    echo "error: brew tap $tap failed with status $status" >&2
    exit "$status"
  fi
fi

status=0
run_brew install "$formula" || status=$?
if [ "$status" -ne 0 ]; then
  installed="$(brew list --versions "$name" 2>/dev/null || true)"
  if broken_pipe "$status" && [ "$installed" = "$name $expected" ]; then
    echo "brew install ended with a broken pipe (status $status), and $name $expected is installed: continuing."
  else
    echo "error: brew install $formula failed with status $status (installed: ${installed:-nothing})" >&2
    exit "$status"
  fi
fi
