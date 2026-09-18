(() => {
  const key = "perpay:theme";
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const listeners = new Set();
  const valid = value => ["light", "dark", "system"].includes(value);
  let stored; try { stored = window.localStorage.getItem(key); } catch {}
  let preference = valid(stored) ? stored : "system";
  function apply() {
    const resolved = preference === "system" ? media.matches ? "dark" : "light" : preference;
    document.documentElement.classList.toggle("dark", resolved === "dark");
    document.documentElement.dataset.theme = resolved;
    document.documentElement.style.colorScheme = resolved;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", resolved === "dark" ? "#0a0a0a" : "#ffffff");
    for (const listener of listeners) listener();
  }
  window.perpayTheme = Object.freeze({
    getPreference: () => preference,
    setPreference(value) { if (!valid(value)) return; preference = value; try { window.localStorage.setItem(key, value); } catch {} apply(); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  });
  media.addEventListener("change", () => { if (preference === "system") apply(); });
  window.addEventListener("storage", event => { if (event.key === key || event.key === null) { preference = valid(event.newValue) ? event.newValue : "system"; apply(); } });
  apply();
})();
