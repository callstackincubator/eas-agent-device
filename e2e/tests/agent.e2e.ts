import { expect, test } from 'e2e';

import { scrollTo } from './scroll.ts';

// Agent steps call the model in e2e.config.ts. Without a key these tests are skipped.
const skip = process.env.AI_GATEWAY_API_KEY ? false : 'set AI_GATEWAY_API_KEY to run agent tests';

test('the agent finds the animations section', { skip }, async ({ app, agent, screen }) => {
  await app.open();

  await agent.act('open the Explore tab, scroll to the "Animations" section, and tap its header once to expand it');

  // Pair each agent step with a check that does not depend on the model.
  const description = screen.getByText(/waving hand animation/);
  await scrollTo(screen, description);
  await expect(description).toBeVisible();
  await agent.assert('the Animations section is expanded and explains the waving hand animation');
});
