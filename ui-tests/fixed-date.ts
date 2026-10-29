import { expect, type Page } from "@playwright/test";

/** Keep fixture business dates stable without replacing browser timing APIs. */
export async function setDateOnly(page: Page, epoch: number) {
  function install(epoch: number) {
    const NativeDate = Date;
    globalThis.Date = new Proxy(NativeDate, {
      construct(target, args, newTarget) { return Reflect.construct(target, args.length ? args : [epoch], newTarget); },
      apply() { return new NativeDate(epoch).toString(); },
      get(target, property, receiver) { return property === "now" ? () => epoch : Reflect.get(target, property, receiver); },
    });
  }
  // Playwright clock.setFixedTime also installs its performance/rAF wrappers.
  // This shim deliberately changes only Date, including the callable Date().
  await page.addInitScript(install, epoch);
  await page.evaluate(install, epoch);
  expect(await page.evaluate(() => ({
    raf: requestAnimationFrame.toString().includes("[native code]"),
    performance: performance.now.toString().includes("[native code]"),
    eventTimeStamp: Object.getOwnPropertyDescriptor(Event.prototype, "timeStamp")?.get?.toString().includes("[native code]"),
    now: Date.now(),
    constructed: new Date().getTime(),
    explicitDate: new Date(0).getTime(),
  }))).toEqual({ raf: true, performance: true, eventTimeStamp: true, now: epoch, constructed: epoch, explicitDate: 0 });
}
