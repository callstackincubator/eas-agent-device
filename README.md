# EAS agent-device demo

This repo is a minimal Expo + CNG example for running AI-assisted Android and iOS QA on EAS Workflows with [e2e](https://e2e.tester.army/docs), which drives the app through [agent-device](https://github.com/callstack/agent-device).

## What it does

- Reuses compatible Android and iOS simulator builds with `fingerprint` + `get-build` + `repack`
- Falls back to a fresh `build` when the fingerprint changes
- Boots an Android emulator and an iOS simulator on EAS runners and installs the build
- Runs a smoke test with `e2e explore`: an agent explores the app, focusing on what the pull request changes (inferred from its description and diff), and reports functional bugs and visual inconsistencies
- Runs the e2e test suite in [e2e/tests](./e2e/tests): deterministic locator tests plus an agent test
- Posts one combined mobile QA summary back to the GitHub pull request with `github-comment`
- Optionally uploads screenshots to Vercel Blob so the PR comment can show them

`qa-release` and `qa-ios-simulator` are fast review artifacts for PR automation. They are not production shipping artifacts.

## Files

- [eas.json](./eas.json)
- [.eas/workflows/agent-qa-mobile.yml](./.eas/workflows/agent-qa-mobile.yml)
- [e2e/e2e.config.ts](./e2e/e2e.config.ts): targets, the model, and the `smoke` agent the exploration runs as
- [e2e/scripts/explore-goal.mjs](./e2e/scripts/explore-goal.mjs): builds the exploration goal and context from the pull request
- [e2e/scripts/explore-and-export.sh](./e2e/scripts/explore-and-export.sh): runs `e2e explore` and exports the result for the PR comment

## Required setup

1. Link the project to EAS.
2. Keep using CNG. Do not commit `android/` or `ios/`.
3. Configure an EAS environment named `preview`.
4. Add `AI_GATEWAY_API_KEY` to that environment.
5. Treat the `qa-release` and `qa-ios-simulator` profiles as CI review output only. Keep store or production release flows separate.

Optional environment variables for the QA jobs:

- `E2E_MODEL`: Override the test suite's model (`openai/gpt-5.4-mini`)
- `E2E_SMOKE_MODEL`: Override the smoke test's model (`anthropic/claude-sonnet-5.5`)
- `E2E_EXPLORE_MAX_STEPS`: Exploration steps, 1 through 12 (default 8)
- `E2E_EXPLORE_TIMEOUT_MS`: Exploration wall clock, 180000 through 900000 (default 600000)
- `E2E_IOS_RUNTIME` / `E2E_IOS_MAJOR`: Pin the iOS simulator runtime (default: the newest iOS 26)
- `BLOB_READ_WRITE_TOKEN`: Upload screenshots to Vercel Blob and include them in the PR comment

The smoke test fails on an `issue` finding (a functional defect) and passes with only `warning` findings (cosmetic).

## Run locally

Build a Release app, install it on a booted simulator or emulator, then:

```bash
cd e2e
npm install
AI_GATEWAY_API_KEY=... npx e2e run --target ios       # the test suite
AI_GATEWAY_API_KEY=... npx e2e explore --target ios --agent smoke 'Smoke test the Explore tab'
```

To explore with a pull request's context, as the workflow does:

```bash
cd e2e
PR_JSON="$(gh api repos/<owner>/<repo>/pulls/<number>)" AI_GATEWAY_API_KEY=... \
  bash ./scripts/explore-and-export.sh ios
```

`explore-and-export.sh` calls `set-output`, which only exists on EAS; locally those lines print an error after the run and can be ignored.
