import type { Locator, Screen } from 'e2e';

/** Swipes up until `target` is on screen; Android only exposes nodes inside the viewport. */
export async function scrollTo(screen: Screen, target: Locator, maxSwipes = 3) {
  for (let swipes = 0; swipes < maxSwipes && !(await target.isVisible()); swipes++) {
    await screen.swipe({ direction: 'up' });
  }
}
