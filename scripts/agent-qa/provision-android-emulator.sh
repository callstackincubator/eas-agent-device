#!/usr/bin/env bash

set -euxo pipefail

export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}"
export ANDROID_HOME="${ANDROID_HOME:-$ANDROID_SDK_ROOT}"
export PATH="$ANDROID_SDK_ROOT/emulator:$ANDROID_SDK_ROOT/platform-tools:$ANDROID_SDK_ROOT/cmdline-tools/tools/bin:$ANDROID_SDK_ROOT/cmdline-tools/latest/bin:$PATH"

SYSTEM_IMAGE="${ANDROID_SYSTEM_IMAGE:-system-images;android-35;google_apis;x86_64}"
AVD_NAME="${AGENT_DEVICE_ANDROID_DEVICE:?AGENT_DEVICE_ANDROID_DEVICE is required}"
AVD_DEVICE="${ANDROID_AVD_DEVICE:-pixel_6}"

echo "ANDROID_SDK_ROOT=${ANDROID_SDK_ROOT}"
which sdkmanager
which avdmanager

set +e
yes | sdkmanager --licenses
SDKMANAGER_LICENSES_EXIT="${PIPESTATUS[1]}"

yes | sdkmanager --install "platform-tools" "emulator" "${SYSTEM_IMAGE}"
SDKMANAGER_INSTALL_EXIT="${PIPESTATUS[1]}"
set -e

test "${SDKMANAGER_LICENSES_EXIT}" -eq 0
test "${SDKMANAGER_INSTALL_EXIT}" -eq 0

which emulator

if ! emulator -list-avds | grep -qx "${AVD_NAME}"; then
  echo "no" | avdmanager create avd \
    --force \
    --name "${AVD_NAME}" \
    --package "${SYSTEM_IMAGE}" \
    --device "${AVD_DEVICE}"
fi

# Provisioning should target a concrete device directly, without the QA session lock.
unset AGENT_DEVICE_SESSION
unset AGENT_DEVICE_PLATFORM
unset AGENT_DEVICE_SESSION_LOCK

npx agent-device boot --platform android --device "${AVD_NAME}" --headless
