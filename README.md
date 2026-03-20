# EAS agent-device demo

This repo is a minimal Expo + CNG example for running AI-assisted Android QA on EAS Workflows.

## What it does

- Reuses compatible Android builds with `fingerprint` + `get-build` + `repack`
- Falls back to a fresh `build` when the fingerprint changes
- Runs a small Node.js QA agent built with the AI SDK `ToolLoopAgent`
- Uses `agent-device` to drive the Android app, take screenshots, and summarize findings
- Posts the QA summary back to the GitHub pull request with `github-comment`

`qa-release` is the fast review artifact for PR automation. It is not the production shipping artifact.

## Files

- [eas.json](./eas.json)
- [.eas/workflows/agent-qa-android.yml](./.eas/workflows/agent-qa-android.yml)
- [scripts/agent-qa/index.ts](./scripts/agent-qa/index.ts)

## Required setup

1. Link the project to EAS.
2. Keep using CNG. Do not commit `android/` or `ios/`.
3. Configure an EAS environment named `preview`.
4. Add `AI_GATEWAY_API_KEY` to that environment.
5. Treat the `qa-release` profile as CI review output only. Keep store or production release flows separate.

Optional environment variables for the QA job:

- `AGENT_DEVICE_ANDROID_DEVICE`: Android AVD name to boot in CI
- `AGENT_DEVICE_ANDROID_SERIAL`: Specific emulator/device serial to target
- `QA_MODEL`: Override the default model (`openai/gpt-5-mini`)

## Local smoke test

```bash
npm install
npx tsc --noEmit
```

The workflow runner writes its outputs to `artifacts/qa/` during execution. Those files are intentionally not committed.

To execute the runner directly with Node 24, provide the same environment variables the workflow sets:

```bash
AI_GATEWAY_API_KEY=... \
APK_PATH=/absolute/path/to/app.apk \
BUILD_ID=test-build \
PR_JSON='{"number":1,"title":"Test PR","body":"Smoke test"}' \
node ./scripts/agent-qa/index.ts
```
