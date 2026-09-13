#!/usr/bin/env bash
# dev2/ is the canonical source for the privacy pipeline modules.
# extension/dev2/ is a required duplicate (Chrome unpacked extensions can
# only load resources from within their own manifest directory), but it
# has drifted silently out of sync more than once — most recently
# redaction-renderer.js was simply never added to a manually-maintained
# file list here, so the shipped extension ran a pre-Phase-2 version of it
# for two full phases without anyone noticing. This now auto-discovers
# every non-test source file in dev2/ instead of relying on a hand-kept
# list, so a forgotten entry can't happen again.
#
# Run this after any change to dev2/*.js to keep the two copies identical.
set -euo pipefail
cd "$(dirname "$0")"

for f in *.js; do
  case "$f" in
    test-*.js) continue ;;  # test files are dev2/-only, never shipped
  esac
  if [ -f "$f" ]; then
    cp "$f" "../extension/dev2/$f"
    echo "synced $f -> extension/dev2/$f"
  fi
done
