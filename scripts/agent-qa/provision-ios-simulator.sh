#!/usr/bin/env bash

set -euxo pipefail

DEVICE_NAME="${AGENT_DEVICE_IOS_DEVICE:?AGENT_DEVICE_IOS_DEVICE is required}"
export AGENT_DEVICE_DAEMON_TIMEOUT_MS="${AGENT_DEVICE_DAEMON_TIMEOUT_MS:-180000}"
export AGENT_DEVICE_IOS_BOOT_TIMEOUT_MS="${AGENT_DEVICE_IOS_BOOT_TIMEOUT_MS:-180000}"

if ! npx agent-device ensure-simulator --platform ios --device "${DEVICE_NAME}" --boot; then
  echo "agent-device ensure-simulator failed, falling back to simctl provisioning"

  SIMCTL_JSON="$(mktemp)"
  xcrun simctl list --json devicetypes runtimes devices available > "${SIMCTL_JSON}"

  readarray -t SIMCTL_VALUES < <(
    python3 - "${SIMCTL_JSON}" "${DEVICE_NAME}" <<'PY'
import json
import sys

json_path, selected_device_name = sys.argv[1], sys.argv[2]
with open(json_path, "r", encoding="utf-8") as fp:
    data = json.load(fp)

available_device_types = {
    item.get("name", ""): item.get("identifier", "")
    for item in data.get("devicetypes", [])
    if item.get("name") and item.get("identifier")
}

device_type_id = ""
device_type_id = available_device_types.get(selected_device_name, "")

runtime_id = ""
runtime_name = ""
for item in reversed(data.get("runtimes", [])):
    if (
        item.get("isAvailable")
        and item.get("platform") == "iOS"
        and item.get("identifier", "").startswith("com.apple.CoreSimulator.SimRuntime.iOS-")
    ):
        runtime_id = item.get("identifier", "")
        runtime_name = item.get("name", "")
        break

existing_udid = ""
for runtime_devices in data.get("devices", {}).values():
    for device in runtime_devices:
        if device.get("isAvailable") and device.get("name") == selected_device_name:
            existing_udid = device.get("udid", "")
            break
    if existing_udid:
        break

print(selected_device_name)
print(device_type_id)
print(runtime_id)
print(runtime_name)
print(existing_udid)
PY
  )

  SELECTED_DEVICE_NAME="${SIMCTL_VALUES[0]:-}"
  DEVICE_TYPE_ID="${SIMCTL_VALUES[1]:-}"
  RUNTIME_ID="${SIMCTL_VALUES[2]:-}"
  RUNTIME_NAME="${SIMCTL_VALUES[3]:-}"
  EXISTING_UDID="${SIMCTL_VALUES[4]:-}"

  if [ -z "${SELECTED_DEVICE_NAME}" ] || [ -z "${DEVICE_TYPE_ID}" ]; then
    echo "Could not resolve simctl device type for requested device: ${DEVICE_NAME}" >&2
    exit 1
  fi

  if [ -z "${RUNTIME_ID}" ]; then
    echo "Could not resolve an available iOS simulator runtime" >&2
    exit 1
  fi

  if [ -n "${EXISTING_UDID}" ]; then
    UDID="${EXISTING_UDID}"
  else
    UDID="$(xcrun simctl create "${SELECTED_DEVICE_NAME}" "${DEVICE_TYPE_ID}" "${RUNTIME_ID}")"
  fi

  xcrun simctl boot "${UDID}" || true
  xcrun simctl bootstatus "${UDID}" -b
  DEVICE_NAME="${SELECTED_DEVICE_NAME}"
  echo "Provisioned simulator ${DEVICE_NAME} (${UDID}) using runtime ${RUNTIME_NAME}"
fi

if command -v set-env >/dev/null 2>&1; then
  set-env AGENT_DEVICE_IOS_DEVICE "${DEVICE_NAME}"
fi
