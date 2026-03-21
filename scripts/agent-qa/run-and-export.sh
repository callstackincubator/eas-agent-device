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
if [ -f artifacts/qa/section.md ]; then
  SECTION_BODY="$(cat artifacts/qa/section.md)"
else
  SECTION_BODY="### ${PLATFORM_LABEL}

**Status:** blocked

No ${PLATFORM_LABEL} QA section was produced.
"
fi

set-output status "$STATUS"
set-output section_body "$SECTION_BODY"
exit $EXIT_CODE
