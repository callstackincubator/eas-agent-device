#!/usr/bin/env bash

set -euxo pipefail

DEVICE_NAME="${AGENT_DEVICE_IOS_DEVICE:?AGENT_DEVICE_IOS_DEVICE is required}"
export AGENT_DEVICE_DAEMON_TIMEOUT_MS="${AGENT_DEVICE_DAEMON_TIMEOUT_MS:-180000}"
export AGENT_DEVICE_IOS_BOOT_TIMEOUT_MS="${AGENT_DEVICE_IOS_BOOT_TIMEOUT_MS:-180000}"

agent-device boot --platform ios --device "${DEVICE_NAME}"
agent-device prepare ios-runner --platform ios --device "${DEVICE_NAME}" --timeout "${AGENT_DEVICE_DAEMON_TIMEOUT_MS}"

if command -v set-env >/dev/null 2>&1; then
  set-env AGENT_DEVICE_IOS_DEVICE "${DEVICE_NAME}"
fi
