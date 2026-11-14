#!/bin/sh
# Reads the paths a push changes, one per line, on standard input, and exits 0 when the pre-push hook must run the kept-tests guard (src/conformance/keptTests.repo.test.ts) and 1 when it need not.
#
# The guard collects the whole suite, so it runs on a push only when the push changes something the guard can be wrong about: a file under conformance/ (the corpus and the README tables it reads) or under src/conformance/ (the guard and the call tables), or any test file (a test added, renamed or removed in a file whose tests moved). CI's test and Deleted tests jobs run it on every pull request whatever the paths.
set -eu
if grep -Eq '^(conformance/|src/conformance/)|\.test\.tsx?$'; then
  exit 0
fi
exit 1
