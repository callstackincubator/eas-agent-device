import type { Locator, Screen } from 'e2e';

/** Scrolls down until `target` is on screen; Android only exposes nodes inside the viewport. */
export async function scrollTo(screen: Screen, target: Locator, maxSwipes = 3) {
  for (let swipes = 0; swipes < maxSwipes && !(await target.isVisible()); swipes++) {
    // `down` scrolls the content down, revealing what is below.
    await screen.swipe({ direction: 'down' });
  }
}
