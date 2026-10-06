#!/usr/bin/env bash

set -euxo pipefail

APP_PATH_ARG="${1:?APP_PATH argument is required}"
DEVICE_TYPE="${E2E_IOS_DEVICE_TYPE:-iPhone 17}"

xcrun simctl list runtimes

# Pin the runtime with E2E_IOS_RUNTIME (for example com.apple.CoreSimulator.SimRuntime.iOS-26-5);
# otherwise use the newest iOS runtime the image ships.
RUNTIME="${E2E_IOS_RUNTIME:-}"
if [ -z "${RUNTIME}" ]; then
  RUNTIME="$(
    xcrun simctl list runtimes --json \
      | jq -r '[.runtimes[] | select(.platform == "iOS" and .isAvailable)] | sort_by(.version | split(".") | map(tonumber)) | last | .identifier'
  )"
fi

UDID="$(xcrun simctl create e2e "${DEVICE_TYPE}" "${RUNTIME}")"
xcrun simctl bootstatus "${UDID}" -b
xcrun simctl install "${UDID}" "${APP_PATH_ARG}"

set-env E2E_DEVICE "${UDID}"
