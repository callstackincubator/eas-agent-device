import type { E2EConfig } from 'e2e';
import { readFileSync } from 'node:fs';

import { mobile } from '@e2e-dev/mobile';
import { gateway } from 'ai';

import { blobStore } from './blob-store.ts';

// Bundle id and package name from app.json. The workflow installs the EAS
// build before the run; locally, install a Release build on a booted device.
const app = { bundleId: 'dev.expo.easagentdevice' };
// The Vercel AI Gateway reads AI_GATEWAY_API_KEY. Only tests that use `agent`
// and `e2e explore` need it; tests/navigation.e2e.ts runs without one.
const model = gateway(process.env.E2E_MODEL ?? 'openai/gpt-6-luna');
// The pull request's description and diff, from scripts/explore-goal.mjs.
const prContext = process.env.E2E_PR_CONTEXT_FILE ? readFileSync(process.env.E2E_PR_CONTEXT_FILE, 'utf8') : undefined;

export default {
  projectId: 'eas-agent-device',
  agents: {
    default: {
      model,
      system: 'You are a thorough QA agent testing an Expo app. Verify every outcome.',
    },
    // `e2e explore --agent smoke`: the pull request smoke test. Exploration
    // plans its own steps and files findings that fail the job, so it gets a
    // stronger model than the scripted tests.
    smoke: {
      model: gateway(process.env.E2E_SMOKE_MODEL ?? 'anthropic/claude-sonnet-5.5'),
      system: [
        'You are a mobile QA engineer smoke testing a pull request build of an Expo app on a simulator or emulator.',
        'The app is a black box: judge only what a user can see and do.',
        'Report a functional defect (a crash, a dead control, wrong data, a broken navigation) as an issue.',
        'Look at screenshots, not only the accessibility tree, before judging visuals. Report visual inconsistencies such as',
        'clipped, truncated, overlapping, or overflowing text, misaligned or unevenly spaced elements, inconsistent colors',
        'or typography between screens, unreadable contrast, and leftover placeholder or template text. Report them as',
        'warnings, or as issues when they block the user.',
        'Ignore the status bar, the system navigation bar, the simulator itself, and the AgentDeviceRunner automation app.',
        'Report only defects you observed in the app. Never report something you did not get to, could not verify, or a',
        'step of your own that failed; plan the next step instead.',
        'Before reporting that a control does nothing, tap it exactly once, then read the screen again: many controls',
        'toggle, so a second tap undoes the first. Report it only when it still does nothing after a single tap on its',
        'center. Do not repeat a check that already passed.',
      ].join(' '),
      context: prContext,
    },
  },
  targets: [
    // E2E_DEVICE pins a simulator UDID or emulator serial; without it the
    // engine uses the booted device.
    { name: 'ios', engine: mobile({ platform: 'ios', device: process.env.E2E_DEVICE || undefined }), app },
    { name: 'android', engine: mobile({ platform: 'android', device: process.env.E2E_DEVICE || undefined }), app },
  ],
  // With a Blob token, screenshots get public URLs the PR comment can embed.
  artifacts: process.env.BLOB_READ_WRITE_TOKEN
    ? { store: blobStore(`e2e/${process.env.E2E_BLOB_PREFIX ?? 'local'}`) }
    : undefined,
  // A cold simulator and a release app's first launch are slower than the defaults assume.
  launchTimeout: 180_000,
  assertionTimeout: 15_000,
  workers: 1,
} satisfies E2EConfig;
