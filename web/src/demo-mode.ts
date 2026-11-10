/** Bootstrap marker comes only from the dedicated read-only demo server. */
export function isReadOnlyDemo(): boolean {
  return document.documentElement.dataset.perpayDemo === "readonly";
}

/** Disposable preview databases invalidate links from an earlier preview run. */
export function previewInstanceChanged(response: Response | undefined): boolean {
  const instanceId = response?.headers.get("X-PerPay-Preview-Instance");
  if (!instanceId) return false;
  try {
    const previous = window.sessionStorage.getItem("perpay:preview-instance");
    window.sessionStorage.setItem("perpay:preview-instance", instanceId);
    return previous !== instanceId;
  } catch {
    // Without per-tab storage, preview sign-in starts from its stable entry point.
    return true;
  }
}
