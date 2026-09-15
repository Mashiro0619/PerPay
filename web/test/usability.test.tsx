import { useState } from "react";
import { runInNewContext } from "node:vm";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { MoreActions } from "../src/components/MoreActions";
import { Button, Dialog, ErrorNotice } from "../src/components/ui";
import { SuccessMessage, useFeedback } from "../src/components/Feedback";
import { SettingsEditor } from "../src/components/SettingsForms";
import { queryClient } from "../src/api/client";
import { configuredThrough, mountOnboarding, syntheticSecret, systemStatus } from "./onboarding-fixture";
import themeSource from "../public/theme.js?raw";

function theme() {
  const browser = { localStorage: { getItem: () => null, setItem: vi.fn() }, matchMedia: () => ({ matches: false, addEventListener: vi.fn() }), addEventListener: vi.fn(), perpayTheme: undefined as Window["perpayTheme"] };
  runInNewContext(themeSource, { window: browser, document });
  vi.stubGlobal("perpayTheme", browser.perpayTheme);
  return browser.perpayTheme!;
}

describe("record action menus", () => {
  it("supports arrows, Home, End, Escape and skips disabled items", async () => {
    const selected = vi.fn(); const user = userEvent.setup();
    render(<MemoryRouter><MoreActions actions={[{ label: "首项", onSelect: selected }, { label: "不可用", disabled: true }, { label: "末项", onSelect: selected }]} /></MemoryRouter>);
    const trigger = screen.getByRole("button", { name: "更多操作" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    trigger.focus(); await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "首项" })).toHaveFocus();
    await user.keyboard("{ArrowDown}"); expect(screen.getByRole("menuitem", { name: "末项" })).toHaveFocus();
    await user.keyboard("{Home}"); expect(screen.getByRole("menuitem", { name: "首项" })).toHaveFocus();
    await user.keyboard("{End}"); expect(screen.getByRole("menuitem", { name: "末项" })).toHaveFocus();
    await user.keyboard("{Escape}"); expect(trigger).toHaveFocus();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument(); expect(selected).not.toHaveBeenCalled();
    await user.keyboard("{ArrowUp}"); expect(screen.getByRole("menuitem", { name: "末项" })).toHaveFocus();
  });
  it("closes on Tab and outside click without stealing the next control focus", async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><MoreActions actions={[{ label: "查看", onSelect: vi.fn() }]} /><Button>后续操作</Button></MemoryRouter>);
    const trigger = screen.getByRole("button", { name: "更多操作" });
    await user.click(trigger); await user.tab();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "后续操作" })).toHaveFocus();
    await user.click(trigger); await user.click(screen.getByRole("button", { name: "后续操作" }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "后续操作" })).toHaveFocus();
  });
  it("keeps the menu open while its visible anchor is scrolled and avoids focus-driven scrolling", async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><MoreActions actions={[{ label: "操作", onSelect: vi.fn() }]} /></MemoryRouter>);
    await user.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.scroll(window); fireEvent.scroll(document);
    expect(screen.getByRole("menuitem", { name: "操作" })).toHaveFocus();
    expect(screen.getByRole("menu")).toBeInTheDocument();
    const trigger = screen.getByRole("button", { name: "更多操作" });
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({ top: -60, bottom: -16, left: 0, right: 100, width: 100, height: 44 } as DOMRect);
    fireEvent.scroll(window);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
  it("opens one confirmation and returns focus to the original menu trigger on cancel", async () => {
    function Example() { const [open, setOpen] = useState(false); return <><MoreActions actions={[{ label: "撤销关联", onSelect: () => setOpen(true) }]} />{open && <Dialog title="确认撤销" onClose={() => setOpen(false)}><Button onClick={() => setOpen(false)}>取消</Button></Dialog>}</>; }
    const user = userEvent.setup(); render(<MemoryRouter><Example /></MemoryRouter>);
    const trigger = screen.getByRole("button", { name: "更多操作" });
    await user.click(trigger); await user.click(screen.getByRole("menuitem", { name: "撤销关联" }));
    expect(screen.getAllByRole("dialog")).toHaveLength(1); expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "取消" })); expect(trigger).toHaveFocus();
  });
  it("keeps independent links as links and tolerates an all-disabled menu", async () => {
    const user = userEvent.setup();
    const view = render(<MemoryRouter><MoreActions actions={[{ label: "单独打开", to: "/orders/example" }]} /></MemoryRouter>);
    await user.click(screen.getByRole("button", { name: "更多操作" }));
    expect(screen.getByRole("menuitem", { name: "单独打开" })).toHaveAttribute("href", "/orders/example");
    view.unmount();
    render(<MemoryRouter><MoreActions actions={[{ label: "暂不可用", disabled: true }]} /></MemoryRouter>);
    await user.click(screen.getByRole("button", { name: "更多操作" }));
    expect(screen.getByRole("menu")).toHaveFocus();
    await user.keyboard("{ArrowDown}{Escape}");
    expect(screen.getByRole("button", { name: "更多操作" })).toHaveFocus();
  });
});

describe("short feedback and safe settings", () => {
  it("clears success after four seconds but retains an error and its collapsed request details", async () => {
    function Example() { const [message, setMessage] = useFeedback(); return <><Button onClick={() => setMessage("已保存")}>保存</Button><SuccessMessage message={message} /><ErrorNotice error={new Error("请修正设置")} /></>; }
    vi.useFakeTimers(); render(<Example />);
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(screen.getByText("已保存")).toBeVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(4001); });
    expect(screen.queryByText("已保存")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("请修正设置");
  });
  it("does not submit an unchanged configured form, even through a synthetic submit", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    render(<QueryClientProvider client={queryClient}><MemoryRouter><SettingsEditor section="backup" settings={configuredThrough(4)} onSaved={vi.fn()} /></MemoryRouter></QueryClientProvider>);
    const save = screen.getByRole("button", { name: "保存" });
    expect(save).toBeDisabled(); fireEvent.submit(save.closest("form")!); expect(fetchMock).not.toHaveBeenCalled();
    const keep = screen.getByLabelText("保留备份数量");
    fireEvent.change(keep, { target: { value: "8" } }); expect(save).toBeEnabled();
    fireEvent.change(keep, { target: { value: "7" } }); expect(save).toBeDisabled();
  });
  it("preserves a settings draft across palette and brightness changes without issuing a write", async () => {
    const control = theme(); const view = mountOnboarding({ stage: 4, path: "/settings/collection" });
    const field = await screen.findByLabelText("收银台有效期（秒）");
    fireEvent.change(field, { target: { value: "450" } });
    act(() => { control.setPalette("sand"); control.setPreference("dark"); });
    expect(screen.getByLabelText("收银台有效期（秒）")).toBe(field); expect(field).toHaveValue(450);
    expect(screen.getByText("未保存")).toBeVisible(); expect(view.writes()).toHaveLength(0);
  });
  it("makes settings inert during an explicit refresh without corrupting the form baseline", async () => {
    let loading = false; let finish: (response: Response) => void = () => {};
    const view = mountOnboarding({ stage: 4, path: "/settings/collection", handle: request => loading && request.url.endsWith("/settings") ? new Promise<Response>(resolve => { finish = resolve; }) : undefined });
    await screen.findByLabelText("收银台有效期（秒）");
    loading = true;
    await userEvent.setup().click(screen.getByRole("button", { name: "刷新" }));
    expect(screen.getByLabelText("收银台有效期（秒）").closest(".settings-content")).toHaveAttribute("inert");
    await act(async () => { finish(new Response(JSON.stringify({ data: { ...configuredThrough(4), revision: 4 } }), { headers: { "Content-Type": "application/json" } })); });
    await waitFor(() => expect(screen.getByLabelText("收银台有效期（秒）").closest(".settings-content")).not.toHaveAttribute("inert"));
    const field = screen.getByLabelText("收银台有效期（秒）");
    fireEvent.change(field, { target: { value: "450" } });
    expect(screen.getByRole("button", { name: "保存" })).toBeEnabled();
    fireEvent.change(field, { target: { value: "300" } });
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
    expect(view.writes()).toHaveLength(0);
  });
  it("never prefetches a secret on hover or appearance changes and reads only once per explicit view", async () => {
    const control = theme(); const view = mountOnboarding({ stage: 4, path: "/settings/security" }); const user = userEvent.setup();
    const viewKey = await screen.findByRole("button", { name: "查看网站 API 密钥" });
    await user.hover(viewKey);
    act(() => { control.setPalette("bamboo"); control.setPreference("dark"); });
    expect(view.writes()).toHaveLength(0);
    await user.click(viewKey); expect(await screen.findByText(syntheticSecret)).toBeVisible();
    expect(view.writes()).toHaveLength(1);
    act(() => { control.setPalette("violet"); control.setPreference("light"); });
    expect(view.writes()).toHaveLength(1);
    expect(JSON.stringify(queryClient.getQueryCache().getAll().map(query => query.state.data))).not.toContain(syntheticSecret);
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^关闭$/ }));
    expect(screen.queryByText(syntheticSecret)).not.toBeInTheDocument();
  });
  it("retains true conflict and failure totals, without linking them to an active-only reminder list", async () => {
    mountOnboarding({ stage: 4, path: "/system", status: settings => {
      const status = systemStatus(settings);
      return { ...status, ledger: { ...status.ledger, conflicts: { provider_account_key: "test", open: 8, resolved: 1, ignored: 0, total: 9, by_type: [] } }, reconciliation: { ...status.reconciliation, exceptions: { provider_account_key: "test", open: 6, resolved: 1, total: 7 } }, webhook: { ...status.webhook, dead_letters: 3, pending_deliveries: 2 } };
    } });
    expect(await screen.findByText("未处理冲突 8")).toBeVisible();
    expect(screen.getByText("待核对订单 0 · 未处理异常 6")).toBeVisible();
    expect(screen.getByText("统计包含已忽略提醒的记录。")).toBeVisible();
    expect(screen.getByRole("link", { name: "查看全部冲突记录" })).toHaveAttribute("href", "/reconciliation?tab=conflicts&status=ALL");
    expect(screen.queryByRole("link", { name: "8" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "6" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "3" })).toHaveAttribute("href", "/notifications?status=DEAD_LETTER");
    expect(screen.getByText("部分环节需要关注，详见下方。")).toBeVisible();
    await waitFor(() => expect(screen.queryByText("收款链路运行正常。")).not.toBeInTheDocument());
  });
});
