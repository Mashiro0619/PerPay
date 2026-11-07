import { test, expect } from "@playwright/test";
import { expectOverlayFits } from "./overlay-fixtures";

test("overlay geometry allows a native textarea but still rejects a second layout scroll region", async ({ page }) => {
  await page.clock.install();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.setContent(`<style>body{margin:0}textarea{display:block;width:90%;height:40px}</style>
    <div data-overlay-content style="height:100vh;width:100vw;display:flex;flex-direction:column">
      <div data-overlay-detail style="overflow-y:auto;flex:1;min-height:0">
        <textarea aria-label="配置示例" readonly>${"long configuration line\n".repeat(30)}</textarea>
        <div id="extra"><div style="height:1000px">正文</div></div>
      </div>
      <footer data-overlay-footer><button>关闭</button></footer>
    </div>`);
  const geometry = await expectOverlayFits(page);
  expect(geometry.scrolling).toEqual([{ tag: "DIV", detail: true, step: false }]);
  const textarea = page.getByRole("textbox", { name: "配置示例" });
  await textarea.focus();
  await page.keyboard.press("Control+End");
  await page.clock.runFor(100);
  await expect.poll(() => textarea.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await page.locator("#extra").evaluate(element => { element.style.height = "150px"; element.style.overflowY = "auto"; element.style.marginTop = "1000px"; });
  await expect(expectOverlayFits(page)).rejects.toThrow();
});
