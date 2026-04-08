#!/usr/bin/env bash

set -uo pipefail

APP_PATH_ARG="${1:?APP_PATH argument is required}"
QA_PLATFORM_VALUE="${QA_PLATFORM:?QA_PLATFORM is required}"
APPLICATION_ID_VALUE="${APPLICATION_ID:?APPLICATION_ID is required}"
OUTPUT_DIR="artifacts/qa"
CONTEXT_PATH="${OUTPUT_DIR}/cali-context.json"
SCREENSHOTS_JSON_PATH="${OUTPUT_DIR}/screenshots.json"

mkdir -p "${OUTPUT_DIR}"

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

export APP_PATH="${APP_PATH_ARG}"
export CALI_OUTPUT_DIR="${OUTPUT_DIR}"
DEVICE_NAME_VALUE="${DEVICE_NAME:-}"
if [ -z "${DEVICE_NAME_VALUE}" ]; then
  if [ "${QA_PLATFORM_VALUE}" = "ios" ]; then
    DEVICE_NAME_VALUE="${AGENT_DEVICE_IOS_DEVICE:-}"
  else
    DEVICE_NAME_VALUE="${AGENT_DEVICE_ANDROID_DEVICE:-}"
  fi
fi

set +e
if [ -n "${DEVICE_NAME_VALUE}" ]; then
  cali write-mobile-pr-context --from eas --output "${CONTEXT_PATH}" --device "${DEVICE_NAME_VALUE}"
  CONTEXT_EXIT=$?
else
  cali write-mobile-pr-context --from eas --output "${CONTEXT_PATH}"
  CONTEXT_EXIT=$?
fi

if [ "${CONTEXT_EXIT}" -eq 0 ]; then
  cali qa --env eas-mobile-pr --quiet --context "${CONTEXT_PATH}"
  EXIT_CODE=$?
else
  EXIT_CODE="${CONTEXT_EXIT}"
fi

STATUS="$(cat "${OUTPUT_DIR}/status.txt" 2>/dev/null || printf blocked)"
case "${STATUS}" in
  passed)
    STATUS_LABEL="✅ passed"
    ;;
  failed)
    STATUS_LABEL="❌ failed"
    ;;
  blocked)
    STATUS_LABEL="⛔ blocked"
    ;;
  unsure)
    STATUS_LABEL="🤔 unsure"
    ;;
  not_tested)
    STATUS_LABEL="⚪ not_tested"
    ;;
  *)
    STATUS_LABEL="⚪ ${STATUS}"
    ;;
esac

if [ ! -f "${OUTPUT_DIR}/report.json" ]; then
  FALLBACK_SUMMARY="The Cali QA command failed before it could publish a report. Check the run_agent_qa logs above."
  cat > "${OUTPUT_DIR}/status.txt" <<EOF2
blocked
EOF2
  cat > "${OUTPUT_DIR}/section.md" <<EOF2
### ${PLATFORM_LABEL}

**Status:** ⛔ blocked

${FALLBACK_SUMMARY}
EOF2
  cat > "${OUTPUT_DIR}/top-issue.txt" <<EOF2
${FALLBACK_SUMMARY}
EOF2
  cat > "${OUTPUT_DIR}/screenshots.json" <<EOF2
{"command":"qa","platform":"${QA_PLATFORM_VALUE}","screenshots":[]}
EOF2
fi

TOP_ISSUE="$(tr '\n' ' ' < "${OUTPUT_DIR}/top-issue.txt" 2>/dev/null | sed 's/[[:space:]]\+/ /g; s/^ //; s/ $//')"
if [ -z "${TOP_ISSUE}" ]; then
  if [ "${STATUS}" = "passed" ]; then
    TOP_ISSUE="N/A"
  else
    TOP_ISSUE="No report.json was produced."
  fi
fi

if [ -f "${SCREENSHOTS_JSON_PATH}" ]; then
  SCREENSHOTS_CELL="$(
    jq -r '
      if ((.screenshots // []) | length) == 0 then
        "N/A"
      else
        [
          (.screenshots // [])[]
          | if .blobUrl then
              "**\((.label // .fileName // \"Screenshot\"))**<br><a href=\"\(.blobUrl)\"><img src=\"\(.blobUrl)\" alt=\"\((.label // .fileName // \"Screenshot\"))\" height=\"500\" /></a>"
            else
              "**\((.label // .fileName // \"Screenshot\"))**<br>\(.fileName // \"screenshot\")"
            end
        ] | join("<br><br>")
      end
    ' "${SCREENSHOTS_JSON_PATH}"
  )"
else
  SCREENSHOTS_CELL="N/A"
fi

SECTION_BODY="$(cat "${OUTPUT_DIR}/section.md" 2>/dev/null || printf '### %s\n\n**Status:** %s\n\nNo %s QA section was produced.\n' "${PLATFORM_LABEL}" "${STATUS_LABEL}" "${PLATFORM_LABEL}")"

set-output status "$STATUS"
set-output status_label "$STATUS_LABEL"
set-output top_issue "$TOP_ISSUE"
set-output screenshots_cell "$SCREENSHOTS_CELL"
set-output section_body "$SECTION_BODY"
exit $EXIT_CODE
