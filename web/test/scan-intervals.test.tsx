import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { queryClient, type RuntimeSettings } from "../src/api/client";
import { SettingsEditor } from "../src/components/SettingsForms";
import { json } from "./fixtures";
import { configuredThrough } from "./onboarding-fixture";

function renderEditor(settings: RuntimeSettings, onSaved = vi.fn()) {
  return render(<QueryClientProvider client={queryClient}><MemoryRouter>
    <SettingsEditor section="provider" settings={settings} onSaved={onSaved} />
  </MemoryRouter></QueryClientProvider>);
}

describe("adaptive ledger scan settings", () => {
  it("defaults new provider setup to 30s normal and 5s active without a tail setting", () => {
    renderEditor(configuredThrough(1));
    const normal = screen.getByLabelText("常规采集间隔（秒）");
    const active = screen.getByLabelText("活跃采集间隔（秒）");
    expect(normal).toHaveValue(30);
    expect(active).toHaveValue(5);
    expect(active).toHaveAttribute("min", "5");
    expect(active).toHaveAttribute("max", "3600");
    expect(active).toHaveAttribute("step", "1");
    expect(active).toHaveAccessibleDescription(/收尾至少 60 秒/);
    expect(screen.queryByLabelText(/收尾.*秒/)).not.toBeInTheDocument();
    fireEvent.change(active, { target: { value: "4" } });
    expect(active).not.toBeValid();
  });

  it("preserves the migrated fixed frequency instead of silently adopting new defaults", () => {
    renderEditor(configuredThrough(2));
    expect(screen.getByLabelText("常规采集间隔（秒）")).toHaveValue(10);
    expect(screen.getByLabelText("活跃采集间隔（秒）")).toHaveValue(10);
  });

  it("submits both custom intervals and keeps the existing configuration revision", async () => {
    const settings = configuredThrough(2);
    const saved = { ...settings, revision: settings.revision + 1, provider: {
      ...settings.provider!, scan_interval_seconds: 30, active_scan_interval_seconds: 5,
    } };
    const fetchMock = vi.fn(async (_request: Request) => json({ data: saved }));
    vi.stubGlobal("fetch", fetchMock);
    const onSaved = vi.fn();
    renderEditor(settings, onSaved);
    fireEvent.change(screen.getByLabelText("常规采集间隔（秒）"), { target: { value: "30" } });
    fireEvent.change(screen.getByLabelText("活跃采集间隔（秒）"), { target: { value: "5" } });
    await userEvent.setup().click(screen.getByRole("button", { name: "保存配置" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0]![0];
    expect(request.method).toBe("PUT");
    expect(new URL(request.url).pathname).toBe("/api/admin/v1/settings/provider");
    expect(await request.json()).toMatchObject({
      revision: settings.revision, scan_interval_seconds: 30, active_scan_interval_seconds: 5,
      safety_lag_seconds: 10, maximum_success_age_seconds: 60,
    });
  });

  it("locates an active interval longer than normal without losing the draft or sending a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderEditor(configuredThrough(2));
    const active = screen.getByLabelText("活跃采集间隔（秒）");
    fireEvent.change(active, { target: { value: "30" } });
    await userEvent.setup().click(screen.getByRole("button", { name: "保存配置" }));
    await waitFor(() => expect(active).toHaveFocus());
    expect(active).toHaveAccessibleDescription(/活跃采集间隔不能大于常规采集间隔/);
    expect(active).toHaveValue(30);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires freshness to cover twice the normal interval even with a short active interval", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderEditor(configuredThrough(2));
    fireEvent.change(screen.getByLabelText("常规采集间隔（秒）"), { target: { value: "60" } });
    fireEvent.change(screen.getByLabelText("活跃采集间隔（秒）"), { target: { value: "5" } });
    await userEvent.setup().click(screen.getByRole("button", { name: "保存配置" }));
    const freshness = screen.getByLabelText("采集有效时限（秒）");
    await waitFor(() => expect(freshness).toHaveFocus());
    expect(freshness).toHaveAccessibleDescription(/至少为常规采集间隔的两倍/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
