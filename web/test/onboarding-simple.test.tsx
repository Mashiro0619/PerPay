import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { queryClient } from "../src/api/client";
import { onboardingPath } from "../src/lib/onboarding";
import { RotateKeyDialog } from "../src/pages/SecuritySettings";
import { json } from "./fixtures";
import {
  configuredThrough,
  mountOnboarding,
  syntheticSecret,
} from "./onboarding-fixture";

describe("minimal onboarding", () => {
  it.each([
    [1, "provider", "支付宝接入"],
    [2, "collection", "经营码"],
  ] as const)(
    "uses one content heading and no routine warning cards for %s",
    async (stage, step, title) => {
      const view = mountOnboarding({ stage, path: onboardingPath(step) });
      await screen.findByRole("heading", { name: title });
      expect(screen.getAllByRole("heading")).toHaveLength(2);
      expect(view.container.querySelector(".page-heading p")).toBeNull();
      expect(
        view.container.querySelector(".onboarding-content .notice"),
      ).toBeNull();
      expect(view.writes()).toHaveLength(0);
    },
  );

  it("keeps an existing sandbox selection in advanced settings and preserves it when saving", async () => {
    const settings = configuredThrough(4);
    settings.provider = { ...settings.provider!, environment: "SANDBOX" };
    const view = mountOnboarding({
      stage: 4,
      path: onboardingPath("provider"),
      handle: (request) =>
        request.url.endsWith("/settings")
          ? json({ data: settings })
          : undefined,
    });
    const environment = await screen.findByLabelText("支付宝环境");
    expect(environment).not.toBeVisible();
    expect(environment).toHaveValue("SANDBOX");
    expect(screen.getByText("高级设置 · 沙箱环境")).toBeVisible();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "保存并继续" }));
    await waitFor(() =>
      expect(view.router.state.location.pathname).toBe(
        onboardingPath("collection"),
      ),
    );
    expect(await view.writes()[0]!.clone().json()).toMatchObject({
      environment: "SANDBOX",
      timeout_milliseconds: 8000,
      scan_interval_seconds: 10,
      active_scan_interval_seconds: 10,
      safety_lag_seconds: 10,
      maximum_success_age_seconds: 60,
    });
  });

  it("opens advanced settings and focuses an invalid field returned by the server", async () => {
    const view = mountOnboarding({
      stage: 1,
      handle: (request) =>
        request.method === "PUT"
          ? json(
              {
                error: {
                  code: "settings_validation_failed",
                  message: "参数校验失败",
                  fields: { timeout_milliseconds: "请求超时设置不符合要求" },
                },
              },
              422,
            )
          : undefined,
    });
    const user = userEvent.setup();
    await user.type(
      await screen.findByLabelText("应用 ID（App ID）"),
      "app-id",
    );
    await user.type(screen.getByLabelText("支付宝公钥"), "synthetic-key");
    await user.click(screen.getByRole("button", { name: "保存并继续" }));
    expect(await screen.findByText("请求超时设置不符合要求")).toBeVisible();
    await waitFor(() =>
      expect(screen.getByLabelText("请求超时（毫秒）")).toHaveFocus(),
    );
    expect(screen.getByRole("button", { name: "高级设置" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByLabelText("应用 ID（App ID）")).toHaveValue("app-id");
    expect(view.router.state.location.pathname).toBe(
      onboardingPath("provider"),
    );
  });

  it("shows only the notification switch and a real backup summary until requested", async () => {
    const view = mountOnboarding({
      stage: 4,
      path: onboardingPath("optional"),
    });
    expect(
      await screen.findByRole("switch", { name: "启用业务通知" }),
    ).not.toBeChecked();
    expect(screen.getByLabelText("通知网站（HTTPS 域名）")).not.toBeVisible();
    expect(screen.getByLabelText("通知网站（HTTPS 域名）")).toBeDisabled();
    expect(screen.getByLabelText("最大尝试次数")).not.toBeVisible();
    expect(screen.getByLabelText("备份间隔（秒）")).not.toBeVisible();
    expect(screen.getByText("每天备份，保留 7 份。")).toBeVisible();
    expect(screen.getAllByRole("link", { name: "继续" })).toHaveLength(1);
    expect(
      screen.queryByRole("button", { name: "查看签名密钥" }),
    ).not.toBeInTheDocument();
    expect(
      view.container.querySelector(".onboarding-content .notice"),
    ).toBeNull();
    expect(view.writes()).toHaveLength(0);
  });

  it("does not mark a reverted notification toggle as dirty and preserves hidden input drafts", async () => {
    const view = mountOnboarding({
      stage: 4,
      path: onboardingPath("optional"),
    });
    const user = userEvent.setup();
    const enabled = await screen.findByRole("switch", { name: "启用业务通知" });
    await user.click(enabled);
    await user.click(enabled);
    expect(screen.queryByText("未保存")).not.toBeInTheDocument();
    await user.click(enabled);
    await user.type(
      screen.getByLabelText("通知网站（HTTPS 域名）"),
      "https://draft.example.com",
    );
    await user.click(enabled);
    await user.click(enabled);
    expect(screen.getByLabelText("通知网站（HTTPS 域名）")).toHaveValue(
      "https://draft.example.com",
    );
    expect(screen.getByText("未保存")).toBeVisible();
    expect(view.writes()).toHaveLength(0);
  });

  it("saves disabled notifications without submitting hidden invalid drafts or resetting retry defaults", async () => {
    const view = mountOnboarding({
      stage: 4,
      path: onboardingPath("optional"),
    });
    const user = userEvent.setup();
    const enabled = await screen.findByRole("switch", { name: "启用业务通知" });
    await user.click(enabled);
    await user.type(
      screen.getByLabelText("通知网站（HTTPS 域名）"),
      "invalid-origin",
    );
    await user.click(screen.getByText("高级设置"));
    fireEvent.change(screen.getByLabelText("最大尝试次数"), {
      target: { value: "0" },
    });
    await user.click(enabled);
    await user.click(screen.getByRole("button", { name: "保存通知" }));
    await waitFor(() => expect(view.writes()).toHaveLength(1));
    expect(await view.writes()[0]!.clone().json()).toMatchObject({
      enabled: false,
      timeout_milliseconds: 5000,
      maximum_attempts: 5,
      retry_base_seconds: 10,
      retry_maximum_seconds: 600,
    });
    await user.click(enabled);
    expect(screen.getByLabelText("通知网站（HTTPS 域名）")).toHaveValue(
      "invalid-origin",
    );
    expect(screen.getByLabelText("最大尝试次数")).toHaveValue(0);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("saves backup changes independently and retains the notification draft", async () => {
    const consoleError = vi.spyOn(console, "error");
    const view = mountOnboarding({
      stage: 4,
      path: onboardingPath("optional"),
    });
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("switch", { name: "启用业务通知" }),
    );
    const origin = screen.getByLabelText("通知网站（HTTPS 域名）");
    await user.type(origin, "https://draft.example.com");
    await user.click(screen.getByText("调整备份策略"));
    fireEvent.change(screen.getByLabelText("备份间隔（秒）"), {
      target: { value: "172800" },
    });
    await user.click(screen.getByRole("button", { name: "保存备份" }));
    expect(await screen.findByText("每 2 天备份，保留 7 份。")).toBeVisible();
    expect(screen.getByLabelText("通知网站（HTTPS 域名）")).toBe(origin);
    expect(origin).toHaveValue("https://draft.example.com");
    expect(screen.getByRole("switch", { name: "启用业务通知" })).toBeChecked();
    expect(screen.getAllByText("未保存")).toHaveLength(1);
    expect(view.writes()).toHaveLength(1);
    expect(new URL(view.writes()[0]!.url).pathname).toBe(
      "/api/admin/v1/settings/backup",
    );
    const backupRequest = await view.writes()[0]!.clone().json();
    expect(screen.getByLabelText("备份间隔（秒）")).toHaveValue(172800);

    await user.click(screen.getByRole("button", { name: "保存通知" }));
    expect(
      await screen.findByRole("button", { name: "查看签名密钥" }),
    ).toBeVisible();
    expect(view.writes()).toHaveLength(2);
    expect(await view.writes()[1]!.clone().json()).toMatchObject({
      revision: backupRequest.revision + 1,
      enabled: true,
      allowed_origin: "https://draft.example.com",
    });
    expect(screen.getByLabelText("通知网站（HTTPS 域名）")).toBe(origin);
    expect(origin).toHaveValue("https://draft.example.com");
    expect(screen.getByLabelText("备份间隔（秒）")).toHaveValue(172800);
    await waitFor(() =>
      expect(screen.queryByText("未保存")).not.toBeInTheDocument(),
    );
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("reveals nested advanced controls for native validation", async () => {
    mountOnboarding({ stage: 1 });
    const timeout = await screen.findByLabelText("请求超时（毫秒）");
    expect(timeout).not.toBeVisible();
    fireEvent.invalid(timeout);
    expect(timeout).toBeVisible();
  });

  it("reads a secret once only after the explicit view action", async () => {
    const settings = configuredThrough(4);
    settings.notifications.enabled = true;
    const view = mountOnboarding({
      stage: 4,
      path: onboardingPath("optional"),
      handle: (request) =>
        request.url.endsWith("/settings")
          ? json({ data: settings })
          : undefined,
    });
    const user = userEvent.setup();
    const viewKey = await screen.findByRole("button", { name: "查看签名密钥" });
    expect(view.writes()).toHaveLength(0);
    await user.click(viewKey);
    const dialog = await screen.findByRole("dialog", { name: "通知签名密钥" });
    expect(dialog).toHaveAccessibleDescription(
      "60 秒后或切换标签页时自动清除。",
    );
    expect(dialog.querySelector(".notice--warning")).toBeNull();
    expect(
      within(dialog).queryByText(/周围没有他人|屏幕共享|审计|剪贴板/),
    ).not.toBeInTheDocument();
    expect(
      within(dialog).queryByRole("button", { name: "读取明文" }),
    ).not.toBeInTheDocument();
    expect(await screen.findByText(syntheticSecret)).toBeVisible();
    expect(view.writes()).toHaveLength(1);
    await user.click(within(dialog).getByRole("button", { name: /^关闭$/ }));
    expect(screen.queryByText(syntheticSecret)).not.toBeInTheDocument();
  });

  it("keeps explicit confirmation when replacing a working API key", async () => {
    const fetchMock = vi.fn(async () =>
      json({
        data: { settings: configuredThrough(4), secret: syntheticSecret },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(
      <QueryClientProvider client={queryClient}>
        <RotateKeyDialog
          settings={configuredThrough(4)}
          onSaved={vi.fn()}
          onClose={vi.fn()}
        />
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    const confirm = screen.getByRole("button", { name: "确认轮换" });
    expect(confirm).toBeEnabled();
    expect(
      screen.getByText(/旧密钥立即失效。轮换后需更新业务服务端/),
    ).toBeVisible();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    await user.click(confirm);
    expect(await screen.findByText(syntheticSecret)).toBeVisible();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not automatically repeat first-time key generation after an uncertain response", async () => {
    const view = mountOnboarding({
      stage: 3,
      handle: (request) =>
        request.url.endsWith("/api-key/actions/rotate")
          ? Promise.reject(new TypeError("network interrupted"))
          : undefined,
    });
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "生成 API 密钥" }),
    );
    const dialog = screen.getByRole("dialog", { name: "生成 API 密钥" });
    expect(within(dialog).queryByRole("checkbox")).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "生成密钥" }));
    await screen.findByRole("alert");
    await act(async () => {});
    expect(view.writes()).toHaveLength(1);
    expect(view.router.state.location.pathname).toBe(onboardingPath("api"));
    expect(
      screen.getByText(/结果未确认，请关闭后刷新配置并查看当前密钥/),
    ).toBeVisible();
    const repeat = within(dialog).getByRole("button", { name: "生成密钥" });
    expect(repeat).toBeDisabled();
    await user.click(repeat);
    expect(view.writes()).toHaveLength(1);
  });
});
