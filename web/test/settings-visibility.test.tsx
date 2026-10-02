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
    fields: [
      "支付宝环境",
      "请求超时（秒）",
      "常规采集间隔（秒）",
      "活跃采集间隔（秒）",
      "安全延迟（秒）",
      "采集有效时限（秒）",
    ],
  },
  {
    section: "collection",
    fields: [
      "收银台有效期（秒）",
      "最大金额尾差（分）",
      "金额复用冷却（秒）",
    ],
  },
  {
    section: "notifications",
    fields: [
      "通知网站（HTTPS 域名）",
      "通知超时（秒）",
      "最大尝试次数",
      "首次重试间隔（秒）",
      "最大重试间隔（秒）",
    ],
  },
  {
    section: "advanced",
    fields: ["收银台链接密钥轮换周期（天）", "收银台结束后查询期（秒）"],
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
      ...settings.notifications,
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
      const title = section === "notifications" ? "业务通知" : section === "backup" ? "自动备份" : "高级设置";
      expect(screen.getByRole("heading", { name: title })).toBeVisible();
      const group = screen.getByRole("group", { name: title });
      expect(within(group).getByText(title)).toHaveClass("sr-only");
    }
    if (!guided && section === "provider") {
      expect(screen.getAllByText("支付宝接入", { exact: true })).toHaveLength(1);
      expect(screen.getByRole("group", { name: "应用凭据" })).toBeVisible();
      expect(screen.getByRole("group", { name: "账单采集" })).toBeVisible();
    }
    if (guided) expect(screen.getByRole("button", { name: "保存" })).toBeEnabled();
    else expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });
});

describe("provider environment select", () => {
  function mount() {
    const settings = configuredThrough(4);
    const onSaved = vi.fn();
    const view = render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <SettingsEditor section="provider" settings={settings} onSaved={onSaved} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    return { ...view, settings, onSaved };
  }

  it("uses the styled menu, tracks reverted drafts, and submits the selected environment", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { container, settings, onSaved } = mount();
    fetchMock.mockResolvedValue(json({ data: settings }));
    const user = userEvent.setup();
    const trigger = screen.getByRole("combobox", { name: "支付宝环境" });
    const save = screen.getByRole("button", { name: "保存" });
    const form = container.querySelector("form")!;
    expect(trigger.tagName).toBe("BUTTON");
    expect(trigger).toHaveTextContent("生产环境");
    expect(save).toBeDisabled();
    await user.click(trigger);
    expect(await screen.findByRole("listbox")).toBeVisible();
    await user.click(await screen.findByRole("option", { name: "沙箱环境" }));
    expect(trigger).toHaveTextContent("沙箱环境");
    expect(new FormData(form).get("environment")).toBe("SANDBOX");
    expect(save).toBeEnabled();
    expect(fetchMock).not.toHaveBeenCalled();
    await user.click(trigger);
    await user.click(await screen.findByRole("option", { name: "生产环境" }));
    expect(save).toBeDisabled();
    await user.click(trigger);
    await user.click(await screen.findByRole("option", { name: "沙箱环境" }));
    await user.click(save);
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0]!;
    const request = new Request(url, init);
    expect(await request.json()).toMatchObject({ environment: "SANDBOX" });
    expect(save).toBeDisabled();
  });

  it("focuses environment validation errors and clears them on selection", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({
      error: { code: "settings_validation_failed", message: "参数校验失败",
        fields: { environment: "当前环境不可用" } },
    }, 422)));
    mount();
    const user = userEvent.setup();
    const trigger = screen.getByRole("combobox", { name: "支付宝环境" });
    await user.click(trigger);
    await user.click(await screen.findByRole("option", { name: "沙箱环境" }));
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByText("当前环境不可用")).toBeVisible();
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(trigger).toHaveAttribute("aria-invalid", "true");
    expect(trigger).toHaveAccessibleDescription("当前环境不可用");
    await user.click(trigger);
    await user.click(await screen.findByRole("option", { name: "生产环境" }));
    expect(screen.queryByText("当前环境不可用")).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-invalid", "false");
  });
});


describe("exact duration drafts", () => {
  it("round-trips existing millisecond values and recommends without saving", async () => {
    const settings = configuredThrough(4);
    settings.provider!.timeout_milliseconds = 8123;
    settings.provider!.scan_interval_seconds = 61;
    settings.provider!.maximum_success_age_seconds = 122;
    const fetchMock = vi.fn().mockResolvedValue(json({ data: settings }));
    vi.stubGlobal("fetch", fetchMock);
    const onSaved = vi.fn();
    render(<QueryClientProvider client={queryClient}><MemoryRouter><SettingsEditor section="provider" settings={settings} onSaved={onSaved} guided /></MemoryRouter></QueryClientProvider>);
    const user = userEvent.setup();
    expect(screen.getByLabelText("请求超时（秒）")).toHaveValue(8.123);
    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(await new Request(...fetchMock.mock.calls[0] as [RequestInfo, RequestInit]).json()).toMatchObject({timeout_milliseconds:8123,scan_interval_seconds:61});
    fetchMock.mockClear();
    await user.click(screen.getByRole("button", { name: "采用推荐值" }));
    expect(screen.getByLabelText("请求超时（秒）")).toHaveValue(8);
    expect(screen.getByLabelText("常规采集间隔（秒）")).toHaveValue(60);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "保存" })).toBeEnabled();
  });
});
