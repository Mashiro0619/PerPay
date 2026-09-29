import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { queryClient } from "../src/api/client";
import { SettingsEditor } from "../src/components/SettingsForms";
import { json, settings } from "./fixtures";

function mount() {
  const onSaved = vi.fn();
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <SettingsEditor section="advanced" settings={settings} onSaved={onSaved} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return onSaved;
}

describe("advanced checkout settings clarity", () => {
  it("explains link-key rotation and keeps the repeated legend screen-reader-only", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    mount();
    expect(screen.getByRole("heading", { name: "高级设置" })).toBeVisible();
    const fields = screen.getByRole("group", { name: "高级设置" });
    expect(within(fields).getByText("高级设置")).toHaveClass("sr-only");
    const rotation = screen.getByLabelText("收银台链接密钥轮换周期（天）");
    expect(rotation).toHaveValue(90);
    expect(rotation).toHaveAccessibleDescription(
      "自动更新用于生成收银台链接的内部密钥，不影响已有订单链接；通常无需修改。",
    );
    expect(screen.getByLabelText("终态观察期（秒）")).toHaveValue(86400);
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the existing advanced-settings request and values when explicitly saved", async () => {
    const requests: Request[] = [];
    const saved = {
      ...settings,
      revision: settings.revision + 1,
      advanced: { ...settings.advanced, checkout_key_rotation_days: 120 },
    };
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
      requests.push(request);
      return json({ data: saved });
    }));
    const onSaved = mount();
    const user = userEvent.setup();
    const rotation = screen.getByLabelText("收银台链接密钥轮换周期（天）");
    await user.clear(rotation);
    await user.type(rotation, "120");
    expect(requests).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(saved));
    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("PUT");
    expect(new URL(requests[0]!.url).pathname).toBe("/api/admin/v1/settings/advanced");
    expect(await requests[0]!.json()).toEqual({
      revision: settings.revision,
      checkout_key_rotation_days: 120,
      checkout_terminal_observation_seconds: 86400,
    });
  });
});
