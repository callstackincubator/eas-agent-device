#!/usr/bin/env bash

set -uo pipefail

APP_PATH_ARG="${1:?APP_PATH argument is required}"
QA_PLATFORM_VALUE="${QA_PLATFORM:?QA_PLATFORM is required}"
APPLICATION_ID_VALUE="${APPLICATION_ID:?APPLICATION_ID is required}"
OUTPUT_DIR="artifacts/qa"
CONTEXT_PATH="${OUTPUT_DIR}/cali-context.json"
SCREENSHOTS_DIR="${OUTPUT_DIR}/screenshots"

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
DEVICE_NAME_VALUE="${DEVICE_NAME:-}"
if [ -z "${DEVICE_NAME_VALUE}" ]; then
  if [ "${QA_PLATFORM_VALUE}" = "ios" ]; then
    DEVICE_NAME_VALUE="${AGENT_DEVICE_IOS_DEVICE:-}"
  else
    DEVICE_NAME_VALUE="${AGENT_DEVICE_ANDROID_DEVICE:-}"
  fi
fi

jq -n \
  --arg workspaceRoot "${PWD}" \
  --arg platform "${QA_PLATFORM_VALUE}" \
  --arg artifactPath "${APP_PATH_ARG}" \
  --arg appId "${APPLICATION_ID_VALUE}" \
  --arg deviceName "${DEVICE_NAME_VALUE}" \
  --arg buildId "${BUILD_ID:-}" \
  --arg workflowUrl "${WORKFLOW_URL:-}" \
  --arg outputDir "${OUTPUT_DIR}" \
  --arg screenshotsDir "${SCREENSHOTS_DIR}" \
  --argjson pr "${PR_JSON:-{}}" \
  '
  {
    workspaceRoot: $workspaceRoot,
    pullRequest:
      if ($pr | type) == "object" and (($pr | keys) | length) > 0 then
        {
          number: ($pr.number // null),
          title: ($pr.title // null),
          body: ($pr.body // null),
          url: ($pr.html_url // $pr.url // null),
          labels: (($pr.labels // []) | map(if type == "object" then (.name // empty) else . end) | map(select(. != ""))),
          isDraft: ($pr.draft // false),
          baseBranch: ($pr.base.ref // null),
          headBranch: ($pr.head.ref // null)
        }
      else
        null
      end,
    mobile: {
      platform: $platform,
      artifactPath: $artifactPath,
      appId: $appId,
      deviceName: if $deviceName == "" then null else $deviceName end
    },
    build: {
      id: if $buildId == "" then null else $buildId end,
      workflowUrl: if $workflowUrl == "" then null else $workflowUrl end
    },
    output: {
      outputDir: $outputDir,
      screenshotsDir: $screenshotsDir
    }
  }
  ' > "${CONTEXT_PATH}"

set +e
npm run agent-qa -- --context "${CONTEXT_PATH}"
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

  SCREENSHOTS_CELL="$(
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
    ' artifacts/qa/report.json
  )"
else
  if [ "${STATUS}" = "passed" ]; then
    TOP_ISSUE="N/A"
  else
    TOP_ISSUE="No report.json was produced."
  fi
  SCREENSHOTS_CELL="N/A"
fi

set-output status "$STATUS"
set-output status_label "$STATUS_LABEL"
set-output top_issue "$TOP_ISSUE"
set-output screenshots_cell "$SCREENSHOTS_CELL"
set-output section_body "$SECTION_BODY"
exit $EXIT_CODE
