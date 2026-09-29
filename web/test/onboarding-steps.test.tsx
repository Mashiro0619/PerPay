import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { OnboardingSteps } from "../src/components/onboarding-steps";
import { onboardingPath, onboardingSteps } from "../src/lib/onboarding";
import { mountOnboarding } from "./onboarding-fixture";

describe("ordered onboarding navigation", () => {
  it("keeps all five numbers, connectors, completion and the current step distinct", () => {
    render(
      <MemoryRouter>
        <OnboardingSteps
          current="provider"
          completed={[true, true, true, true]}
          firstMissing={5}
        />
      </MemoryRouter>,
    );
    const nav = screen.getByRole("navigation", { name: "配置步骤" });
    const list = within(nav).getByRole("list");
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(5);
    expect(list.tagName).toBe("OL");
    expect(nav.querySelectorAll("[data-step-connector]")).toHaveLength(4);
    items.forEach((item, index) => {
      expect(item).toHaveClass("justify-center", "items-start");
      const link = within(item).getByRole("link");
      expect(link).toHaveClass("w-fit", "max-w-full", "min-w-11", "min-h-11");
      expect(link).not.toHaveClass("w-full");
      expect(item.querySelector("[data-step-number]")).toHaveTextContent(
        String(index + 1),
      );
      expect(within(item).getByRole("link")).toHaveAttribute(
        "href",
        onboardingPath(onboardingSteps[index]!.id),
      );
    });
    expect(
      within(nav).getByRole("link", {
        name: /第 2 步.*支付宝接入.*已配置.*当前步骤/,
      }),
    ).toHaveAttribute("aria-current", "step");
    expect(nav.querySelectorAll('[aria-current="step"]')).toHaveLength(1);
    expect(
      within(nav).getByRole("link", { name: /第 4 步.*通知与备份.*可选/ }),
    ).toBeVisible();
    expect(
      within(nav).getByRole("link", { name: /第 5 步.*收款检查.*待检查/ }),
    ).not.toHaveAttribute("aria-disabled");
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(nav).not.toHaveTextContent(/已配置|待配置|待检查|当前步骤/);
    expect(nav).toHaveTextContent("可选");
  });

  it("keeps existing prerequisites and moves focus without activating a step", async () => {
    render(
      <MemoryRouter>
        <OnboardingSteps
          current="provider"
          completed={[true]}
          firstMissing={1}
        />
      </MemoryRouter>,
    );
    const nav = screen.getByRole("navigation", { name: "配置步骤" });
    const first = within(nav).getByRole("link", { name: /应用公钥/ });
    const current = within(nav).getByRole("link", { name: /支付宝接入/ });
    const disabled = within(nav).getByRole("link", { name: /经营码/ });
    expect(disabled).toHaveAttribute("aria-disabled", "true");
    expect(disabled).not.toHaveAttribute("href");
    const user = userEvent.setup();
    act(() => first.focus());
    await user.keyboard("{Alt>}{ArrowRight}{/Alt}");
    expect(first).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(current).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(first).toHaveFocus();
    await user.keyboard("{End}");
    expect(current).toHaveFocus();
    await user.keyboard("{Home}");
    expect(first).toHaveFocus();
    await user.tab();
    expect(current).toHaveFocus();
    expect(current).toHaveAttribute("aria-current", "step");
  });

  it("preserves unsaved edits when cancelling a keyboard step change", async () => {
    const view = mountOnboarding({
      stage: 4,
      path: onboardingPath("collection"),
    });
    const input = await screen.findByLabelText("支付宝经营码内容");
    fireEvent.change(input, {
      target: { value: "https://qr.alipay.com/unsaved-stepper" },
    });
    const nav = screen.getByRole("navigation", { name: "配置步骤" });
    const current = within(nav).getByRole("link", { name: /经营码/ });
    const next = within(nav).getByRole("link", { name: /通知与备份/ });
    const user = userEvent.setup();
    act(() => current.focus());
    await user.keyboard("{ArrowRight}");
    expect(next).toHaveFocus();
    expect(view.router.state.location.pathname).toBe(
      onboardingPath("collection"),
    );
    await user.keyboard("{Enter}");
    await user.click(await screen.findByRole("button", { name: "继续编辑" }));
    expect(input).toHaveValue("https://qr.alipay.com/unsaved-stepper");
    expect(view.router.state.location.pathname).toBe(
      onboardingPath("collection"),
    );
    expect(next).toHaveFocus();
    expect(view.writes()).toHaveLength(0);
    await user.keyboard("{Enter}");
    await user.click(
      await screen.findByRole("button", { name: "放弃修改并继续" }),
    );
    expect(
      await screen.findByRole("heading", { name: "通知与备份", level: 2 }),
    ).toHaveFocus();
    expect(view.router.state.location.pathname).toBe(onboardingPath("optional"));
    expect(view.writes()).toHaveLength(0);
  });
});
