import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { queryClient } from "../src/api/client";
import {
  clearOnboardingDeferrals,
  onboardingPath,
  onboardingSteps,
} from "../src/lib/onboarding";
import { mountOnboarding, syntheticSecret } from "./onboarding-fixture";

beforeEach(() => clearOnboardingDeferrals());

describe("onboarding workspace and credential handoff", () => {
  it.each(onboardingSteps)(
    "keeps $id inside the centered workspace with one consistent navigation footer",
    async (step) => {
      const view = mountOnboarding({ stage: 4, path: onboardingPath(step.id) });
      const heading = await screen.findByRole("heading", {
        name: step.title,
        level: 2,
      });
      const workspace = view.container.querySelector(
        "[data-onboarding-workspace]",
      )! as HTMLElement;
      expect(workspace).toHaveClass("mx-auto", "w-full", "max-w-6xl");
      expect(workspace).toContainElement(heading);
      expect(
        within(workspace).getByText(
          step.id === "application"
            ? "应用公钥已就绪。复制到支付宝的接口加签设置，已配置则直接下一步。"
            : step.description,
        ),
      ).toBeVisible();
      expect(within(workspace).getAllByRole("tab")).toHaveLength(6);
      expect(
        within(workspace).getByRole("tab", { name: new RegExp(step.title) }),
      ).toHaveAttribute("aria-selected", "true");
      const footer = workspace.querySelector(
        "[data-onboarding-actions]",
      )! as HTMLElement;
      expect(
        workspace.querySelectorAll("[data-onboarding-actions]"),
      ).toHaveLength(1);
      const primary = footer.querySelector(
        "[data-onboarding-primary-actions]",
      )! as HTMLElement;
      const previous = screen.queryByRole("link", { name: "上一步" });
      if (step.id === "application") expect(previous).not.toBeInTheDocument();
      else expect(primary).toContainElement(previous);
      const next =
        step.id === "optional"
          ? within(primary).getByRole("link", { name: "继续" })
          : step.id === "check"
            ? await within(primary).findByRole("link", { name: "进入控制台" })
            : within(primary).getByRole("button", {
                name: ["provider", "collection"].includes(step.id)
                  ? "保存并继续"
                  : "下一步",
              });
      expect(next.closest("[data-onboarding-next]")).not.toBeNull();
      expect(footer).toContainElement(
        screen.getByRole("link", { name: "稍后配置" }),
      );
      if (["application", "provider", "collection", "api"].includes(step.id)) {
        expect(
          workspace.querySelector("[data-onboarding-main]"),
        ).toBeInTheDocument();
        expect(
          within(workspace).getByRole("complementary", { name: "本步说明" }),
        ).toBeVisible();
      }
      expect(view.writes()).toHaveLength(0);
    },
  );

  it.each([
    ["provider", "应用 ID（App ID）"],
    ["collection", "支付宝经营码内容"],
  ] as const)(
    "keeps %s submission connected to its form and navigation outside its disabled fieldset",
    async (step, label) => {
      const view = mountOnboarding({ stage: 4, path: onboardingPath(step) });
      const input = (await screen.findByLabelText(label)) as HTMLInputElement;
      const submit = screen.getByRole("button", {
        name: "保存并继续",
      }) as HTMLButtonElement;
      expect(submit.form).toBe(input.form);
      expect(submit.closest('[data-slot="card"]')).toBeNull();
      expect(
        screen.getByRole("link", { name: "上一步" }).closest("fieldset"),
      ).toBeNull();
      expect(view.writes()).toHaveLength(0);
    },
  );

  it("explains who issues and consumes credentials, without reading a secret on entry", async () => {
    const view = mountOnboarding({ stage: 4, path: onboardingPath("api") });
    expect(
      await screen.findByRole("heading", { name: "PerPay API 接入凭证" }),
    ).toBeVisible();
    expect(screen.getByText("PerPay（当前页面）")).toBeVisible();
    expect(screen.getByText("业务系统后端（接入方）")).toBeVisible();
    expect(screen.getByText(/这里不填写业务系统自己的密钥/)).toBeVisible();
    expect(
      screen.getByRole("button", { name: "复制 API 客户端 ID" }),
    ).toBeVisible();
    expect(
      screen.getByRole("link", { name: "业务系统接入文档" }),
    ).toHaveAttribute(
      "href",
      "https://github.com/Mashiro0619/PerPay/blob/main/USAGE.md",
    );
    expect(screen.queryByText("网站 API 密钥")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByText(syntheticSecret)).not.toBeInTheDocument();
    expect(view.writes()).toHaveLength(0);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "查看密钥" }));
    const dialog = await screen.findByRole("dialog", {
      name: "PerPay API 密钥",
    });
    expect(await within(dialog).findByText(syntheticSecret)).toBeVisible();
    expect(
      within(dialog).getByText(/复制到业务系统后端的 PerPay 接入配置/),
    ).toBeVisible();
    expect(view.writes()).toHaveLength(1);
    expect(new URL(view.writes()[0]!.url).pathname).toBe(
      "/api/admin/v1/settings/secrets/api_secret/actions/reveal",
    );
    expect(
      JSON.stringify(queryClient.getQueryData(["settings"])),
    ).not.toContain(syntheticSecret);
    expect(JSON.stringify(localStorage)).not.toContain(syntheticSecret);
    expect(JSON.stringify(sessionStorage)).not.toContain(syntheticSecret);
    await user.click(within(dialog).getByRole("button", { name: "关闭" }));
    await waitFor(() =>
      expect(screen.queryByText(syntheticSecret)).not.toBeInTheDocument(),
    );
  });

  it("keeps the generation prerequisite rather than treating client setup as an unneeded step", async () => {
    const view = mountOnboarding({ stage: 3 });
    expect(
      await screen.findByRole("heading", { name: "业务系统接入", level: 2 }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "下一步" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "生成 API 密钥" })).toBeEnabled();
    expect(screen.getByRole("tab", { name: /收款检查/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(
      screen.queryByRole("button", { name: "查看密钥" }),
    ).not.toBeInTheDocument();
    expect(view.writes()).toHaveLength(0);
  });

  it("keeps dirty form confirmation when using the unified previous-step control", async () => {
    const view = mountOnboarding({
      stage: 4,
      path: onboardingPath("collection"),
    });
    const input = await screen.findByLabelText("支付宝经营码内容");
    fireEvent.change(input, {
      target: { value: "https://qr.alipay.com/unsaved-centered-layout" },
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("link", { name: "上一步" }));
    await user.click(await screen.findByRole("button", { name: "继续编辑" }));
    expect(input).toHaveValue("https://qr.alipay.com/unsaved-centered-layout");
    expect(view.router.state.location.pathname).toBe(
      onboardingPath("collection"),
    );
    expect(view.writes()).toHaveLength(0);
  });
});
