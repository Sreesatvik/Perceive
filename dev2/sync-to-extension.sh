#!/usr/bin/env bash
# dev2/ is the canonical source for the privacy pipeline modules.
# extension/dev2/ is a required duplicate (Chrome unpacked extensions can
# only load resources from within their own manifest directory), but it
# drifted silently out of sync for several commits (see Phase 1 notes) —
# has_value tracking, the vault-issued-token check, and the redacted_regions
# coverage check all existed only in dev2/ while the shipped extension ran
# an older, less safe version.
#
# Run this after any change to dev2/*.js to keep the two copies identical.
set -euo pipefail
cd "$(dirname "$0")"

FILES=(
  token-vault.js
  session-vault-manager.js
  leakage-auditor.js
  sensitivity-tiers.js
  channel-consistency-check.js
  redaction-engine.js
  dom-heuristics.js
  pii-patterns.js
  task-entity-extractor.js
)

for f in "${FILES[@]}"; do
  if [ -f "$f" ]; then
    cp "$f" "../extension/dev2/$f"
    echo "synced $f -> extension/dev2/$f"
  fi
done
