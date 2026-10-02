/** Bootstrap marker comes only from the dedicated read-only demo server. */
export function isReadOnlyDemo(): boolean {
  return document.documentElement.dataset.perpayDemo === "readonly";
}
