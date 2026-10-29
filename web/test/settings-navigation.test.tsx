import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { queryClient } from "../src/api/client";
import { DraftProvider } from "../src/drafts";
import Settings from "../src/pages/Settings";
import { configuredThrough } from "./onboarding-fixture";

function mediaWidth(initial: number) {
  let width = initial;
  const listeners = new Set<() => void>();
  vi.stubGlobal("innerWidth", initial);
  vi.stubGlobal("matchMedia", vi.fn((media: string) => ({
    media,
    get matches() {
      const max = /max-width:\s*(\d+)px/.exec(media);
      return max ? width <= Number(max[1]) : false;
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

function mount(siteMode = false) {
  queryClient.setQueryData(["settings"], { data: { ...configuredThrough(4), site_mode: siteMode } });
  const router = createMemoryRouter([{
    path: "/settings/:section",
    element: <DraftProvider><Settings /></DraftProvider>,
  }], { initialEntries: ["/settings/display"] });
  render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
  return router;
}

describe("responsive settings category navigation", () => {
  it.each([320, 360, 390, 430, 844, 1023])("uses a category select at %ipx and keeps guarded routes", async width => {
    mediaWidth(width);
    const router = mount();
    const user = userEvent.setup();
    const category = await screen.findByRole("combobox", { name: "设置分类" });
    expect(category).toHaveTextContent("界面显示");
    expect(screen.queryByRole("tablist", { name: "设置分类" })).not.toBeInTheDocument();
    const name = screen.getByRole("textbox", { name: "支付系统名称" });
    fireEvent.change(name, { target: { value: "手机草稿" } });
    await user.click(category);
    await user.click(await screen.findByRole("option", { name: "查账设置" }));
    const guard = await screen.findByRole("alertdialog", { name: "放弃未保存的修改？" });
    expect(router.state.location.pathname).toBe("/settings/display");
    await user.click(within(guard).getByRole("button", { name: "继续编辑" }));
    await waitFor(() => expect(category).toHaveFocus());
    expect(name).toHaveValue("手机草稿");
    expect(category).toHaveTextContent("界面显示");
    await user.click(category);
    await user.click(await screen.findByRole("option", { name: "查账设置" }));
    await user.click(await screen.findByRole("button", { name: "放弃修改并继续" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/collection-policy"));
    expect(screen.getByLabelText("常规查账间隔（秒）")).toBeVisible();
  });

  it("switches navigation at 1024px without remounting the edited form", async () => {
    const resize = mediaWidth(1023);
    mount();
    const name = await screen.findByRole("textbox", { name: "支付系统名称" });
    fireEvent.change(name, { target: { value: "旋转后保留" } });
    resize(1024);
    expect(screen.getByRole("tablist", { name: "设置分类" })).toBeVisible();
    expect(screen.queryByRole("combobox", { name: "设置分类" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "支付系统名称" })).toBe(name);
    resize(430);
    expect(screen.getByRole("combobox", { name: "设置分类" })).toBeVisible();
    expect(name).toHaveValue("旋转后保留");
  });

  it("keeps the desktop selection indicator and draft when navigation is canceled", async () => {
    mediaWidth(1440);
    const router = mount();
    const user = userEvent.setup();
    const tabs = await screen.findByRole("tablist", { name: "设置分类" });
    const display = within(tabs).getByRole("tab", { name: "界面显示" });
    const policy = within(tabs).getByRole("tab", { name: "查账设置" });
    const indicator = display.querySelector("[data-selection-indicator]");
    const name = screen.getByRole("textbox", { name: "支付系统名称" });
    expect(indicator).toBeInTheDocument();
    display.focus();
    await user.keyboard("{ArrowLeft}");
    expect(router.state.location.pathname).toBe("/settings/display");
    expect(display.querySelector("[data-selection-indicator]")).toBe(indicator);

    fireEvent.change(name, { target: { value: "桌面草稿" } });
    await user.click(policy);
    const guard = await screen.findByRole("alertdialog", { name: "放弃未保存的修改？" });
    expect(display).toHaveAttribute("aria-selected", "true");
    expect(policy).toHaveAttribute("aria-selected", "false");
    expect(policy.querySelector("[data-selection-indicator]")).toBeNull();
    await user.click(within(guard).getByRole("button", { name: "继续编辑" }));
    await waitFor(() => expect(guard).not.toBeInTheDocument());
    expect(router.state.location.pathname).toBe("/settings/display");
    expect(screen.getByRole("textbox", { name: "支付系统名称" })).toBe(name);
    expect(name).toHaveValue("桌面草稿");
    expect(display.querySelector("[data-selection-indicator]")).toBe(indicator);
    expect(tabs.querySelectorAll("[data-selection-indicator]")).toHaveLength(1);
  });

  it("omits migrated notification settings from the mobile selector", async () => {
    mediaWidth(360);
    mount(true);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("combobox", { name: "设置分类" }));
    await screen.findByRole("listbox");
    expect(screen.queryByRole("option", { name: /^通知$/ })).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "密钥与安全" })).toBeVisible();
  });
});
