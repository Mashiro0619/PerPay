import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { json } from "./fixtures";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { queryClient } from "../src/api/client";
import { SettingsEditor } from "../src/components/SettingsForms";
import { configuredThrough } from "./onboarding-fixture";

const sections = [
  {
    section: "provider",
    fields: ["应用 ID（App ID）", "支付宝公钥"],
  },
  { section: "collection-policy", fields: ["请求超时（秒）", "常规查账间隔（秒）", "活跃查账间隔（秒）", "查账最小间隔（秒）", "查账延迟（秒）", "查账有效时限（秒）"] },
  { section: "collection", fields: ["支付宝收款码内容"] },
  {
    section: "notifications",
    fields: [
      "通知地址前缀",
      "通知超时（秒）",
      "最多发送次数",
      "首次重试间隔（秒）",
      "最大重试间隔（秒）",
    ],
  },
  {
    section: "advanced",
    fields: ["收银台链接密钥轮换周期（天）", "结束后可查询时长（秒）"],
  },
  {
    section: "backup",
    fields: ["备份间隔", "保留备份数量"],
  },
] as const;

describe.each([false, true])("directly visible settings (guided: %s)", (guided) => {
  it.each(sections)("shows $section parameters without a disclosure or implicit save", ({ section, fields }) => {
    const settings = configuredThrough(4);
    settings.notifications = {
      ...settings.notifications!,
      enabled: true,
      allowed_origin: "https://shop.example.com",
    };
    const fetchMock = vi.fn();
    const onSaved = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <SettingsEditor
            section={section}
            settings={settings}
            guided={guided}
            onSaved={onSaved}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    for (const label of fields) {
      const control = screen.getByLabelText(label);
      expect(control).toBeVisible();
      expect(control).toBeEnabled();
      expect(control.closest("form")).not.toBeNull();
      expect(control.closest('[data-slot="collapsible-content"]')).toBeNull();
    }
    expect(screen.queryByRole("button", { name: /高级设置|调整备份策略/ })).not.toBeInTheDocument();
    expect(container.querySelector("[data-settings-advanced], [data-settings-backup]")).toBeNull();
    expect(container.querySelectorAll("form")).toHaveLength(1);
    if (!guided && ["notifications", "backup", "advanced"].includes(section)) {
      const title = section === "notifications" ? "通知" : section === "backup" ? "自动备份" : "高级设置";
      expect(screen.getByRole("heading", { name: title })).toBeVisible();
      const group = screen.getByRole("group", { name: title });
      expect(within(group).getByText(title)).toHaveClass("sr-only");
    }
    if (!guided && section === "provider") {
      expect(screen.getAllByText("支付宝账号", { exact: true })).toHaveLength(1);
      expect(screen.getByRole("group", { name: "开放平台应用" })).toBeVisible();
      expect(screen.queryByLabelText("常规查账间隔（秒）")).not.toBeInTheDocument();
    }
    if (section === "provider") {
      expect(screen.queryByLabelText("支付宝环境")).not.toBeInTheDocument();
      expect(container.querySelector('[name="environment"]')).toBeNull();
    }
    if (guided) expect(screen.getByRole("button", { name: "保存" })).toBeEnabled();
    else expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });
});

describe("provider credentials without environment selection", () => {
  function mount(settings = configuredThrough(4)) {
    const onSaved = vi.fn();
    const content = (value: typeof settings) => (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <SettingsEditor section="provider" settings={value} onSaved={onSaved} />
        </MemoryRouter>
      </QueryClientProvider>
    );
    const view = render(content(settings));
    return { ...view, settings, onSaved, update: (value: typeof settings) => view.rerender(content(value)) };
  }

  it("tracks reverted credential drafts and saves only the official environment", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const settings = configuredThrough(4);
    settings.provider = { ...settings.provider!, environment: "PRODUCTION" };
    const { container, onSaved } = mount(settings);
    const saved = { ...settings, revision: settings.revision + 1, provider: { ...settings.provider, app_id: "updated-app-id" } };
    fetchMock.mockResolvedValue(json({ data: saved }));
    const user = userEvent.setup();
    const appId = screen.getByRole("textbox", { name: "应用 ID（App ID）" });
    const save = screen.getByRole("button", { name: "保存" });
    const form = container.querySelector("form")!;
    expect(screen.queryByLabelText("支付宝环境")).not.toBeInTheDocument();
    expect(new FormData(form).has("environment")).toBe(false);
    expect(save).toBeDisabled();
    await user.clear(appId);
    await user.type(appId, "updated-app-id");
    expect(save).toBeEnabled();
    expect(screen.getByText("未保存")).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();
    await user.clear(appId);
    await user.type(appId, settings.provider.app_id);
    expect(save).toBeDisabled();
    await user.clear(appId);
    await user.type(appId, "updated-app-id");
    await user.click(save);
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(saved));
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    const request = new Request(url, init);
    expect(await request.json()).toEqual({
      revision: settings.revision,
      environment: "PRODUCTION",
      app_id: "updated-app-id",
      platform_public_key: settings.provider.platform_public_key,
    });
    expect(save).toBeDisabled();
  });

  it.each([false, true])("keeps a legacy provider read-only if either the original or refreshed settings contain it (original: %s)", async (originalLegacy) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const settings = configuredThrough(4);
    settings.provider!.environment = originalLegacy ? "SANDBOX" : "PRODUCTION";
    const { update, onSaved } = mount(settings);
    if (!originalLegacy) {
      await userEvent.setup().type(screen.getByLabelText("应用 ID（App ID）"), "-draft");
    }
    const refreshed = structuredClone(settings);
    refreshed.revision++;
    refreshed.provider!.environment = originalLegacy ? "PRODUCTION" : "SANDBOX";
    update(refreshed);
    expect(screen.getByText("旧沙箱接入已停用")).toBeVisible();
    expect(screen.getByText("原 App ID：" + settings.provider!.app_id)).toBeVisible();
    expect(screen.getByRole("link", { name: "添加正式支付宝账号" })).toHaveAttribute("href", "/settings/accounts/new");
    expect(screen.queryByRole("button", { name: "保存" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("应用 ID（App ID）")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("does not replace an active legacy source when the provider credentials cannot be read", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const settings = configuredThrough(1);
    settings.provider_generations = [{ provider_account_key: "legacy", app_id: "legacy-app", environment: "SANDBOX", active: true, activated_at: "2026-09-01T00:00:00Z" }];
    mount(settings);
    expect(screen.getByText("旧沙箱接入已停用")).toBeVisible();
    expect(screen.getByText("原 App ID：legacy-app")).toBeVisible();
    expect(screen.queryByRole("button", { name: "保存" })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("focuses a visible public-key validation error and clears it after editing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({
      error: { code: "settings_validation_failed", message: "参数校验失败",
        fields: { platform_public_key: "支付宝公钥不符合要求" } },
    }, 422)));
    mount();
    const user = userEvent.setup();
    const publicKey = screen.getByRole("textbox", { name: "支付宝公钥" });
    await user.clear(publicKey);
    await user.type(publicKey, "invalid-public-key");
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByText("支付宝公钥不符合要求")).toBeVisible();
    await waitFor(() => expect(publicKey).toHaveFocus());
    expect(publicKey).toHaveAttribute("aria-invalid", "true");
    expect(publicKey).toHaveAccessibleDescription("支付宝公钥不符合要求 从支付宝应用的接口加签设置复制。");
    await user.clear(publicKey);
    await user.type(publicKey, "corrected-public-key");
    expect(screen.queryByText("支付宝公钥不符合要求")).not.toBeInTheDocument();
    expect(publicKey).toHaveAttribute("aria-invalid", "false");
  });
});


describe("exact duration drafts", () => {
  it("round-trips existing millisecond values and recommends without saving", async () => {
    const settings = configuredThrough(4);
    settings.collection_policy!.timeout_milliseconds = 8123;
    settings.collection_policy!.scan_interval_seconds = 61;
    settings.collection_policy!.maximum_success_age_seconds = 122;
    const fetchMock = vi.fn().mockResolvedValue(json({ data: settings }));
    vi.stubGlobal("fetch", fetchMock);
    const onSaved = vi.fn();
    render(<QueryClientProvider client={queryClient}><MemoryRouter><SettingsEditor section="collection-policy" settings={settings} onSaved={onSaved} guided /></MemoryRouter></QueryClientProvider>);
    const user = userEvent.setup();
    expect(screen.getByLabelText("请求超时（秒）")).toHaveValue(8.123);
    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(await new Request(...fetchMock.mock.calls[0] as [RequestInfo, RequestInit]).json()).toMatchObject({timeout_milliseconds:8123,scan_interval_seconds:61});
    fetchMock.mockClear();
    await user.click(screen.getByRole("button", { name: "采用推荐值" }));
    expect(screen.getByLabelText("请求超时（秒）")).toHaveValue(8);
    expect(screen.getByLabelText("常规查账间隔（秒）")).toHaveValue(60);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "保存" })).toBeEnabled();
  });
});
