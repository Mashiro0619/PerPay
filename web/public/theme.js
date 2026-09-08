(() => {
  const storageKey = "perpay:theme";
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const listeners = new Set();
  const valid = (value) => ["light", "dark", "system"].includes(value);
  let preference = "system";
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (valid(stored)) preference = stored;
  } catch {}

  function apply() {
    const resolved = preference === "system" ? (media.matches ? "dark" : "light") : preference;
    document.documentElement.dataset.theme = resolved;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", resolved === "dark" ? "#111214" : "#f7f8fa");
    for (const listener of listeners) listener();
  }

  window.perpayTheme = Object.freeze({
    getPreference: () => preference,
    setPreference(value) {
      if (!valid(value)) return;
      preference = value;
      try { window.localStorage.setItem(storageKey, value); } catch {}
      apply();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  media.addEventListener("change", () => { if (preference === "system") apply(); });
  window.addEventListener("storage", (event) => {
    if (event.key !== storageKey && event.key !== null) return;
    preference = valid(event.newValue) ? event.newValue : "system";
    apply();
  });
  apply();
})();
