# EAS agent-device demo

This repo is a minimal Expo + CNG example for running AI-assisted Android and iOS QA on EAS Workflows.

## What it does

- Reuses compatible Android and iOS simulator builds with `fingerprint` + `get-build` + `repack`
- Falls back to a fresh `build` when the fingerprint changes
- Runs a small Node.js QA agent built with the AI SDK `ToolLoopAgent`
- Uses `agent-device` to drive the Android app and iOS simulator, take screenshots, and summarize findings
- Posts one combined mobile QA summary back to the GitHub pull request with `github-comment`
- Optionally uploads screenshots to Vercel Blob so the PR comment can link them

`qa-release` and `qa-ios-simulator` are fast review artifacts for PR automation. They are not production shipping artifacts.

## Files

- [eas.json](./eas.json)
- [.eas/workflows/agent-qa-mobile.yml](./.eas/workflows/agent-qa-mobile.yml)
- [scripts/agent-qa/index.ts](./scripts/agent-qa/index.ts)

## Required setup

1. Link the project to EAS.
2. Keep using CNG. Do not commit `android/` or `ios/`.
3. Configure an EAS environment named `preview`.
4. Add `AI_GATEWAY_API_KEY` to that environment.
5. Treat the `qa-release` and `qa-ios-simulator` profiles as CI review output only. Keep store or production release flows separate.

Optional environment variables for the QA job:

- `AGENT_DEVICE_ANDROID_DEVICE`: Android AVD name to boot in CI
- `AGENT_DEVICE_IOS_DEVICE`: iOS simulator name to boot in CI
- `QA_MODEL`: Override the default model (`openai/gpt-5.4-mini`)
- `BLOB_READ_WRITE_TOKEN`: Upload screenshots to Vercel Blob and include public links in the PR comment

## Local smoke test

```bash
npm install
npx tsc --noEmit
```

The workflow runner writes `section.md`, `status.txt`, and `report.json` to `artifacts/qa/` during execution. Temporary screenshots are written outside the workspace and uploaded to Vercel Blob when configured.

To execute the runner directly with Node 24, provide the same environment variables the workflow sets:

Android:

```bash
AI_GATEWAY_API_KEY=... \
QA_PLATFORM=android \
APP_PATH=/absolute/path/to/app.apk \
APPLICATION_ID=dev.expo.easagentdevice \
BUILD_ID=test-build \
PR_JSON='{"number":1,"title":"Test PR","body":"Smoke test"}' \
node ./scripts/agent-qa/index.ts
```

iOS simulator:

```bash
AI_GATEWAY_API_KEY=... \
QA_PLATFORM=ios \
APP_PATH=/absolute/path/to/MyApp.app \
APPLICATION_ID=dev.expo.easagentdevice \
AGENT_DEVICE_IOS_DEVICE="iPhone 17 Pro" \
BUILD_ID=test-build \
PR_JSON='{"number":1,"title":"Test PR","body":"Smoke test"}' \
node ./scripts/agent-qa/index.ts
```

The workflow currently defaults to `iPhone 17 Pro`, because that device family is exposed on the current Expo macOS workers.
