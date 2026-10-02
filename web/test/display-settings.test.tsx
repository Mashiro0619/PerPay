import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { queryClient } from "../src/api/client";
import { SettingsEditor } from "../src/components/SettingsForms";
import { apiError, json, settings } from "./fixtures";

function mount(onSaved = vi.fn()) {
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <SettingsEditor
          section="display"
          settings={settings}
          onSaved={onSaved}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return onSaved;
}

describe("instance display settings", () => {
  it("keeps only field labels and controls without redundant headings or descriptions", () => {
    mount();
    const name = screen.getByRole("textbox", { name: "支付系统名称" });
    expect(name).toHaveAttribute("required");
    expect(name).toHaveAttribute("maxlength", "40");
    expect(name).not.toHaveAttribute("aria-describedby");
    expect(screen.getByRole("switch", { name: "收银台显示商品名称" })).toBeVisible();
    expect(screen.getByRole("group", { name: "首页图表样式" })).toBeVisible();
    const form = name.closest("form")!;
    expect(form).toHaveClass("max-w-2xl");
    const displayFields = name.closest('[data-slot="field-group"]')!;
    const rows = [...displayFields.children];
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row).toHaveAttribute("data-orientation", "responsive");
      expect(row).toHaveClass("@md/field-group:grid-cols-[10rem_minmax(0,1fr)]");
    }
    expect(rows[0]).toContainElement(name);
    expect(rows[2]).toContainElement(screen.getByRole("group", { name: "首页图表样式" }));
    expect(rows[3]).toContainElement(screen.getByRole("switch", { name: "收银台显示商品名称" }));
    expect(form.querySelector('[data-slot="field-description"]')).toBeNull();
    expect(form.querySelector('[data-slot="card-header"]')).toHaveClass("sr-only");
    expect(form.querySelector('[data-slot="field-legend"]')).toHaveClass("sr-only");
    expect(screen.queryByText("系统名称", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText("收银台", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText("收款概览", { exact: true })).not.toBeInTheDocument();
  });

  it("persists both settings with the latest revision, without saving on selection", async () => {
    const requests: Request[] = [];
    const saved = {
      ...settings,
      revision: settings.revision + 1,
      display: {
        checkout_show_product_name: false,
        dashboard_chart_type: "BAR" as const,
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        requests.push(request);
        return json({ data: saved });
      }),
    );
    const onSaved = mount();
    const user = userEvent.setup();
    expect(
      screen.getByRole("switch", { name: "收银台显示商品名称" }),
    ).toBeChecked();
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
    await user.click(
      screen.getByRole("switch", { name: "收银台显示商品名称" }),
    );
    await user.click(screen.getByRole("button", { name: "柱状图" }));
    expect(screen.getByRole("button", { name: "柱状图" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(requests).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(saved));
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0]!.url).pathname).toBe(
      "/api/admin/v1/settings/display",
    );
    expect(await requests[0]!.json()).toEqual({
      system_name: "PerPay",
      checkout_help_url: null,
      revision: settings.revision,
      checkout_show_product_name: false,
      dashboard_chart_type: "BAR",
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
    await user.click(checkbox);
    await user.click(screen.getByRole("button", { name: "折线图" }));
    await user.click(screen.getByRole("button", { name: "面积图" }));
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retains the selected display settings after a concurrent-save conflict", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        apiError("settings_revision_conflict", "configuration changed"),
      ),
    );
    const onSaved = mount();
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("switch", { name: "收银台显示商品名称" }),
    );
    await user.click(screen.getByRole("button", { name: "折线图" }));
    await user.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByRole("alert");
    expect(
      screen.getByRole("switch", { name: "收银台显示商品名称" }),
    ).not.toBeChecked();
    expect(screen.getByRole("button", { name: "折线图" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByText("未保存")).toBeVisible();
    expect(onSaved).not.toHaveBeenCalled();
  });
});
