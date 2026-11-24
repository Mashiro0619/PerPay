/** Helpers for mobile one-click Alipay launch on the public checkout page. */

export function isAlipaySchemeBlockedBrowser(userAgent: string): boolean {
  return /MicroMessenger/i.test(userAgent) || /\bQQ\//i.test(userAgent);
}

/** Synchronous best-effort copy fallback used when Clipboard API is unavailable or raced by app switch. */
function copyWithExecCommand(amountText: string): boolean {
  if (typeof document === "undefined" || typeof document.execCommand !== "function") return false;
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const input = document.createElement("textarea");
  input.value = amountText;
  input.setAttribute("readonly", "");
  input.className = "sr-only";
  document.body.appendChild(input);
  try {
    input.select();
    input.setSelectionRange(0, amountText.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    input.remove();
    previousFocus?.focus({ preventScroll: true });
  }
}

export async function copyCheckoutAmount(amountText: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(amountText);
      return true;
    }
  } catch {
    // Fall back to execCommand when async Clipboard API rejects (e.g. lost focus during app switch).
  }
  return copyWithExecCommand(amountText);
}

export function navigateToAlipayScheme(url: string): void {
  window.location.assign(url);
}
