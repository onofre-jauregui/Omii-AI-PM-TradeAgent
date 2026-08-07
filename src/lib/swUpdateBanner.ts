/**
 * Placement for the service-worker "New version available" banner.
 *
 * The banner is a fixed element pinned to the bottom of the viewport at
 * z-index 9999. On mobile the app also renders a fixed bottom nav (z-50, 56px),
 * so a naive bottom:1rem put the banner *inside* the nav strip and, sitting
 * above it in z-order, swallowed every tap on the middle tabs — navigation
 * silently died after each deploy until the user reloaded.
 *
 * Extracted from main.tsx so the offset is unit-testable: the failure mode is
 * invisible unless a service worker update happens to be pending, which is
 * exactly when nobody is looking.
 */

/** Gap between the banner and whatever sits below it. */
const BANNER_GAP = "1rem";

/**
 * Bottom offset for the banner, given the height of the fixed bottom nav in
 * CSS pixels. Pass 0 when no bottom nav is mounted (the desktop layout).
 */
export function bannerBottomOffset(navHeight: number): string {
  if (!Number.isFinite(navHeight) || navHeight <= 0) return BANNER_GAP;
  // env() is resolved by the browser: on notched devices the nav itself is
  // padded by the same inset, so the banner has to clear both.
  return `calc(${BANNER_GAP} + ${Math.ceil(navHeight)}px + env(safe-area-inset-bottom, 0px))`;
}
