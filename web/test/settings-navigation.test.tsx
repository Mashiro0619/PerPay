import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { json } from "./fixtures";
import { configuredThrough, mountOnboarding } from "./onboarding-fixture";
import { matchesTestMedia } from "./media-query";

function mediaWidth(initial: number) {
  let width = initial;
  const listeners = new Set<() => void>();
  vi.stubGlobal("innerWidth", initial);
  vi.stubGlobal("matchMedia", vi.fn((media: string) => ({
    media,
    get matches() {
      return matchesTestMedia(media, width);
    },
    addEventListener: (_event: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_event: string, listener: () => void) => listeners.delete(listener),
  })));
  return (next: number) => act(() => {
    width = next;
    vi.stubGlobal("innerWidth", next);
    listeners.forEach(listener => listener());
  });
}

function mount(width: number) {
  const view = mountOnboarding({ stage: 4, path: "/settings/display", viewportWidth: width,
    handle: request => new URL(request.url).pathname === "/api/admin/v1/settings"
      ? json({ data: configuredThrough(4) }) : undefined,
  });
  return { ...view, resize: mediaWidth(width) };
}

describe("responsive settings category navigation", () => {
  it.each([320, 360, 390, 430, 844, 1023])("uses a category select at %ipx and protects inline drafts on route change", async width => {
    const view = mount(width);
    const user = userEvent.setup();
    const category = await screen.findByRole("combobox", { name: "设置分类" });
    expect(category).toHaveTextContent("界面显示");
    expect(screen.queryByRole("tablist", { name: "设置分类" })).not.toBeInTheDocument();
    const name = screen.getByRole("textbox", { name: "系统名称" });
    fireEvent.change(name, { target: { value: "手机草稿" } });
    await user.click(category);
    await user.click(await screen.findByRole("option", { name: "查账设置" }));
    const guard = await screen.findByRole("alertdialog", { name: "放弃未保存的修改？" });
    expect(view.router.state.location.pathname).toBe("/settings/display");
    await user.click(within(guard).getByRole("button", { name: "继续编辑" }));
    await waitFor(() => expect(guard).not.toBeInTheDocument());
    expect(name).toHaveValue("手机草稿");
    expect(category).toHaveTextContent("界面显示");
    await user.click(category);
    await user.click(await screen.findByRole("option", { name: "查账设置" }));
    await user.click(await screen.findByRole("button", { name: "放弃修改并继续" }));
    await waitFor(() => expect(view.router.state.location.pathname).toBe("/settings/collection-policy"));
    expect(screen.getByRole("spinbutton", { name: "常规查账间隔（秒）" })).toBeVisible();
    expect(view.writes()).toHaveLength(0);
  });

  it("switches navigation at 1024px without remounting the inline edited form", async () => {
    const { resize } = mount(1023);
    const name = await screen.findByRole("textbox", { name: "系统名称" });
    fireEvent.change(name, { target: { value: "旋转后保留" } });
    resize(1024);
    expect(document.querySelector('[role="tablist"][aria-label="设置分类"]')).toBeInTheDocument();
    expect(document.querySelector('[role="combobox"][aria-label="设置分类"]')).toBeNull();
    expect(screen.getByRole("textbox", { name: "系统名称" })).toBe(name);
    resize(430);
    expect(document.querySelector('[role="combobox"][aria-label="设置分类"]')).toBeInTheDocument();
    expect(name).toHaveValue("旋转后保留");
  });

  it("keeps the desktop selection indicator and inline draft when navigation is canceled", async () => {
    const view = mount(1440);
    const user = userEvent.setup();
    const tabs = await screen.findByRole("tablist", { name: "设置分类" });
    const display = within(tabs).getByRole("tab", { name: "界面显示" });
    const policy = within(tabs).getByRole("tab", { name: "查账设置" });
    const indicator = display.querySelector("[data-selection-indicator]");
    expect(indicator).toBeInTheDocument();
    display.focus();
    await user.keyboard("{ArrowUp}");
    expect(view.router.state.location.pathname).toBe("/settings/display");
    expect(display.querySelector("[data-selection-indicator]")).toBe(indicator);

    const name = screen.getByRole("textbox", { name: "系统名称" });
    fireEvent.change(name, { target: { value: "桌面草稿" } });
    await act(async () => { void view.router.navigate("/settings/collection-policy"); });
    const guard = await screen.findByRole("alertdialog", { name: "放弃未保存的修改？" });
    expect(display).toHaveAttribute("aria-selected", "true");
    expect(policy).toHaveAttribute("aria-selected", "false");
    expect(policy.querySelector("[data-selection-indicator]")).toBeNull();
    await user.click(within(guard).getByRole("button", { name: "继续编辑" }));
    await waitFor(() => expect(guard).not.toBeInTheDocument());
    expect(view.router.state.location.pathname).toBe("/settings/display");
    expect(screen.getByRole("textbox", { name: "系统名称" })).toBe(name);
    expect(name).toHaveValue("桌面草稿");
    expect(display.querySelector("[data-selection-indicator]")).toBe(indicator);
    expect(tabs.querySelectorAll("[data-selection-indicator]")).toHaveLength(1);
  });

  it("omits migrated notification settings from the mobile selector", async () => {
    mount(360);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("combobox", { name: "设置分类" }));
    await screen.findByRole("listbox");
    expect(screen.queryByRole("option", { name: /^通知$/ })).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "账户与安全" })).toBeVisible();
  });
});
