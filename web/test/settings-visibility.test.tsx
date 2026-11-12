import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { json } from "./fixtures";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { queryClient } from "../src/api/client";
import { SettingsEditor } from "../src/components/SettingsForms";
import { configuredThrough } from "./onboarding-fixture";
import { OverlayContext } from "../src/lib/overlay-context";

const sections = [
  { section: "collection-policy", fields: ["请求超时（秒）", "常规查账间隔（秒）", "活跃查账间隔（秒）", "查账最小间隔（秒）", "查账延迟（秒）", "查账有效时限（秒）"] },
  {
    section: "advanced",
    fields: ["收银台链接密钥轮换周期（天）", "结束后可查询时长（秒）"],
  },
  {
    section: "backup",
    fields: ["备份间隔", "保留备份数量"],
  },
] as const;

describe("settings overlay headings", () => {
  it.each([
    ["collection-policy", "查账设置", "PerPay 查账设置"],
    ["backup", "自动备份", "自动备份"],
    ["display", "界面显示", "界面显示"],
    ["advanced", "高级设置", "高级设置"],
  ] as const)("keeps the %s field group named without repeating the dialog heading", (section, title, group) => {
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <OverlayContext.Provider value={{ target: { pathname: "/settings/" + section + "/edit", search: "", hash: "", key: "test", state: null }, resourceScope: { clientId: null, base: "" }, size: "lg", requestClose: vi.fn() }}>
            <h1>编辑{title}</h1>
            <SettingsEditor section={section} settings={configuredThrough(4)} onSaved={vi.fn()} />
          </OverlayContext.Provider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.getByRole("heading", { name: "编辑" + title })).toBeVisible();
    expect(screen.queryByRole("heading", { name: title })).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: group })).toBeVisible();
  });
});

describe("directly visible settings", () => {
  it.each(sections)("shows $section parameters without a disclosure or implicit save", ({ section, fields }) => {
    const settings = configuredThrough(4);
    const fetchMock = vi.fn();
    const onSaved = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <SettingsEditor
            section={section}
            settings={settings}
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
    if (["backup", "advanced"].includes(section)) {
      const title = section === "backup" ? "自动备份" : "高级设置";
      expect(screen.getByRole("heading", { name: title })).toBeVisible();
      const group = screen.getByRole("group", { name: title });
      expect(within(group).getByText(title)).toHaveClass("sr-only");
    }
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
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
    render(<QueryClientProvider client={queryClient}><MemoryRouter><SettingsEditor section="collection-policy" settings={settings} onSaved={onSaved} /></MemoryRouter></QueryClientProvider>);
    const user = userEvent.setup();
    expect(screen.getByLabelText("请求超时（秒）")).toHaveValue(8.123);
    fireEvent.change(screen.getByLabelText("查账最小间隔（秒）"), { target: { value: "9" } });
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
