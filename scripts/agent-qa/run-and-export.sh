#!/usr/bin/env bash

set -uo pipefail

APP_PATH_ARG="${1:?APP_PATH argument is required}"
QA_PLATFORM_VALUE="${QA_PLATFORM:?QA_PLATFORM is required}"

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

set-output status "$STATUS"
set-output status_label "$STATUS_LABEL"
set-output section_body "$SECTION_BODY"
exit $EXIT_CODE
