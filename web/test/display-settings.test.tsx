import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { queryClient, type RuntimeSettings } from "../src/api/client";
import { SettingsEditor } from "../src/components/SettingsForms";
import { apiError, json, settings } from "./fixtures";

function mount(currentSettings: RuntimeSettings = settings) {
  const onSaved = vi.fn();
  const editor = (current: RuntimeSettings) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <SettingsEditor
          section="display"
          settings={current}
          onSaved={onSaved}
        />
      </MemoryRouter>
    </QueryClientProvider>
  );
  const view = render(editor(currentSettings));
  return { onSaved, updateSettings: (current: RuntimeSettings) => view.rerender(editor(current)) };
}

describe("instance display settings", () => {
  it("keeps only field labels and controls without redundant headings or descriptions", () => {
    mount();
    const name = screen.getByRole("textbox", { name: "支付系统名称" });
    expect(name).toHaveAttribute("required");
    expect(name).toHaveAttribute("maxlength", "40");
    expect(name).not.toHaveAttribute("aria-describedby");
    expect(screen.getByRole("switch", { name: "收银台显示商品名称" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "商家帮助链接" })).toBeVisible();
    expect(screen.queryByRole("group", { name: "首页图表样式" })).not.toBeInTheDocument();
    const form = name.closest("form")!;
    expect(form).toHaveClass("w-full");
    expect(form).not.toHaveClass("max-w-2xl");
    expect(form.querySelector("[data-slot=card-content] > [data-slot=field-group]")).toHaveClass("max-w-2xl");
    const displayFields = name.closest('[data-slot="field-group"]')!;
    const rows = [...displayFields.children];
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row).toHaveAttribute("data-orientation", "vertical");
      expect(row).not.toContainElement(row.querySelector("label input"));
    }
    expect(rows[0]).toContainElement(name);
    expect(rows[1]).toContainElement(screen.getByRole("textbox", { name: "商家帮助链接" }));
    expect(rows[2]).toContainElement(screen.getByRole("switch", { name: "收银台显示商品名称" }));
    expect(form.elements.namedItem("dashboard_chart_type")).toBeNull();
    expect(form.querySelector('[data-slot="field-description"]')).toBeNull();
    expect(form.querySelector('[data-slot="card-header"]')).toHaveClass("sr-only");
    expect(form.querySelector('[data-slot="field-legend"]')).toHaveClass("sr-only");
    expect(screen.queryByText("系统名称", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText("收银台", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText("收款概览", { exact: true })).not.toBeInTheDocument();
  });

  it("saves display drafts with the latest revision and preserves the server chart default", async () => {
    const requests: Request[] = [];
    const initial: RuntimeSettings = {
      ...settings,
      display: { ...settings.display, dashboard_chart_type: "BAR" },
    };
    const latest: RuntimeSettings = {
      ...initial,
      revision: settings.revision + 2,
      display: { ...initial.display, dashboard_chart_type: "LINE" },
    };
    const saved = {
      ...latest,
      revision: latest.revision + 1,
      display: {
        ...latest.display,
        system_name: "测试支付",
        checkout_help_url: "https://support.example/help",
        checkout_show_product_name: false,
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        requests.push(request);
        return json({ data: saved });
      }),
    );
    const { onSaved, updateSettings } = mount(initial);
    const user = userEvent.setup();
    expect(
      screen.getByRole("switch", { name: "收银台显示商品名称" }),
    ).toBeChecked();
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
    const name = screen.getByRole("textbox", { name: "支付系统名称" });
    await user.clear(name);
    await user.type(name, "测试支付");
    await user.type(screen.getByRole("textbox", { name: "商家帮助链接" }), "https://support.example/help");
    await user.click(
      screen.getByRole("switch", { name: "收银台显示商品名称" }),
    );
    expect(requests).toHaveLength(0);
    updateSettings(latest);
    expect(name).toHaveValue("测试支付");
    expect(screen.getByRole("textbox", { name: "商家帮助链接" })).toHaveValue("https://support.example/help");
    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(saved));
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0]!.url).pathname).toBe(
      "/api/admin/v1/settings/display",
    );
    expect(await requests[0]!.json()).toEqual({
      system_name: "测试支付",
      checkout_help_url: "https://support.example/help",
      revision: latest.revision,
      checkout_show_product_name: false,
      dashboard_chart_type: "LINE",
    });
    expect(screen.queryByText("未保存")).not.toBeInTheDocument();
  });

  it("recognizes restored defaults without making a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    mount();
    const user = userEvent.setup();
    const checkbox = screen.getByRole("switch", { name: "收银台显示商品名称" });
    await user.click(checkbox);
    expect(screen.getByText("未保存")).toBeVisible();
    await user.click(checkbox);
    const name = screen.getByRole("textbox", { name: "支付系统名称" });
    await user.clear(name);
    await user.type(name, "新的支付");
    expect(screen.getByRole("button", { name: "保存" })).toBeEnabled();
    await user.clear(name);
    await user.type(name, "PerPay");
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retains the display draft after a concurrent-save conflict", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        apiError("settings_revision_conflict", "configuration changed"),
      ),
    );
    const { onSaved } = mount();
    const user = userEvent.setup();
    const name = screen.getByRole("textbox", { name: "支付系统名称" });
    await user.clear(name);
    await user.type(name, "尚未保存的名称");
    await user.click(
      screen.getByRole("switch", { name: "收银台显示商品名称" }),
    );
    await user.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByRole("alert");
    expect(
      screen.getByRole("switch", { name: "收银台显示商品名称" }),
    ).not.toBeChecked();
    expect(name).toHaveValue("尚未保存的名称");
    expect(screen.getByText("未保存")).toBeVisible();
    expect(onSaved).not.toHaveBeenCalled();
  });
});
