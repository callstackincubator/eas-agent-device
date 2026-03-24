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

STATUS="$(cat artifacts/qa/status.txt 2>/dev/null || printf blocked)"
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

if [ -f artifacts/qa/section.md ]; then
  SECTION_BODY="$(cat artifacts/qa/section.md)"
else
  SECTION_BODY="### ${PLATFORM_LABEL}

**Status:** ${STATUS_LABEL}

No ${PLATFORM_LABEL} QA section was produced.
"
fi

if [ -f artifacts/qa/report.json ]; then
  TOP_ISSUE="$(
    jq -r '
      if .overallStatus == "passed" then
        "N/A"
      else
        (.issues[0] // .summary // "N/A")
      end
    ' artifacts/qa/report.json | tr '\n' ' ' | sed 's/[[:space:]]\+/ /g; s/^ //; s/ $//'
  )"

  SCREENSHOT_ROWS="$(
    jq -r --arg platform "${PLATFORM_LABEL}" '
      if (.screenshots | length) == 0 then
        "| \($platform) | N/A |"
      else
        .screenshots[]
        | if .blobUrl then
            "| \($platform) | <a href=\"\(.blobUrl)\"><img src=\"\(.blobUrl)\" alt=\"\(.fileName)\" height=\"500\" /></a> |"
          else
            "| \($platform) | \(.fileName) (\(.bytes) bytes) |"
          end
      end
    ' artifacts/qa/report.json
  )"
else
  if [ "${STATUS}" = "passed" ]; then
    TOP_ISSUE="N/A"
  else
    TOP_ISSUE="No report.json was produced."
  fi
  SCREENSHOT_ROWS="| ${PLATFORM_LABEL} | N/A |"
fi

set-output status "$STATUS"
set-output status_label "$STATUS_LABEL"
set-output top_issue "$TOP_ISSUE"
set-output screenshot_rows "$SCREENSHOT_ROWS"
set-output section_body "$SECTION_BODY"
exit $EXIT_CODE
