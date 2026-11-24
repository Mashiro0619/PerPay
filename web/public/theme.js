(() => {
  const key = "perpay:theme";
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const listeners = new Set();
  const valid = (value) => value === "light" || value === "dark" || value === "system";
  let stored = null;
  try { stored = window.localStorage.getItem(key); } catch {}
  let preference = stored === "light" || stored === "dark" ? stored : "system";
  function apply() {
    const systemTheme = media.matches ? "dark" : "light";
    const resolved = preference === "system" ? systemTheme : preference;
    const scheme = preference === "system" ? "light dark" : preference;
    document.documentElement.classList.toggle("dark", resolved === "dark");
    document.documentElement.dataset.theme = resolved;
    document.documentElement.style.colorScheme = scheme;
    document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", scheme);
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", resolved === "dark" ? "#0a0a0a" : "#ffffff");
    for (const listener of listeners) listener();
  }
  window.perpayTheme = Object.freeze({
    getPreference: () => preference,
    getSystemTheme: () => (media.matches ? "dark" : "light"),
    setPreference(value) {
      if (!valid(value)) return;
      preference = value;
      try {
        if (value === "system") window.localStorage.removeItem(key);
        else window.localStorage.setItem(key, value);
      } catch {}
      apply();
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  });
  media.addEventListener("change", () => { apply(); });
  window.addEventListener("storage", (event) => {
    if (event.key === key || event.key === null) {
      preference = event.newValue === "light" || event.newValue === "dark" ? event.newValue : "system";
      apply();
    }
  });
  apply();
})();
