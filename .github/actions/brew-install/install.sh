#!/usr/bin/env bash
# Taps ExaDev/agent-shim and installs the formula, and judges the install by what it produced: the job passes only when the formula is installed at the expected version and the installed binary reports that version, whatever brew's exit status was, and a brew failure other than the broken pipe fails with its output.
#
# Usage: install.sh <tap> <formula>        (the released tag, vX.Y.Z, is read from RELEASE_TAG, the variable every verification job already sets)
#
# brew's output goes to a file, never through the runner's stdout pipe, because a pipe has closed under it (a Ruby `Broken pipe` out of `brew install` or `brew tap`, or exit 141 out of `brew tap`) on Linux arm runners. A failure with that signature is tolerated when what the command was for is in place (see `broken_pipe_tolerated`), and every path then ends in the check of the installed version. Any other failure fails the step with brew's own output.
set -euo pipefail

tap="$1"
formula="$2"
# The one place the bare version is derived from the released tag.
expected="${RELEASE_TAG:?RELEASE_TAG must hold the released tag (vX.Y.Z)}"
expected="${expected#v}"
name="${formula##*/}"
log="$(mktemp)"
trap 'rm -f "$log"' EXIT

# The one judgement of a brew command that failed, shared by the tap and the install. A failure is the broken pipe only when ALL of these hold: (a) the exit status is exactly 1, or 141 where the caller says a signal death counts (the tap's, which prints nothing); (b) for status 1, the captured output holds a whole line that is exactly the command's message, with at most brew's own prefix, and (c) the command's postcondition holds, since the status and the line say only that something wrote to a closed pipe, and what matters is what the command left behind. Anything else fails the step with brew's output.
#
# brew's `onoe` prints a rescued Ruby `Errno::EPIPE` (a `SystemCallError`, message `Broken pipe`) as `::error::<message>` under Actions (the runner shows `##[error]`) and `Error: <message>` elsewhere, then exits 1 (Library/Homebrew/brew.rb, `rescue RuntimeError, SystemCallError`; Library/Homebrew/utils/output.rb, `onoe`). The tap's message is the bare `Broken pipe`, from the exception itself; the install's is `<formula>: Broken pipe`, from `ofail` in install.rb with the formula as brew normalises it (lower case). Lines are compared whole with awk, so the formula's characters are never read as a pattern, and ANSI colour is stripped first (with HOMEBREW_COLOR set and no CI variables brew writes the word Error in red): only SGR sequences (`ESC[` digits and semicolons, `m`) go, with a literal ESC from printf, which sed on bash 3.2 and BSD and GNU sed all take.
#
# Usage: broken_pipe_tolerated <status> <signal-death-counts: yes|no> <message> <postcondition command...>
broken_pipe_tolerated() {
  local status="$1" signal_counts="$2" message="$3"
  shift 3
  if [ "$status" -eq 141 ] && [ "$signal_counts" = yes ]; then
    :
  elif [ "$status" -eq 1 ] && broken_pipe_line "$message"; then
    :
  else
    return 1
  fi
  "$@"
}

broken_pipe_line() {
  local esc
  esc="$(printf '\033')"
  sed -e "s/${esc}\\[[0-9;]*m//g" "$log" | awk -v message="$1" '$0 == message || $0 == "::error::" message || $0 == "Error: " message { found = 1 } END { exit !found }'
}

# What the tap must have left: its directory, a commit checked out in it, and the formula file. A tap that printed `Tapped` and then hit the closed pipe in the work that follows the clone (the description cache, the untapped-taps setting, the private-repository check) has all three, and a tap that failed to clone has none.
tap_in_place() {
  local directory
  directory="$(brew --repository "$tap")"
  [ -d "$directory" ] && git -C "$directory" rev-parse --verify --quiet HEAD >/dev/null && [ -f "$directory/Formula/$name.rb" ]
}

# `<lowered formula>: Broken pipe`, the install's message; brew writes the formula as it normalises it, in lower case, and tr (not `${formula,,}`) lowers it because macOS runners run this under bash 3.2.
install_message() {
  printf '%s: Broken pipe' "$(printf '%s' "$formula" | tr '[:upper:]' '[:lower:]')"
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
  if ! broken_pipe_tolerated "$status" yes "Broken pipe" tap_in_place; then
    echo "error: brew tap $tap failed with status $status" >&2
    exit "$status"
  fi
  echo "brew tap ended with a broken pipe (status $status), and the tap is in place: continuing."
fi

status=0
run_brew install "$formula" || status=$?
if [ "$status" -ne 0 ]; then
  # The install's postcondition is the version check below, which every path ends in.
  if ! broken_pipe_tolerated "$status" no "$(install_message)" true; then
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
