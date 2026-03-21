#!/usr/bin/env bash

set -euxo pipefail

DEVICE_NAME="${AGENT_DEVICE_IOS_DEVICE:?AGENT_DEVICE_IOS_DEVICE is required}"

npx agent-device ensure-simulator --platform ios --device "${DEVICE_NAME}" --boot
npx agent-device devices --platform ios || true
