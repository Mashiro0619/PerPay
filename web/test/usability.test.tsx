import { useRef, useState } from "react";
import { runInNewContext } from "node:vm";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { RecordTools } from "../src/components/detail/RecordTools";
import { ReasonDialog } from "../src/components/ReasonDialog";
import { Button } from "../src/components/ui/button";
import { ErrorNotice } from "../src/components/request-state";
import { SuccessMessage, useFeedback } from "../src/components/Feedback";
import { SettingsEditor } from "../src/components/SettingsForms";
import { queryClient } from "../src/api/client";
import {
  configuredThrough,
  mountOnboarding,
  syntheticSecret,
  systemStatus,
} from "./onboarding-fixture";
import themeSource from "../public/theme.js?raw";

function theme() {
  const browser = {
    localStorage: { getItem: () => null, setItem: vi.fn() },
    matchMedia: () => ({ matches: false, addEventListener: vi.fn() }),
    addEventListener: vi.fn(),
    perpayTheme: undefined as Window["perpayTheme"],
  };
  runInNewContext(themeSource, { window: browser, document });
  vi.stubGlobal("perpayTheme", browser.perpayTheme);
  return browser.perpayTheme!;
}

describe("official record action menus", () => {
  it("supports keyboard opening, Home, End and Escape without performing an action", async () => {
    const selected = vi.fn();
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <RecordTools
          data={{}}
          label="更多操作"
          actions={[
            { label: "首项", onSelect: selected },
            { label: "不可用", disabled: true, onSelect: selected },
            { label: "末项", onSelect: selected },
          ]}
        />
      </MemoryRouter>,
    );
    const trigger = screen.getByRole("button", { name: "更多操作" });
    trigger.focus();
    await user.keyboard("{ArrowDown}");
    await screen.findByRole("menu");
    await user.keyboard("{Home}");
    expect(screen.getByRole("menuitem", { name: "首项" })).toHaveFocus();
    await user.keyboard("{End}");
    expect(screen.getByRole("menuitem", { name: "技术详情" })).toHaveFocus();
    expect(screen.getByRole("menuitem", { name: "不可用" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
    );
    expect(trigger).toHaveFocus();
    expect(selected).not.toHaveBeenCalled();
  });
  it("closes on outside click and keeps financial operations explicit", async () => {
    const selected = vi.fn();
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <RecordTools
          data={{}}
          label="更多操作"
          actions={[{ label: "处理", onSelect: selected }]}
        />
        <Button>后续操作</Button>
      </MemoryRouter>,
    );
    await user.click(screen.getByRole("button", { name: "更多操作" }));
    await screen.findByRole("menu");
    await user.click(screen.getByRole("button", { name: "后续操作" }));
    await waitFor(() =>
      expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
    );
    expect(selected).not.toHaveBeenCalled();
  });
  it("opens one confirmation and restores the original record trigger on cancel", async () => {
    const execute = vi.fn();
    function Example() {
      const [open, setOpen] = useState(false);
      const focus = useRef<HTMLButtonElement | null>(null);
      return (
        <>
          <RecordTools
            data={{}}
            label="更多操作"
            actions={[
              {
                label: "撤销关联",
                onSelect: (trigger) => {
                  focus.current = trigger;
                  setOpen(true);
                },
              },
            ]}
          />
          {open && (
            <ReasonDialog
              title="确认撤销"
              description="撤销关联"
              action="确认"
              execute={execute}
              finalFocus={() => focus.current}
              onClose={() => setOpen(false)}
              onSuccess={vi.fn()}
            />
          )}
        </>
      );
    }
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <Example />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const trigger = screen.getByRole("button", { name: "更多操作" });
    await user.click(trigger);
    await user.click(await screen.findByRole("menuitem", { name: "撤销关联" }));
    expect(
      await screen.findByRole("dialog", { name: "确认撤销" }),
    ).toBeVisible();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(execute).not.toHaveBeenCalled();
  });
  it("retains standalone URLs and expands technical data in place", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <RecordTools
          data={{ trace: "synthetic-evidence" }}
          to="/orders/example"
          label="更多操作"
        />
      </MemoryRouter>,
    );
    const trigger = screen.getByRole("button", { name: "更多操作" });
    await user.click(trigger);
    expect(
      await screen.findByRole("menuitem", { name: "单独打开" }),
    ).toHaveAttribute("href", "/orders/example");
    await user.click(screen.getByRole("menuitem", { name: "技术详情" }));
    expect(await screen.findByText(/synthetic-evidence/)).toBeVisible();
  });
});
describe("short feedback and safe settings", () => {
  it("keeps field requirements without repeated provider and key-copy instructions", async () => {
    mountOnboarding({ stage: 4, path: "/settings/provider" });
    expect(await screen.findByLabelText("应用 ID（App ID）")).toBeVisible();
    expect(screen.getByLabelText("支付宝公钥")).toHaveAccessibleDescription(
      "已配置，留空不变。",
    );
    expect(
      screen.queryByText(
        "应用公钥上传至支付宝；支付宝公钥填在下方，两者不能混用。",
      ),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("上传至支付宝开放平台")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "查看应用公钥" })).toBeVisible();
  });
  it("keeps disabled notification consequences only while notifications are disabled", () => {
    const settings = configuredThrough(4);
    settings.notifications.enabled = false;
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <SettingsEditor
            section="notifications"
            settings={settings}
            onSaved={vi.fn()}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.getByText("通知未启用，网站需主动查单。")).toBeVisible();
    fireEvent.click(screen.getByRole("switch", { name: "启用业务通知" }));
    expect(
      screen.queryByText("通知未启用，网站需主动查单。"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByLabelText("通知网站（HTTPS 域名）"),
    ).toHaveAccessibleDescription("不含端口或路径。");
    expect(screen.queryByText(/签名密钥在/)).not.toBeInTheDocument();
  });
  it("does not explain normal operation twice or leave an empty summary paragraph", async () => {
    mountOnboarding({ stage: 4, path: "/system" });
    const heading = await screen.findByRole("heading", { name: "可以收款" });
    expect(heading.parentElement?.querySelector("p")).toBeNull();
    expect(screen.getByText("以下统计包含已忽略记录。")).toBeVisible();
    expect(screen.queryByText("收款链路运行正常。")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/详见下方|可查看结果后|仍保留校验约束/),
    ).not.toBeInTheDocument();
  });
  it("shows actual errors without a second generic failure heading", () => {
    render(<ErrorNotice error={new Error("数据状态已变化")} />);
    expect(screen.getByRole("alert")).toHaveTextContent("数据状态已变化");
    expect(screen.queryByText("未能完成")).not.toBeInTheDocument();
  });
  it("clears success after four seconds but retains an error and its collapsed request details", async () => {
    function Example() {
      const [message, setMessage] = useFeedback();
      return (
        <>
          <Button onClick={() => setMessage("已保存")}>保存</Button>
          <SuccessMessage message={message} />
          <ErrorNotice error={new Error("请修正设置")} />
        </>
      );
    }
    vi.useFakeTimers();
    render(<Example />);
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(screen.getByText("已保存")).toBeVisible();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4001);
    });
    expect(screen.queryByText("已保存")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("请修正设置");
  });
  it("does not submit an unchanged configured form, even through a synthetic submit", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <SettingsEditor
            section="backup"
            settings={configuredThrough(4)}
            onSaved={vi.fn()}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const save = screen.getByRole("button", { name: "保存" });
    expect(save).toBeDisabled();
    fireEvent.submit(save.closest("form")!);
    expect(fetchMock).not.toHaveBeenCalled();
    const keep = screen.getByLabelText("保留备份数量");
    fireEvent.change(keep, { target: { value: "8" } });
    expect(save).toBeEnabled();
    fireEvent.change(keep, { target: { value: "7" } });
    expect(save).toBeDisabled();
  });
  it("preserves a settings draft across brightness changes without issuing a write", async () => {
    const control = theme();
    const view = mountOnboarding({ stage: 4, path: "/settings/collection" });
    const field = await screen.findByLabelText("收银台有效期（秒）");
    fireEvent.change(field, { target: { value: "450" } });
    act(() => {
      control.setPreference("dark");
    });
    expect(screen.getByLabelText("收银台有效期（秒）")).toBe(field);
    expect(field).toHaveValue(450);
    expect(screen.getByText("未保存")).toBeVisible();
    expect(view.writes()).toHaveLength(0);
  });
  it("makes settings inert during an explicit refresh without corrupting the form baseline", async () => {
    let loading = false;
    let finish: (response: Response) => void = () => {};
    const view = mountOnboarding({
      stage: 4,
      path: "/settings/collection",
      handle: (request) =>
        loading && request.url.endsWith("/settings")
          ? new Promise<Response>((resolve) => {
              finish = resolve;
            })
          : undefined,
    });
    await screen.findByLabelText("收银台有效期（秒）");
    loading = true;
    await userEvent.setup().click(screen.getByRole("button", { name: "刷新" }));
    expect(
      screen
        .getByLabelText("收银台有效期（秒）")
        .closest("[data-settings-content]"),
    ).toHaveAttribute("inert");
    await act(async () => {
      finish(
        new Response(
          JSON.stringify({ data: { ...configuredThrough(4), revision: 4 } }),
          { headers: { "Content-Type": "application/json" } },
        ),
      );
    });
    await waitFor(() =>
      expect(
        screen
          .getByLabelText("收银台有效期（秒）")
          .closest("[data-settings-content]"),
      ).not.toHaveAttribute("inert"),
    );
    const field = screen.getByLabelText("收银台有效期（秒）");
    fireEvent.change(field, { target: { value: "450" } });
    expect(screen.getByRole("button", { name: "保存" })).toBeEnabled();
    fireEvent.change(field, { target: { value: "300" } });
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
    expect(view.writes()).toHaveLength(0);
  });
  it("never prefetches a secret on hover or appearance changes and reads only once per explicit view", async () => {
    const control = theme();
    const view = mountOnboarding({ stage: 4, path: "/settings/security" });
    const user = userEvent.setup();
    const viewKey = await screen.findByRole("button", {
      name: "查看网站 API 密钥",
    });
    await user.hover(viewKey);
    act(() => {
      control.setPreference("dark");
    });
    expect(view.writes()).toHaveLength(0);
    await user.click(viewKey);
    expect(await screen.findByText(syntheticSecret)).toBeVisible();
    expect(view.writes()).toHaveLength(1);
    act(() => {
      control.setPreference("light");
    });
    expect(view.writes()).toHaveLength(1);
    expect(
      JSON.stringify(
        queryClient
          .getQueryCache()
          .getAll()
          .map((query) => query.state.data),
      ),
    ).not.toContain(syntheticSecret);
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: /^关闭$/,
      }),
    );
    expect(screen.queryByText(syntheticSecret)).not.toBeInTheDocument();
  });
  it("retains true conflict and failure totals, without linking them to an active-only reminder list", async () => {
    mountOnboarding({
      stage: 4,
      path: "/system",
      status: (settings) => {
        const status = systemStatus(settings);
        return {
          ...status,
          ledger: {
            ...status.ledger,
            conflicts: {
              provider_account_key: "test",
              open: 8,
              resolved: 1,
              ignored: 0,
              total: 9,
              by_type: [],
            },
          },
          reconciliation: {
            ...status.reconciliation,
            exceptions: {
              provider_account_key: "test",
              open: 6,
              resolved: 1,
              total: 7,
            },
          },
          webhook: {
            ...status.webhook,
            dead_letters: 3,
            pending_deliveries: 2,
          },
        };
      },
    });
    expect(await screen.findByText("未处理冲突 8")).toBeVisible();
    expect(screen.getByText("待核对订单 0 · 未处理异常 6")).toBeVisible();
    expect(screen.getByText("以下统计包含已忽略记录。")).toBeVisible();
    expect(
      screen.getByRole("link", { name: "查看全部冲突记录" }),
    ).toHaveAttribute("href", "/reconciliation?tab=conflicts&status=ALL");
    expect(screen.queryByRole("link", { name: "8" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "6" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "3" })).toHaveAttribute(
      "href",
      "/notifications?status=DEAD_LETTER",
    );
    expect(screen.getByText("有运行告警")).toBeVisible();
    await waitFor(() =>
      expect(screen.queryByText("收款链路运行正常。")).not.toBeInTheDocument(),
    );
  });
});
