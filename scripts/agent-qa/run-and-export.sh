#!/usr/bin/env bash

set -uo pipefail

APP_PATH_ARG="${1:?APP_PATH argument is required}"
QA_PLATFORM_VALUE="${QA_PLATFORM:?QA_PLATFORM is required}"
APPLICATION_ID_VALUE="${APPLICATION_ID:?APPLICATION_ID is required}"
OUTPUT_DIR="artifacts/qa"

mkdir -p "${OUTPUT_DIR}"

DEVICE_NAME_VALUE="${DEVICE_NAME:-}"
if [ -z "${DEVICE_NAME_VALUE}" ]; then
  if [ "${QA_PLATFORM_VALUE}" = "ios" ]; then
    DEVICE_NAME_VALUE="${AGENT_DEVICE_IOS_DEVICE:-}"
  else
    DEVICE_NAME_VALUE="${AGENT_DEVICE_ANDROID_DEVICE:-}"
  fi
fi

export CALI_OUTPUT_DIR="${OUTPUT_DIR}"

QA_ARGS=(
  qa
  --ci
  eas
  --quiet
  --platform
  "${QA_PLATFORM_VALUE}"
  --artifact
  "${APP_PATH_ARG}"
  --app-id
  "${APPLICATION_ID_VALUE}"
)

if [ -n "${DEVICE_NAME_VALUE}" ]; then
  QA_ARGS+=(--device "${DEVICE_NAME_VALUE}")
fi

set +e
cali "${QA_ARGS[@]}"
QA_EXIT_CODE=$?
set -e

if [ ! -f "${OUTPUT_DIR}/report.json" ]; then
  cat > "${OUTPUT_DIR}/report.json" <<EOF
{
  "command": "qa",
  "overallStatus": "blocked",
  "summary": "The Cali QA command failed before it could publish a report. Check the run_agent_qa logs above.",
  "checked": [],
  "issues": ["The Cali QA command failed before it could publish a report."],
  "acceptanceCriteriaUsed": [],
  "screenshots": [],
  "nextSteps": ["Inspect the Cali startup/bootstrap logs in the workflow output and retry the run."],
  "context": {
    "workspaceRoot": "${PWD}",
    "mobile": {
      "platform": "${QA_PLATFORM_VALUE}"
    },
    "output": {
      "outputDir": "${OUTPUT_DIR}"
    }
  }
}
EOF
fi

cali export-ci --report "${OUTPUT_DIR}/report.json"
exit "${QA_EXIT_CODE}"
