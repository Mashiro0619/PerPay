import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
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
  it("keeps the display fields together and exposes the same chart default as the settings summary", () => {
    mount();
    const name = screen.getByRole("textbox", { name: "系统名称" });
    expect(name).toHaveAttribute("required");
    expect(name).toHaveAttribute("maxlength", "40");
    expect(name).not.toHaveAttribute("aria-describedby");
    const chart = screen.getByRole("group", { name: "收款趋势默认图形" });
    expect(within(chart).getByRole("button", { name: "面积图" })).toHaveAttribute("aria-pressed", "true");
    expect(within(chart).getByRole("button", { name: "柱状图" })).toHaveAttribute("aria-pressed", "false");
    expect(within(chart).getByRole("button", { name: "累计图" })).toHaveAttribute("aria-pressed", "false");
    const form = name.closest("form")!;
    expect(form).toHaveClass("w-full");
    expect(form).not.toHaveClass("max-w-2xl");
    expect(form.querySelector("[data-slot=card-content] > [data-slot=field-set]")).toHaveClass("max-w-2xl");
    const displayFields = name.closest('[data-slot="field-group"]')!;
    const rows = [...displayFields.children];
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row).toHaveAttribute("data-orientation", "vertical");
      expect(row).not.toContainElement(row.querySelector("label input"));
    }
    expect(rows[0]).toContainElement(name);
    expect(rows[1]).toContainElement(chart);
    const sections = screen.getByRole("group", { name: "总览显示模块" });
    expect(rows[2]).toContainElement(sections);
    const notFound = screen.getByRole("textbox", { name: "订单不存在（404）说明" });
    expect(rows[3]).toContainElement(notFound);
    expect(notFound).toHaveAttribute("maxlength", "200");
    for (const label of ["核心指标", "收款趋势", "各网站概览", "待处理", "最近订单"]) {
      expect(within(sections).getByRole("switch", { name: label })).toBeChecked();
    }
    expect(new FormData(form).get("dashboard_chart_type")).toBe("AREA");
    expect(chart).toHaveAccessibleDescription("用于未设置个人图形偏好的浏览器。");
    expect(sections).toHaveAccessibleDescription("控制总览页展示的卡片模块，至少保留一项开启。");
    expect(form.querySelector('[data-slot="card-header"]')).toHaveClass("sr-only");
    expect(form.querySelector('[data-slot="field-legend"]')).toHaveClass("sr-only");
    expect(screen.getByLabelText("系统名称")).toBeVisible();
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
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
    const name = screen.getByRole("textbox", { name: "系统名称" });
    await user.clear(name);
    await user.type(name, "测试支付");
    expect(requests).toHaveLength(0);
    updateSettings(latest);
    expect(name).toHaveValue("测试支付");
    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(saved));
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0]!.url).pathname).toBe(
      "/api/admin/v1/settings/display",
    );
    expect(await requests[0]!.json()).toEqual({
      system_name: "测试支付",
      revision: latest.revision,
      dashboard_chart_type: "LINE",
    });
    expect(screen.getByRole("button", { name: "累计图" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText("未保存")).not.toBeInTheDocument();
  });

  it("keeps a selected chart as a draft, restores a clean default, and saves only the explicit selection", async () => {
    const requests: Request[] = [];
    const saved: RuntimeSettings = { ...settings, revision: settings.revision + 1,
      display: { ...settings.display, dashboard_chart_type: "BAR" } };
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => { requests.push(request); return json({ data: saved }); }));
    const { onSaved } = mount();
    const user = userEvent.setup();
    const chart = screen.getByRole("group", { name: "收款趋势默认图形" });
    await user.click(within(chart).getByRole("button", { name: "柱状图" }));
    expect(screen.getByText("未保存")).toBeVisible();
    expect(requests).toHaveLength(0);
    await user.click(within(chart).getByRole("button", { name: "面积图" }));
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
    expect(screen.queryByText("未保存")).not.toBeInTheDocument();
    await user.click(within(chart).getByRole("button", { name: "柱状图" }));
    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(saved));
    expect(requests).toHaveLength(1);
    expect(await requests[0]!.json()).toMatchObject({ revision: settings.revision, dashboard_chart_type: "BAR" });
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
  });

  it("preserves an explicitly edited chart when the settings revision and remote default change", async () => {
    const requests: Request[] = [];
    const latest: RuntimeSettings = { ...settings, revision: settings.revision + 2,
      display: { ...settings.display, dashboard_chart_type: "LINE" } };
    const saved: RuntimeSettings = { ...latest, revision: latest.revision + 1,
      display: { ...latest.display, dashboard_chart_type: "BAR" } };
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => { requests.push(request); return json({ data: saved }); }));
    const { onSaved, updateSettings } = mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "柱状图" }));
    updateSettings(latest);
    expect(screen.getByRole("button", { name: "柱状图" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(saved));
    expect(await requests[0]!.json()).toMatchObject({ revision: latest.revision, dashboard_chart_type: "BAR" });
  });

  it("recognizes restored defaults without making a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "柱状图" }));
    expect(screen.getByText("未保存")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "面积图" }));
    const name = screen.getByRole("textbox", { name: "系统名称" });
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
    const name = screen.getByRole("textbox", { name: "系统名称" });
    await user.clear(name);
    await user.type(name, "尚未保存的名称");
    await user.click(screen.getByRole("button", { name: "柱状图" }));
    await user.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByRole("alert");
    expect(name).toHaveValue("尚未保存的名称");
    expect(screen.getByRole("button", { name: "柱状图" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("未保存")).toBeVisible();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("toggles dashboard sections, locks the last remaining module, and submits edited visibility", async () => {
    const requests: Request[] = [];
    const expectedSections = {
      summary_cards: true,
      trend: false,
      site_overview: false,
      work_items: false,
      recent_orders: false,
    };
    const saved: RuntimeSettings = {
      ...settings,
      revision: settings.revision + 1,
      display: {
        ...settings.display,
        dashboard_sections: expectedSections,
      },
    };
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
      requests.push(request);
      return json({ data: saved });
    }));
    const { onSaved } = mount();
    const user = userEvent.setup();
    const sections = screen.getByRole("group", { name: "总览显示模块" });

    // Toggle off and back on restores clean state without network calls.
    await user.click(within(sections).getByRole("switch", { name: "收款趋势" }));
    expect(screen.getByText("未保存")).toBeVisible();
    await user.click(within(sections).getByRole("switch", { name: "收款趋势" }));
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();

    // Turning off 4 modules locks the last enabled switch so at least 1 remains on.
    for (const label of ["收款趋势", "各网站概览", "待处理", "最近订单"]) {
      await user.click(within(sections).getByRole("switch", { name: label }));
    }
    const lastSwitch = within(sections).getByRole("switch", { name: "核心指标" });
    expect(lastSwitch).toBeChecked();
    expect(lastSwitch).toHaveAttribute("aria-disabled", "true");
    await user.click(lastSwitch);
    expect(lastSwitch).toBeChecked();

    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(saved));
    expect(requests).toHaveLength(1);
    expect(await requests[0]!.json()).toMatchObject({
      revision: settings.revision,
      dashboard_sections: expectedSections,
    });
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
  });

  it("preserves remote dashboard sections when only editing system name", async () => {
    const requests: Request[] = [];
    const remoteSections = {
      summary_cards: true,
      trend: false,
      site_overview: true,
      work_items: true,
      recent_orders: false,
    };
    const latest: RuntimeSettings = {
      ...settings,
      revision: settings.revision + 1,
      display: {
        ...settings.display,
        dashboard_sections: remoteSections,
      },
    };
    const saved: RuntimeSettings = {
      ...latest,
      revision: latest.revision + 1,
      display: {
        ...latest.display,
        system_name: "新名称",
      },
    };
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
      requests.push(request);
      return json({ data: saved });
    }));
    const { onSaved, updateSettings } = mount();
    const user = userEvent.setup();
    const name = screen.getByRole("textbox", { name: "系统名称" });
    await user.clear(name);
    await user.type(name, "新名称");
    updateSettings(latest);
    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(saved));
    expect(await requests[0]!.json()).toEqual({
      revision: latest.revision,
      system_name: "新名称",
      dashboard_chart_type: "AREA",
      dashboard_sections: remoteSections,
    });
  });

  it("edits and restores the global 404 checkout copy", async () => {
    const requests: Request[] = [];
    const customDetail = "订单已失效，请联系客服重新获取支付链接。";
    const initial: RuntimeSettings = {
      ...settings,
      display: {
        ...settings.display,
        checkout_not_found_detail: customDetail,
      },
    };
    const cleared: RuntimeSettings = {
      ...initial,
      revision: initial.revision + 1,
      display: {
        ...initial.display,
        checkout_not_found_detail: null,
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        requests.push(request);
        return json({ data: cleared });
      }),
    );
    const { onSaved } = mount(initial);
    const user = userEvent.setup();
    const field = screen.getByRole("textbox", { name: "订单不存在（404）说明" });
    expect(field).toHaveValue(customDetail);
    await user.click(screen.getByRole("button", { name: "恢复默认" }));
    expect(field).toHaveValue("");
    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(cleared));
    expect(await requests[0]!.json()).toMatchObject({
      revision: initial.revision,
      checkout_not_found_detail: null,
    });
  });
});
