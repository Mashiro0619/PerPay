(() => {
  const modeKey = "perpay:theme";
  const paletteKey = "perpay:palette";
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const listeners = new Set();
  const backgrounds = { blue: ["#f6f8fc", "#12151c"], bamboo: ["#f4f8f5", "#111916"], sand: ["#faf7f1", "#1b1713"], violet: ["#f8f6fc", "#17141e"], graphite: ["#f5f6f7", "#151618"] };
  const validMode = value => ["light", "dark", "system"].includes(value);
  const validPalette = value => typeof value === "string" && Object.hasOwn(backgrounds, value);
  const read = key => { try { return window.localStorage.getItem(key); } catch { return null; } };
  const storedMode = read(modeKey); const storedPalette = read(paletteKey);
  let preference = validMode(storedMode) ? storedMode : "system";
  let palette = validPalette(storedPalette) ? storedPalette : "blue";
  let appearancePaint = 0;
  function apply() {
    const paint = ++appearancePaint;
    // Apply foregrounds and surfaces together, without a low-contrast cross-fade.
    document.documentElement.dataset.appearanceChanging = "true";
    const resolved = preference === "system" ? media.matches ? "dark" : "light" : preference;
    document.documentElement.dataset.theme = resolved;
    document.documentElement.dataset.palette = palette;
    document.documentElement.style.colorScheme = resolved;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", backgrounds[palette][resolved === "dark" ? 1 : 0]);
    for (const listener of listeners) listener();
    if (typeof window.requestAnimationFrame === "function") window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      if (paint === appearancePaint) delete document.documentElement.dataset.appearanceChanging;
    }));
    else delete document.documentElement.dataset.appearanceChanging;
  }
  function write(key, value) { try { window.localStorage.setItem(key, value); } catch {} }
  window.perpayTheme = Object.freeze({
    getPreference: () => preference,
    getPalette: () => palette,
    setPreference(value) { if (!validMode(value)) return; preference = value; write(modeKey, value); apply(); },
    setPalette(value) { if (!validPalette(value)) return; palette = value; write(paletteKey, value); apply(); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  });
  media.addEventListener("change", () => { if (preference === "system") apply(); });
  window.addEventListener("storage", event => {
    if (event.key === null) { preference = "system"; palette = "blue"; }
    else if (event.key === modeKey) preference = validMode(event.newValue) ? event.newValue : "system";
    else if (event.key === paletteKey) palette = validPalette(event.newValue) ? event.newValue : "blue";
    else return;
    apply();
  });
  apply();
})();
