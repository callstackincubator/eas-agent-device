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
  SUMMARY="$(cat "${OUTPUT_DIR}/summary.md")"
  # Each failure page has the steps, the agent's actions, and the screen at failure.
  for page in "${OUTPUT_DIR}"/failures/*.md; do
    [ -f "${page}" ] || continue
    SUMMARY="${SUMMARY}

<details>
<summary>Failure details: $(basename "${page}" .md)</summary>

$(cat "${page}")
</details>"
  done
  # Keep the PR comment under GitHub's size limit.
  SUMMARY="$(printf '%s' "${SUMMARY}" | head -c 30000)"
else
  SUMMARY="No e2e summary was produced. See the workflow logs."
fi

if [ -f "${OUTPUT_DIR}/report.json" ]; then
  COUNTS="$(
    jq -r '
      .run.summary
      | [("passed", "failed", "flaky", "skipped", "interrupted") as $key | select(.[$key] > 0) | "\(.[$key]) \($key)"]
      | join(", ")
    ' "${OUTPUT_DIR}/report.json" 2>/dev/null
  )"
fi

set-output status_label "${STATUS_LABEL}"
set-output counts "${COUNTS:-N/A}"
set-output summary "${SUMMARY}"
exit "${EXIT_CODE}"
