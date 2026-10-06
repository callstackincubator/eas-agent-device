#!/usr/bin/env bash

set -euxo pipefail

APP_PATH_ARG="${1:?APP_PATH argument is required}"
DEVICE_TYPE="${E2E_IOS_DEVICE_TYPE:-iPhone 17}"

xcrun simctl list runtimes

# Pin the runtime with E2E_IOS_RUNTIME (for example com.apple.CoreSimulator.SimRuntime.iOS-26-5).
# Otherwise use the newest runtime of E2E_IOS_MAJOR: iOS 27 requires UIScene
# lifecycle adoption, which this app's React Native version does not have yet.
IOS_MAJOR="${E2E_IOS_MAJOR:-26}"
RUNTIME="${E2E_IOS_RUNTIME:-}"
if [ -z "${RUNTIME}" ]; then
  RUNTIME="$(
    xcrun simctl list runtimes --json \
      | jq -r --arg major "${IOS_MAJOR}" '
          [.runtimes[] | select(.platform == "iOS" and .isAvailable)]
          | sort_by(.version | split(".") | map(tonumber))
          | (map(select(.version | startswith($major + "."))) | last) // last
          | .identifier'
  )"
fi

UUID_PATTERN='^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$'
UDID="$(xcrun simctl create e2e "${DEVICE_TYPE}" "${RUNTIME}" 2>/dev/null || true)"
if ! [[ "${UDID}" =~ ${UUID_PATTERN} ]]; then
  # The runtime does not support DEVICE_TYPE; fall back to its newest iPhone.
  DEVICE_TYPE="$(
    xcrun simctl list runtimes --json \
      | jq -r --arg runtime "${RUNTIME}" '.runtimes[] | select(.identifier == $runtime) | [.supportedDeviceTypes[] | select(.productFamily == "iPhone")] | last | .identifier'
  )"
  UDID="$(xcrun simctl create e2e "${DEVICE_TYPE}" "${RUNTIME}")"
fi
[[ "${UDID}" =~ ${UUID_PATTERN} ]]
xcrun simctl bootstatus "${UDID}" -b
xcrun simctl install "${UDID}" "${APP_PATH_ARG}"

set-env E2E_DEVICE "${UDID}"
