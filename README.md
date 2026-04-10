# EAS agent-device demo

This repo is a minimal Expo + CNG example for running AI-assisted Android and iOS QA on EAS Workflows with [`cali`](https://github.com/callstackincubator/cali).

## What it does

- Reuses compatible Android and iOS simulator builds with `fingerprint` + `get-build` + `repack`
- Falls back to a fresh `build` when the fingerprint changes
- Uses `cali qa` as the mobile QA agent runtime
- Uses `agent-device` to drive the Android app and iOS simulator, take screenshots, and summarize findings
- Posts one combined mobile QA summary back to the GitHub pull request with `github-comment`
- Optionally uploads screenshots to Vercel Blob so the PR comment can link them

`qa-release` and `qa-ios-simulator` are fast review artifacts for PR automation. They are not production shipping artifacts.

## Files

- [eas.json](./eas.json)
- [.eas/workflows/agent-qa-mobile.yml](./.eas/workflows/agent-qa-mobile.yml)
- [cali.config.json](./cali.config.json)
- [scripts/agent-qa/run-and-export.sh](./scripts/agent-qa/run-and-export.sh)

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

The workflow installs the [`agent-device`](https://www.npmjs.com/package/agent-device) skill explicitly in CI with `npx skills add callstackincubator/agent-device --agent codex --skill agent-device -y`, so Cali can discover it from the standard `.agents/skills` location.

## Local smoke test

```bash
npm install
npx cali qa --help
```

Local runs use the `local-android` and `local-ios` Cali envs. The EAS workflow uses `cali qa --ci eas ...`, not `--env mobile-pr`.

The workflow runner writes `report.json`, `section.md`, `status.txt`, and CI export files like `ci-comment.md` and `ci-output.json` to `artifacts/qa/`. Screenshots are written to `artifacts/qa/screenshots` and uploaded to Vercel Blob when configured.

To execute the QA command directly, provide the same core inputs that the workflow uses. `--device` is optional locally; pass it only when you want to target a specific simulator or emulator.

Android:

```bash
AI_GATEWAY_API_KEY=... \
npm run agent-qa:android -- \
  --artifact /absolute/path/to/app.apk \
  --app-id dev.expo.easagentdevice \
  --prompt "verify the updated welcome title"
```

iOS simulator:

```bash
AI_GATEWAY_API_KEY=... \
npm run agent-qa:ios -- \
  --artifact /absolute/path/to/MyApp.app \
  --app-id dev.expo.easagentdevice \
  --prompt "verify the updated welcome title"
```
