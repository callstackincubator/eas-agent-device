#!/usr/bin/env bash

set -euxo pipefail

DEVICE_NAME="${AGENT_DEVICE_IOS_DEVICE:?AGENT_DEVICE_IOS_DEVICE is required}"
export AGENT_DEVICE_DAEMON_TIMEOUT_MS="${AGENT_DEVICE_DAEMON_TIMEOUT_MS:-180000}"
export AGENT_DEVICE_IOS_BOOT_TIMEOUT_MS="${AGENT_DEVICE_IOS_BOOT_TIMEOUT_MS:-180000}"

agent-device ensure-simulator --platform ios --device "${DEVICE_NAME}" --boot
