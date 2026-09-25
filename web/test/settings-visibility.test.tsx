import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
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
      "请求超时（毫秒）",
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
      "通知超时（毫秒）",
      "最大尝试次数",
      "首次重试间隔（秒）",
      "最大重试间隔（秒）",
    ],
  },
  {
    section: "backup",
    fields: ["备份间隔（秒）", "保留备份数量"],
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
    if (guided) expect(screen.getByRole("button", { name: "保存" })).toBeEnabled();
    else expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });
});
