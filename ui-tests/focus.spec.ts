import { test, expect, login, record } from "./fixtures";

for (const theme of ["light", "dark"] as const) test(`${theme}: keyboard focus is opaque and distinct from adjacent surfaces`, async ({ page, manifest }, info) => {
  await page.emulateMedia({ colorScheme: theme });
  await page.addInitScript(theme => localStorage.setItem("perpay:theme", theme), theme);
  await login(page, manifest);
  await page.keyboard.press("Tab");
  const trigger = page.getByRole("button", { name: "切换导航", exact: true });
  await trigger.focus();
  const focus = await trigger.evaluate(element => {
    const style = getComputedStyle(element);
    const root = getComputedStyle(document.documentElement);
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d")!;
    function luminance(value: string) {
      context.clearRect(0, 0, 1, 1); context.fillStyle = value; context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i]!, 0);
    }
    const ring = luminance(root.getPropertyValue("--ring"));
    const contrasts = ["--background", "--card", "--sidebar", "--sidebar-accent"].map(token => {
      const surface = luminance(root.getPropertyValue(token));
      return (Math.max(ring, surface) + .05) / (Math.min(ring, surface) + .05);
    });
    return { visible: element.matches(":focus-visible"), shadow: style.boxShadow, contrasts };
  });
  expect(focus.visible).toBe(true);
  expect(focus.shadow).not.toBe("none");
  expect(Math.min(...focus.contrasts)).toBeGreaterThanOrEqual(3);
  await record(page, info, { focus });
});
