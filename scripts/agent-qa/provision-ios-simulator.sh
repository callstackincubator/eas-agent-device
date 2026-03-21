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

json_path, device_name = sys.argv[1], sys.argv[2]
with open(json_path, "r", encoding="utf-8") as fp:
    data = json.load(fp)

device_type_id = ""
for item in data.get("devicetypes", []):
    if item.get("name") == device_name:
        device_type_id = item.get("identifier", "")
        break

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
        if device.get("isAvailable") and device.get("name") == device_name:
            existing_udid = device.get("udid", "")
            break
    if existing_udid:
        break

print(device_type_id)
print(runtime_id)
print(runtime_name)
print(existing_udid)
PY
  )

  DEVICE_TYPE_ID="${SIMCTL_VALUES[0]:-}"
  RUNTIME_ID="${SIMCTL_VALUES[1]:-}"
  RUNTIME_NAME="${SIMCTL_VALUES[2]:-}"
  EXISTING_UDID="${SIMCTL_VALUES[3]:-}"

  if [ -z "${DEVICE_TYPE_ID}" ]; then
    echo "Could not resolve simctl device type for ${DEVICE_NAME}" >&2
    exit 1
  fi

  if [ -z "${RUNTIME_ID}" ]; then
    echo "Could not resolve an available iOS simulator runtime" >&2
    exit 1
  fi

  if [ -n "${EXISTING_UDID}" ]; then
    UDID="${EXISTING_UDID}"
  else
    UDID="$(xcrun simctl create "${DEVICE_NAME}" "${DEVICE_TYPE_ID}" "${RUNTIME_ID}")"
  fi

  xcrun simctl boot "${UDID}" || true
  xcrun simctl bootstatus "${UDID}" -b
  echo "Provisioned simulator ${DEVICE_NAME} (${UDID}) using runtime ${RUNTIME_NAME}"
fi

npx agent-device devices --platform ios || true
