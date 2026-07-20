#!/usr/bin/env bash

set -uo pipefail

APP_PATH_ARG="${1:?APP_PATH argument is required}"
QA_PLATFORM_VALUE="${QA_PLATFORM:?QA_PLATFORM is required}"
APPLICATION_ID_VALUE="${APPLICATION_ID:?APPLICATION_ID is required}"

case "${QA_PLATFORM_VALUE}" in
  ios)
    PLATFORM_LABEL="iOS"
    ;;
  android)
    PLATFORM_LABEL="Android"
    ;;
  *)
    PLATFORM_LABEL="${QA_PLATFORM_VALUE}"
    ;;
esac

set +e
export APP_PATH="${APP_PATH_ARG}"

mkdir -p artifacts/qa

# Best-effort PR diff for the naive prompt-only agent. Failures here (no
# base sha, shallow clone, fetch error) are non-fatal: the naive agent
# degrades to reporting that no diff was available.
PR_DIFF_PATH="artifacts/qa/pr-diff.txt"
DIFF_MAX_BYTES=20000
: > "${PR_DIFF_PATH}"
BASE_SHA="$(printf '%s' "${PR_JSON:-}" | jq -r '.base.sha // empty' 2>/dev/null)"
HEAD_SHA="$(printf '%s' "${PR_JSON:-}" | jq -r '.head.sha // empty' 2>/dev/null)"
if [ -n "${BASE_SHA}" ]; then
  git fetch --quiet --depth=1 origin "${BASE_SHA}" >/dev/null 2>&1
  git diff --no-color "${BASE_SHA}...${HEAD_SHA:-HEAD}" -- . 2>/dev/null \
    | head -c "${DIFF_MAX_BYTES}" > "${PR_DIFF_PATH}"
fi
export PR_DIFF_PATH

BOOTSTRAP_ERROR=""
if [ "${QA_PLATFORM_VALUE}" = "android" ]; then
  BOOTSTRAP_STEP="install"
  agent-device install "${APPLICATION_ID_VALUE}" "${APP_PATH}"
else
  BOOTSTRAP_STEP="reinstall"
  agent-device reinstall "${APPLICATION_ID_VALUE}" "${APP_PATH}"
fi
BOOTSTRAP_EXIT=$?

if [ "${BOOTSTRAP_EXIT}" -ne 0 ] && [ "${QA_PLATFORM_VALUE}" = "android" ]; then
  BOOTSTRAP_STEP="reinstall"
  agent-device reinstall "${APPLICATION_ID_VALUE}" "${APP_PATH}"
  BOOTSTRAP_EXIT=$?
fi

if [ "${BOOTSTRAP_EXIT}" -eq 0 ]; then
  BOOTSTRAP_STEP="open"
  agent-device open "${APPLICATION_ID_VALUE}" --relaunch
  BOOTSTRAP_EXIT=$?
fi

if [ "${BOOTSTRAP_EXIT}" -ne 0 ]; then
  BOOTSTRAP_ERROR="Deterministic ${PLATFORM_LABEL} app bootstrap failed during ${BOOTSTRAP_STEP}. See workflow logs above."
fi

export AGENT_QA_BOOTSTRAP_ERROR="${BOOTSTRAP_ERROR}"
npm run agent-qa
EXIT_CODE=$?

# Reads one flavor's artifacts (tool-based or naive) and exposes them as
# ${prefix}_STATUS / ${prefix}_STATUS_LABEL / ${prefix}_TOP_ISSUE /
# ${prefix}_SCREENSHOTS_CELL / ${prefix}_SECTION_BODY globals.
compute_qa_outputs() {
  local dir="$1"
  local platform_label="$2"
  local prefix="$3"
  local status status_label top_issue screenshots_cell section_body

  status="$(cat "${dir}/status.txt" 2>/dev/null || printf blocked)"
  case "${status}" in
    passed)
      status_label="✅ passed"
      ;;
    failed)
      status_label="❌ failed"
      ;;
    blocked)
      status_label="⛔ blocked"
      ;;
    unsure)
      status_label="🤔 unsure"
      ;;
    not_tested)
      status_label="⚪ not_tested"
      ;;
    *)
      status_label="⚪ ${status}"
      ;;
  esac

  if [ -f "${dir}/report.json" ]; then
    top_issue="$(
      jq -r '
        if .overallStatus == "passed" then
          "N/A"
        else
          (.issues[0] // .summary // "N/A")
        end
      ' "${dir}/report.json" | tr '\n' ' ' | sed 's/[[:space:]]\+/ /g; s/^ //; s/ $//'
    )"

    screenshots_cell="$(
      jq -r '
        if (.screenshots | length) == 0 then
          "N/A"
        else
          [
            .screenshots[]
            | if .blobUrl then
                "**\((.label // .fileName))**<br><a href=\"\(.blobUrl)\"><img src=\"\(.blobUrl)\" alt=\"\((.label // .fileName))\" height=\"500\" /></a>"
              else
                "**\((.label // .fileName))**<br>\(.fileName) (\(.bytes) bytes)"
              end
          ] | join("<br><br>")
        end
      ' "${dir}/report.json"
    )"
  else
    if [ "${status}" = "passed" ]; then
      top_issue="N/A"
    else
      top_issue="No report.json was produced."
    fi
    screenshots_cell="N/A"
  fi

  if [ -f "${dir}/section.md" ]; then
    section_body="$(cat "${dir}/section.md")"
  else
    section_body="### ${platform_label}

**Status:** ${status_label}

No ${platform_label} QA section was produced.
"
  fi

  printf -v "${prefix}_STATUS" '%s' "${status}"
  printf -v "${prefix}_STATUS_LABEL" '%s' "${status_label}"
  printf -v "${prefix}_TOP_ISSUE" '%s' "${top_issue}"
  printf -v "${prefix}_SCREENSHOTS_CELL" '%s' "${screenshots_cell}"
  printf -v "${prefix}_SECTION_BODY" '%s' "${section_body}"
}

compute_qa_outputs "artifacts/qa/toolBased" "${PLATFORM_LABEL}" TOOL
compute_qa_outputs "artifacts/qa/naive" "${PLATFORM_LABEL}" NAIVE

set-output status "${TOOL_STATUS}"
set-output status_label "${TOOL_STATUS_LABEL}"
set-output top_issue "${TOOL_TOP_ISSUE}"
set-output screenshots_cell "${TOOL_SCREENSHOTS_CELL}"
set-output section_body "${TOOL_SECTION_BODY}"

set-output naive_status "${NAIVE_STATUS}"
set-output naive_status_label "${NAIVE_STATUS_LABEL}"
set-output naive_top_issue "${NAIVE_TOP_ISSUE}"
set-output naive_section_body "${NAIVE_SECTION_BODY}"

exit $EXIT_CODE
