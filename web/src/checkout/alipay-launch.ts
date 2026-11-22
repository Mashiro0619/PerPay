/** Helpers for mobile one-click Alipay launch on the public checkout page. */

export function isAlipaySchemeBlockedBrowser(userAgent: string): boolean {
  return /MicroMessenger/i.test(userAgent) || /\bQQ\//i.test(userAgent);
}

export async function copyCheckoutAmount(amountText: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(amountText);
    return true;
  } catch {
    return false;
  }
}

export function navigateToAlipayScheme(url: string): void {
  window.location.assign(url);
}
