import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearOnboardingDeferrals,
  onboardingPath,
  onboardingSteps,
} from "../src/lib/onboarding";
import {
  configuredThrough,
  mountOnboarding,
  syntheticSecret,
  systemStatus,
} from "./onboarding-fixture";

import { json } from "./fixtures";

beforeEach(() => clearOnboardingDeferrals());

describe("onboarding workspace and credential handoff", () => {
  it.each(onboardingSteps)(
    "keeps $id inside the shared-width workspace with one consistent navigation footer",
    async (step) => {
      const view = mountOnboarding({ stage: 4, path: onboardingPath(step.id) });
      const heading = await screen.findByRole("heading", {
        name: step.title,
        level: 2,
      });
      const workspace = view.container.querySelector(
        "[data-onboarding-workspace]",
      )! as HTMLElement;
      expect(workspace).toHaveClass("w-full", "min-w-0");
      expect(workspace).not.toHaveClass("mx-auto", "max-w-6xl");
      expect(workspace).toContainElement(heading);
      expect(
        within(workspace).queryByText(/第 \d 步，共 \d 步/),
      ).not.toBeInTheDocument();
      expect(
        within(workspace).queryByText(
          step.id === "application"
            ? "应用公钥已就绪。复制到支付宝的接口加签设置，已配置则直接下一步。"
            : step.description,
        ),
      ).not.toBeInTheDocument();
      expect(
        within(
          within(workspace).getByRole("navigation", { name: "配置步骤" }),
        ).getAllByRole("link"),
      ).toHaveLength(5);
      expect(
        within(
          within(workspace).getByRole("navigation", { name: "配置步骤" }),
        ).getByRole("link", { name: new RegExp(step.title) }),
      ).toHaveAttribute("aria-current", "step");
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
      expect(
        screen.queryByRole("link", { name: "稍后配置" }),
      ).not.toBeInTheDocument();
      if (step.id === "check") {
        expect(
          screen.queryByRole("link", { name: "切换到常规设置" }),
        ).not.toBeInTheDocument();
      } else {
        expect(footer).toContainElement(
          screen.getByRole("link", { name: "切换到常规设置" }),
        );
      }
      const refresh = screen.getAllByRole("button", { name: "刷新" });
      expect(refresh).toHaveLength(1);
      expect(refresh[0]!.closest("[data-page-header-actions]")).not.toBeNull();
      const tutorial = screen.getByRole("link", { name: "图文教程" });
      expect(tutorial.closest("[data-page-header-actions]")).not.toBeNull();
      expect(
        within(footer).queryByRole("button", { name: "刷新" }),
      ).not.toBeInTheDocument();
      expect(
        within(workspace).getByRole("link", { name: /通知与备份.*可选/ }),
      ).toBeVisible();
      if (["application", "provider", "collection"].includes(step.id)) {
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

  it("redirects old API setup links to credential management without reading secrets", async () => {
    const view = mountOnboarding({ stage: 4, path: onboardingPath("api") });
    expect(
      await screen.findByRole("button", { name: "查看PerPay API 密钥" }),
    ).toBeVisible();
    expect(view.router.state.location.pathname).toBe("/settings/security");
    expect(
      screen.getByRole("button", { name: "复制 API 客户端 ID" }),
    ).toBeVisible();
    expect(screen.queryByText(syntheticSecret)).not.toBeInTheDocument();
    expect(view.writes()).toHaveLength(0);
  });

  it("finishes instance configuration without generating an API credential", async () => {
    const view = mountOnboarding({ stage: 3 });
    expect(
      await screen.findByRole("link", { name: "进入控制台" }),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "获取接入凭证" })).toHaveAttribute(
      "href",
      "/settings/security",
    );
    expect(
      screen.queryByRole("button", { name: "生成 API 密钥" }),
    ).not.toBeInTheDocument();
    expect(view.saved.completion.complete).toBe(true);
    expect(view.saved.completion.api).toBe(false);
    expect(view.writes()).toHaveLength(0);
    await userEvent
      .setup()
      .click(screen.getByRole("link", { name: "获取接入凭证" }));
    expect(
      await screen.findByRole("button", { name: "生成 API 密钥" }),
    ).toBeVisible();
    expect(view.router.state.location.pathname).toBe("/settings/security");
    expect(screen.queryByText(syntheticSecret)).not.toBeInTheDocument();
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

it("refreshes both configuration and readiness through the only header action", async () => {
  let saved = configuredThrough(4);
  let defer = false;
  const pending: Array<(response: Response) => void> = [];
  const view = mountOnboarding({
    stage: 4,
    path: onboardingPath("check"),
    handle(request) {
      const path = new URL(request.url).pathname;
      if (path === "/api/admin/v1/settings") return json({ data: saved });
      if (path === "/api/admin/v1/system/status") {
        if (defer)
          return new Promise<Response>((resolve) => {
            pending.push(resolve);
          });
        return json({ data: systemStatus(saved) });
      }
      return undefined;
    },
  });
  await screen.findByText("收款服务就绪");
  const refresh = screen.getByRole("button", { name: "刷新" });
  await waitFor(() => expect(refresh).toBeEnabled());
  saved = { ...saved, revision: saved.revision + 1 };
  const before = view.fetchMock.mock.calls.length;
  defer = true;
  await userEvent.click(refresh);
  await waitFor(() => expect(refresh).toBeDisabled());
  expect(
    view.container.querySelector("[data-onboarding-workspace] [inert]"),
  ).not.toBeNull();
  defer = false;
  await act(async () => {
    for (const finish of pending) finish(json({ data: systemStatus(saved) }));
  });
  await screen.findByText("收款服务就绪");
  await waitFor(() => expect(refresh).toBeEnabled());
  expect(screen.getAllByRole("button", { name: "刷新" })).toHaveLength(1);
  expect(screen.queryByText("配置已变化")).not.toBeInTheDocument();
  const paths = view.fetchMock.mock.calls
    .slice(before)
    .map(([request]) => new URL(request.url).pathname);
  expect(paths).toContain("/api/admin/v1/settings");
  expect(
    paths.filter((path) => path === "/api/admin/v1/system/status").length,
  ).toBeGreaterThanOrEqual(2);
  expect(view.writes()).toHaveLength(0);
});
