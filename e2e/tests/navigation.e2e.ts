import { expect, test } from 'e2e';

test('opens on the home tab', async ({ app, screen }) => {
  await app.open();

  await expect(screen.getByText('Welcome!')).toBeVisible();
  await expect(screen.getByText('Step 1: Try it')).toBeVisible();
});

test('switches to the explore tab', async ({ app, screen }) => {
  await app.open();

  await screen.getByText('Explore').first().tap();

  await expect(screen.getByText('This app includes example code to help you get started.')).toBeVisible();
});

test('expands a collapsible section', async ({ app, screen }) => {
  await app.open();
  await screen.getByText('Explore').first().tap();

  // The collapsible sections sit below the parallax header; scroll them into view.
  const section = screen.getByText('File-based routing');
  for (let swipes = 0; swipes < 3 && !(await section.isVisible()); swipes++) {
    await screen.swipe({ direction: 'up' });
  }
  await section.tap();

  await expect(screen.getByText(/sets up the tab navigator/)).toBeVisible();
});
