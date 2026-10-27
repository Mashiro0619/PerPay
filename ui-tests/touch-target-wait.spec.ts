import { test, expect, type Locator, type Page } from "@playwright/test";
import { expectTouchTarget } from "./touch-targets";

const epoch = new Date("2026-10-15T00:00:00Z");

test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: epoch });
  await page.clock.setFixedTime(epoch);
  await page.clock.pauseAt(new Date(epoch.getTime() + 1_000));
  await page.setViewportSize({ width: 320, height: 200 });
  await page.setContent(`<style>
    body { margin: 0; }
    #panel { position: fixed; left: 16px; top: 16px; }
    button { display: block; width: 80px; height: 40px; padding: 0; border: 0; }
  </style><div id="panel"><button>Target</button></div>`);
});

test("waits for a finite ancestor animation started when the first animation finishes", async ({ page }) => {
  const panel = page.locator("#panel");
  await panel.evaluate(element => {
    const first = element.animate([{ opacity: .98 }, { opacity: 1 }], { duration: 10_000 });
    first.finished.then(() => {
      element.animate([{ transform: "translateX(-64px)" }, { transform: "translateX(0)" }], { duration: 10_000, fill: "forwards" });
      element.setAttribute("data-stage", "second");
    });
  });
  const waiting = observe(page.getByRole("button", { name: "Target" }));
  await flushProtocolTasks(page);
  await panel.evaluate(element => element.getAnimations()[0]!.finish());
  await expect(panel).toHaveAttribute("data-stage", "second");
  await flushProtocolTasks(page);
  assertStillWaiting(waiting);
  await page.clock.runFor(32);
  await panel.evaluate(element => element.getAnimations().forEach(animation => animation.finish()));
  const geometry = await settleFrames(page, waiting);
  expect(geometry.x).toBe(16);
  expect(geometry.fits).toBe(true);
});

test("waits for an ancestor entrance animation scheduled after two animation frames", async ({ page }) => {
  const panel = page.locator("#panel");
  await panel.evaluate(element => {
    (element as HTMLElement).style.transform = "translateX(-64px)";
    requestAnimationFrame(() => requestAnimationFrame(() => {
      element.animate([{ transform: "translateX(-64px)" }, { transform: "translateX(0)" }], { duration: 10_000, fill: "forwards" });
      element.setAttribute("data-stage", "started");
    }));
  });
  const waiting = observe(page.getByRole("button", { name: "Target" }));
  await flushProtocolTasks(page);
  assertStillWaiting(waiting);
  await page.clock.runFor(32);
  await expect(panel).toHaveAttribute("data-stage", "started");
  assertStillWaiting(waiting);
  await panel.evaluate(element => element.getAnimations().forEach(animation => animation.finish()));
  const geometry = await settleFrames(page, waiting);
  expect(geometry.x).toBe(16);
  expect(geometry.hits).toBe(true);
});

test("does not wait for an infinite ancestor animation without geometry changes", async ({ page }) => {
  const panel = page.locator("#panel");
  await panel.evaluate(element => element.animate([{ opacity: .9 }, { opacity: 1 }], { duration: 1_000, iterations: Infinity }));
  const geometry = await settleFrames(page, observe(page.getByRole("button", { name: "Target" })));
  expect(geometry.fits).toBe(true);
  expect(await panel.evaluate(element => element.getAnimations()[0]!.playState)).toBe("running");
});

for (const attribute of ["data-starting-style", "data-ending-style"]) {
  test(`waits while an ancestor retains ${attribute} across otherwise stable frames`, async ({ page }) => {
    const panel = page.locator("#panel");
    await panel.evaluate((element, attribute) => {
      (element as HTMLElement).style.transform = "translateX(-64px)";
      element.setAttribute(attribute, "");
      let frames = 0;
      const frame = () => {
        if (++frames < 4) { requestAnimationFrame(frame); return; }
        element.removeAttribute(attribute);
        element.animate([{ transform: "translateX(-64px)" }, { transform: "translateX(0)" }], { duration: 10_000, fill: "forwards" });
        element.setAttribute("data-stage", "started");
      };
      requestAnimationFrame(frame);
    }, attribute);
    const waiting = observe(page.getByRole("button", { name: "Target" }));
    await flushProtocolTasks(page);
    await page.clock.runFor(48);
    await flushProtocolTasks(page);
    assertStillWaiting(waiting);
    await page.clock.runFor(32);
    await expect(panel).toHaveAttribute("data-stage", "started");
    await panel.evaluate(element => element.getAnimations().forEach(animation => animation.finish()));
    expect((await settleFrames(page, waiting)).x).toBe(16);
  });
}

test("continues to reject a permanently clipped touch target", async ({ page }) => {
  await page.locator("#panel").evaluate(element => { (element as HTMLElement).style.transform = "translateX(-64px)"; });
  await expect(settleFrames(page, observe(page.getByRole("button", { name: "Target" })))).rejects.toThrow(/entire touch target is inside the visible browser area/);
});

function observe(target: Locator) {
  const state: { settled: boolean; geometry?: Awaited<ReturnType<typeof expectTouchTarget>>; error?: unknown } = { settled: false };
  void expectTouchTarget(target).then(
    geometry => { state.geometry = geometry; state.settled = true; },
    error => { state.error = error; state.settled = true; },
  );
  return state;
}

async function flushProtocolTasks(page: Page) {
  // Drain the helper's visibility/evaluation protocol calls while virtual RAF stays paused.
  for (let call = 0; call < 6; call++) await page.evaluate(() => undefined);
}

function assertStillWaiting(state: ReturnType<typeof observe>) {
  if (state.error) throw state.error;
  expect(state.settled, "measurement must wait for the pending entrance animation").toBe(false);
}

async function settleFrames(page: Page, state: ReturnType<typeof observe>) {
  for (let frame = 0; frame < 12 && !state.settled; frame++) {
    await page.clock.runFor(16);
    await flushProtocolTasks(page);
  }
  expect(state.settled, "the helper must settle without waiting for infinite animations").toBe(true);
  if (state.error) throw state.error;
  return state.geometry!;
}
