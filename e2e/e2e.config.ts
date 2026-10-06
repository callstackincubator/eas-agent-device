import type { E2EConfig } from 'e2e';
import { mobile } from '@e2e-dev/mobile';
import { gateway } from 'ai';

// Bundle id and package name from app.json. The workflow installs the EAS
// build before the run; locally, install a Release build on a booted device.
const app = { bundleId: 'dev.expo.easagentdevice' };

export default {
  projectId: 'eas-agent-device',
  agents: {
    default: {
      // The Vercel AI Gateway reads AI_GATEWAY_API_KEY. Only tests that use
      // `agent` need it; tests/navigation.e2e.ts runs without one.
      model: gateway(process.env.E2E_MODEL ?? 'openai/gpt-5.4-mini'),
      system: 'You are a thorough QA agent testing an Expo app. Verify every outcome.',
    },
  },
  targets: [
    // E2E_DEVICE pins a simulator UDID or emulator serial; without it the
    // engine uses the booted device.
    { name: 'ios', engine: mobile({ platform: 'ios', device: process.env.E2E_DEVICE || undefined }), app },
    { name: 'android', engine: mobile({ platform: 'android', device: process.env.E2E_DEVICE || undefined }), app },
  ],
  // A cold simulator and a release app's first launch are slower than the defaults assume.
  launchTimeout: 180_000,
  assertionTimeout: 15_000,
  workers: 1,
} satisfies E2EConfig;
