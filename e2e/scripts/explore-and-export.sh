#!/usr/bin/env bash

# Runs the `e2e explore` smoke test for a pull request and exports the result
# as step outputs for the PR comment. Run from the e2e/ directory.

set -uo pipefail

TARGET="${1:?target argument is required}"
OUTPUT_DIR=".e2e-explore"
REPORT="${OUTPUT_DIR}/report.json"

case "${TARGET}" in
  ios) PLATFORM_LABEL="iOS" ;;
  android) PLATFORM_LABEL="Android" ;;
  *) PLATFORM_LABEL="${TARGET}" ;;
esac

mkdir -p "${OUTPUT_DIR}"
export E2E_PR_CONTEXT_FILE="${PWD}/${OUTPUT_DIR}/pr-context.md"
GOAL="$(node ./scripts/explore-goal.mjs "${E2E_PR_CONTEXT_FILE}")"
printf 'Exploration goal:\n%s\n\nPull request context:\n%s\n\n' "${GOAL}" "$(cat "${E2E_PR_CONTEXT_FILE}")"

npx e2e explore "${GOAL}" \
  --target "${TARGET}" \
  --agent smoke \
  --max-steps "${E2E_EXPLORE_MAX_STEPS:-8}" \
  --timeout "${E2E_EXPLORE_TIMEOUT_MS:-600000}" \
  --output "${OUTPUT_DIR}" \
  --reporter list,markdown
EXIT_CODE=$?

# The screen the exploration ended on, so the comment always shows at least one
# screenshot; findings only carry one when the agent reports something.
FINAL_SCREENSHOT="${OUTPUT_DIR}/final-screen.png"
if [ "${TARGET}" = "ios" ]; then
  xcrun simctl io "${E2E_DEVICE:-booted}" screenshot "${FINAL_SCREENSHOT}"
else
  adb ${E2E_DEVICE:+-s "${E2E_DEVICE}"} exec-out screencap -p > "${FINAL_SCREENSHOT}"
fi
FINAL_SCREENSHOT_URL=""
if [ -s "${FINAL_SCREENSHOT}" ]; then
  FINAL_SCREENSHOT_URL="$(
    node ./scripts/upload-screenshot.mjs "${FINAL_SCREENSHOT}" "e2e/${E2E_BLOB_PREFIX:-local}/final-screen.png"
  )"
fi

if [ -f "${REPORT}" ]; then
  # An issue fails the run, a warning does not; blocked and error runs have no verdict.
  STATUS="$(
    jq -r '
      if (.run.explore.findings // [] | any(.kind == "issue")) then "failed"
      elif .run.status == "passed" then "passed"
      else "blocked"
      end
    ' "${REPORT}"
  )"
else
  STATUS="blocked"
fi

case "${STATUS}" in
  passed) STATUS_LABEL="✅ passed" ;;
  failed) STATUS_LABEL="❌ failed" ;;
  *) STATUS_LABEL="⛔ blocked" ;;
esac

if [ -f "${REPORT}" ]; then
  TOP_ISSUE="$(
    jq -r '
      (.run.explore.findings // [] | sort_by((if .kind == "issue" then 0 else 1 end), -.severity) | first) as $finding
      | if $finding then "\($finding.kind) (severity \($finding.severity)): \($finding.title)"
        elif .run.status == "passed" then "N/A"
        else ([.. | objects | select(has("code") and has("category") and has("message"))][0] as $error
          | if $error then "\($error.code): \($error.message)" else (.run.explore.summary // "Exploration did not finish.") end)
        end
    ' "${REPORT}" | tr '\n' ' ' | sed 's/[[:space:]]\+/ /g; s/^ //; s/ $//'
  )"

  # Screenshots the artifact store uploaded (refs are public URLs): finding evidence,
  # most severe first and labelled with the finding, then the rest, up to three,
  # then the final screen.
  SCREENSHOTS_CELL="$(
    jq -r --arg final "${FINAL_SCREENSHOT_URL}" '
      [.. | objects | select(.kind == "screenshot" and ((.ref // "") | startswith("http")))] as $shots
      | [(.run.explore.findings // []) | sort_by((if .kind == "issue" then 0 else 1 end), -.severity)[] | select(.artifactId) | {id: .artifactId, label: .title}] as $evidence
      | ($evidence | map(.id)) as $evidenceIds
      | (
          [$evidence[] as $e | $shots[] | select(.id == $e.id) | {url: .ref, label: $e.label}]
          + [$shots[] | select(.id as $id | $evidenceIds | index($id) | not) | {url: .ref, label: (.path // .id | split("/") | last)}]
        )
      | reduce .[] as $shot ([]; if any(.[]; .url == $shot.url) then . else . + [$shot] end)
      | .[0:3]
      | . + (if $final == "" then [] else [{url: $final, label: "Final screen"}] end)
      | if length == 0 then "N/A"
        else map("**\(.label)**<br><a href=\"\(.url)\"><img src=\"\(.url)\" alt=\"\(.label)\" height=\"500\" /></a>") | join("<br><br>")
        end
    ' "${REPORT}"
  )"
else
  TOP_ISSUE="No exploration report was produced. See the workflow logs."
  if [ -n "${FINAL_SCREENSHOT_URL}" ]; then
    SCREENSHOTS_CELL="**Final screen**<br><a href=\"${FINAL_SCREENSHOT_URL}\"><img src=\"${FINAL_SCREENSHOT_URL}\" alt=\"Final screen\" height=\"500\" /></a>"
  else
    SCREENSHOTS_CELL="N/A"
  fi
fi

SECTION_BODY="### ${PLATFORM_LABEL}

**Status:** ${STATUS_LABEL}
"
if [ -f "${OUTPUT_DIR}/summary.md" ]; then
  SECTION_BODY="${SECTION_BODY}
$(cat "${OUTPUT_DIR}/summary.md")"
fi
SECTION_BODY="${SECTION_BODY}

<details>
<summary>Exploration goal</summary>

\`\`\`text
${GOAL}
\`\`\`
</details>"
# Keep the PR comment under GitHub's size limit.
SECTION_BODY="$(printf '%s' "${SECTION_BODY}" | head -c 30000)"

set-output status "${STATUS}"
set-output status_label "${STATUS_LABEL}"
set-output top_issue "${TOP_ISSUE}"
set-output screenshots_cell "${SCREENSHOTS_CELL}"
set-output section_body "${SECTION_BODY}"
exit "${EXIT_CODE}"
