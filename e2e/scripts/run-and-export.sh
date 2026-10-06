#!/usr/bin/env bash

set -uo pipefail

TARGET="${1:?target argument is required}"
OUTPUT_DIR=".e2e"

npx e2e run --target "${TARGET}" --reporter list,junit,markdown
EXIT_CODE=$?

if [ "${EXIT_CODE}" -eq 0 ]; then
  STATUS_LABEL="✅ passed"
else
  STATUS_LABEL="❌ failed (exit ${EXIT_CODE})"
fi

if [ -f "${OUTPUT_DIR}/summary.md" ]; then
  # Keep the PR comment under GitHub's size limit.
  SUMMARY="$(head -c 20000 "${OUTPUT_DIR}/summary.md")"
else
  SUMMARY="No e2e summary was produced. See the workflow logs."
fi

if [ -f "${OUTPUT_DIR}/report.json" ]; then
  COUNTS="$(
    jq -r '
      [.. | objects | select(has("status") and has("title")) | .status]
      | group_by(.) | map("\(length) \(.[0])") | join(", ")
    ' "${OUTPUT_DIR}/report.json" 2>/dev/null
  )"
fi

set-output status_label "${STATUS_LABEL}"
set-output counts "${COUNTS:-N/A}"
set-output summary "${SUMMARY}"
exit "${EXIT_CODE}"
