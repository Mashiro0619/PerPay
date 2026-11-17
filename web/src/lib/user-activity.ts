/**
 * Tracks whether the administrator has used this page recently. The API client
 * marks reads made without recent input, so status polling on a page left open
 * does not keep extending the session's idle expiry.
 */
const ATTENDED_WINDOW_MS = 60_000;

// Loading the page is itself something the administrator did.
let lastInputAt = Date.now();

function recordInput() {
  lastInputAt = Date.now();
}

for (const type of ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"]) {
  window.addEventListener(type, recordInput, { capture: true, passive: true });
}

export function userIsAttending(): boolean {
  return Date.now() - lastInputAt < ATTENDED_WINDOW_MS;
}
