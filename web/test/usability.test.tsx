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
import { useSuccessToast } from "../src/components/Feedback";
import { Toaster } from "../src/components/ui/toast";
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
  it("starts its accessible name with the visible action while preserving the record context", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <RecordTools data={{}} label="订单操作" />
      </MemoryRouter>,
    );
    const trigger = screen.getByRole("button", { name: "更多操作，订单操作" });
    expect(trigger).toHaveTextContent("更多操作");
    trigger.focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("menuitem", { name: "技术详情" })).toBeVisible();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
  });
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
      "从支付宝应用的接口加签设置复制。",
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
    settings.notifications!.enabled = false;
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
    fireEvent.click(screen.getByRole("switch", { name: "启用通知" }));
    expect(
      screen.queryByText("通知未启用，网站需主动查单。"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByLabelText("通知地址前缀"),
    ).toHaveAccessibleDescription("例如 https://shop.example.com，不含端口或路径。");
    expect(screen.queryByText(/签名密钥在/)).not.toBeInTheDocument();
  });
  it("keeps normal runtime status concise without duplicate summaries or explanatory detail controls", async () => {
    const view = mountOnboarding({ stage: 4, path: "/system" });
    const table = await screen.findByRole("table", { name: "运行环节" });
    const runtime = within(table);
    expect(table).toBeVisible();
    for (const name of ["服务", "状态", "任务最近成功", "运行信息"]) {
      expect(runtime.getByRole("columnheader", { name })).toBeVisible();
    }
    expect(screen.queryByRole("heading", { name: /^(可以收款|暂不能收款)$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "待处理提醒" })).not.toBeInTheDocument();
    expect(screen.queryByText("有业务提醒待处理")).not.toBeInTheDocument();
    for (const [title, explanation] of [
      ["查账", "查账支付宝账本，为收款核对提供依据。"],
      ["自动确认收款", "核对账本与订单，并确认符合条件的收款。"],
      ["通知", "将收款结果发送到对应的业务网站。"],
      ["数据库", "订单、账本与运行记录保存在当前系统。"],
    ] as const) {
      const service = within(runtime.getByRole("rowheader", { name: title }).closest("tr")!);
      const status = service.getByRole("cell", { name: "正常" });
      expect(status).toBeVisible();
      expect(service.queryByRole("button", { name: "查看" + title + "详情" })).not.toBeInTheDocument();
      expect(runtime.queryByText(explanation)).not.toBeInTheDocument();
    }
    expect(screen.queryByText("待核对订单 0")).not.toBeInTheDocument();
    expect(screen.queryByText("待投递 0")).not.toBeInTheDocument();
    for (const name of ["自动确认收款", "通知"]) {
      const service = within(runtime.getByRole("rowheader", { name }).closest("tr")!);
      expect(service.getAllByRole("cell")[2]).toHaveTextContent(/^—$/);
    }
    expect(runtime.getByRole("button", { name: "备份详情" })).toBeVisible();
    const diagnostics = screen.getByRole("button", { name: "运行诊断" });
    expect(diagnostics).toBeVisible();
    expect(screen.queryByRole("button", { name: "运行技术信息" })).not.toBeInTheDocument();
    expect(
      screen.queryByText("提醒数仅包含未忽略且仍需处理的提醒。"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("收款链路运行正常。")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/详见下方|可查看结果后|仍保留校验约束/),
    ).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(diagnostics);
    const dialog = await screen.findByRole("dialog", { name: "技术详情" });
    expect(within(dialog).getByText("实例编号")).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(diagnostics).toHaveFocus();
    expect(view.writes()).toHaveLength(0);
  });
  it("shows actual errors without a second generic failure heading", () => {
    render(<ErrorNotice error={new Error("数据状态已变化")} />);
    expect(screen.getByRole("alert")).toHaveTextContent("数据状态已变化");
    expect(screen.queryByText("未能完成")).not.toBeInTheDocument();
  });
  it("clears success after four seconds but retains an error and its collapsed request details", async () => {
    function Example() {
      const setMessage = useSuccessToast();
      return (
        <>
          <Button onClick={() => setMessage("已保存")}>保存</Button>
          <ErrorNotice error={new Error("请修正设置")} />
        </>
      );
    }
    vi.useFakeTimers();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    render(<Toaster><Example /></Toaster>);
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(screen.getByText("已保存")).toBeVisible();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
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
    const view = mountOnboarding({ stage: 4, path: "/settings/collection-policy" });
    const field = await screen.findByLabelText("查账有效时限（秒）");
    fireEvent.change(field, { target: { value: "450" } });
    act(() => {
      control.setPreference("dark");
    });
    expect(screen.getByLabelText("查账有效时限（秒）")).toBe(field);
    expect(field).toHaveValue(450);
    expect(screen.getByText("未保存")).toBeVisible();
    expect(view.writes()).toHaveLength(0);
  });
  it("makes settings inert during an explicit refresh without corrupting the form baseline", async () => {
    let loading = false;
    let finish: (response: Response) => void = () => {};
    const view = mountOnboarding({
      stage: 4,
      path: "/settings/collection-policy",
      handle: (request) =>
        loading && request.url.endsWith("/settings")
          ? new Promise<Response>((resolve) => {
              finish = resolve;
            })
          : undefined,
    });
    await screen.findByLabelText("查账有效时限（秒）");
    loading = true;
    await userEvent.setup().click(screen.getByRole("button", { name: "刷新" }));
    expect(
      screen
        .getByLabelText("查账有效时限（秒）")
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
          .getByLabelText("查账有效时限（秒）")
          .closest("[data-settings-content]"),
      ).not.toHaveAttribute("inert"),
    );
    const field = screen.getByLabelText("查账有效时限（秒）");
    fireEvent.change(field, { target: { value: "450" } });
    expect(screen.getByRole("button", { name: "保存" })).toBeEnabled();
    fireEvent.change(field, { target: { value: String(configuredThrough(4).collection_policy!.maximum_success_age_seconds) } });
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
    expect(view.writes()).toHaveLength(0);
  });
  it("never prefetches a secret on hover or appearance changes and reads only once per explicit view", async () => {
    const control = theme();
    const view = mountOnboarding({ stage: 4, path: "/settings/security" });
    const user = userEvent.setup();
    const viewKey = await screen.findByRole("button", {
      name: "查看PerPay API 密钥",
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
  it("keeps business reminders in navigation and shows actual runtime queues without raw diagnostic totals", async () => {
    mountOnboarding({
      stage: 4,
      path: "/system",
      status: (settings) => {
        const status = systemStatus(settings);
        return {
          ...status,
          work_items: {
            total: 4,
            financial_exceptions: 1,
            ledger_conflicts: 2,
            notification_failures: 1,
          },
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
            pending_orders: 5,
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
    const runtime = within(await screen.findByRole("table", { name: "运行环节" }));
    expect(within(screen.getByRole("navigation", { name: "全局管理" })).getByRole("link", { name: "运行状态" })).toHaveAccessibleDescription("待处理");
    expect(screen.getByRole("link", { name: "待处理" })).toHaveAttribute("href", "/work-items");
    expect(screen.queryByText("提醒数仅包含未忽略且仍需处理的提醒。")).not.toBeInTheDocument();
    const reconciliation = within(runtime.getByRole("rowheader", { name: "自动确认收款" }).closest("tr")!);
    const notifications = within(runtime.getByRole("rowheader", { name: "通知" }).closest("tr")!);
    expect(reconciliation.getByRole("cell", { name: "待核对订单 5" })).toBeVisible();
    expect(notifications.getByRole("cell", { name: "待投递 2" })).toBeVisible();
    expect(reconciliation.queryByText(/异常提醒|未处理异常/)).not.toBeInTheDocument();
    expect(notifications.queryByText(/失败提醒/)).not.toBeInTheDocument();
    expect(screen.queryByText("有业务提醒待处理")).not.toBeInTheDocument();
    expect(screen.queryByText("有运行告警")).not.toBeInTheDocument();
    expect(screen.queryByText("已暂停接收新订单")).not.toBeInTheDocument();
    for (const name of ["查账", "自动确认收款", "通知"]) {
      const row = within(runtime.getByRole("rowheader", { name }).closest("tr")!);
      expect(row.getByRole("cell", { name: "正常" })).toBeVisible();
      expect(row.queryByRole("cell", { name: "需关注" })).not.toBeInTheDocument();
    }
    await waitFor(() =>
      expect(screen.queryByText("收款链路运行正常。")).not.toBeInTheDocument(),
    );
  });
});
