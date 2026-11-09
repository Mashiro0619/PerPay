import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { queryClient } from "../src/api/client";
import { AdminAccessSettings } from "../src/pages/AdminAccessSettings";
import { json, settings } from "./fixtures";
function mount() {
  const onSaved = vi.fn();
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AdminAccessSettings settings={settings} onSaved={onSaved} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return onSaved;
}
describe("admin access settings", () => {
  it("links to recovery documentation instead of displaying deployment commands", () => {
    queryClient.setQueryData(["admin-access-source"], {
      data: { revision: settings.revision, ...settings.admin_access, current_ip: "192.0.2.1" },
    });
    mount();
    const help = screen.getByRole("link", { name: "查看恢复方法" });
    expect(help).toHaveAttribute("href", "https://github.com/Mashiro0619/PerPay/blob/main/docs/maintenance.md#管理员-ip-白名单与离线恢复");
    expect(help).toHaveAttribute("target", "_blank");
    expect(help).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByText(/IP 变化可能导致无法登录，可通过服务器恢复访问/)).toBeVisible();
    expect(screen.queryByText(/PERPAY_TRUSTED_PROXY_CIDRS/)).not.toBeInTheDocument();
    expect(screen.queryByText(/disable-admin-allowlist/)).not.toBeInTheDocument();
    expect(screen.queryByText(/先停止 app/)).not.toBeInTheDocument();
  });
  it("adds current IP and confirms before saving", async () => {
    const requests: Request[] = [];
    const saved = {
      ...settings,
      revision: 4,
      admin_access: { enabled: true, cidrs: ["192.0.2.1"] },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        requests.push(request);
        return json({
          data:
            request.method === "GET"
              ? {
                  revision: 3,
                  enabled: false,
                  cidrs: [],
                  current_ip: "192.0.2.1",
                }
              : saved,
        });
      }),
    );
    const onSaved = mount();
    const user = userEvent.setup();
    await screen.findByText("当前识别 IP：192.0.2.1");
    await user.click(screen.getByRole("button", { name: "加入当前 IP" }));
    await user.click(screen.getByRole("switch", { name: "启用 IP 白名单" }));
    await user.click(screen.getByRole("button", { name: "保存白名单" }));
    expect(requests.filter((r) => r.method === "PUT")).toHaveLength(0);
    const confirmation = screen.getByRole("dialog", { name: "确认保存访问规则？" });
    const explanation = within(confirmation).getByText(/保存立即生效/);
    expect(explanation.closest("[data-admin-dialog-body]")).not.toBeNull();
    expect(confirmation).toHaveAccessibleDescription(explanation.textContent ?? "");
    await user.click(screen.getByRole("button", { name: "确认保存" }));
    await waitFor(() =>
      expect(onSaved).toHaveBeenCalledWith(saved, "管理员 IP 白名单已保存"),
    );
    expect(await requests.find((r) => r.method === "PUT")!.json()).toEqual({
      revision: 3,
      enabled: true,
      cidrs: ["192.0.2.1"],
    });
  });
  it("retains draft and shows field error after server rejection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) =>
        request.method === "GET"
          ? json({
              data: {
                revision: 3,
                enabled: false,
                cidrs: [],
                current_ip: "192.0.2.1",
              },
            })
          : json(
              {
                error: {
                  code: "validation_failed",
                  message: "规则无效",
                  fields: { cidrs: "必须允许当前 IP" },
                },
              },
              422,
            ),
      ),
    );
    mount();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("允许的 IP / 网段"), "198.51.100.1");
    await user.click(screen.getByRole("button", { name: "保存白名单" }));
    await user.click(screen.getByRole("button", { name: "确认保存" }));
    await screen.findByText("必须允许当前 IP");
    expect(screen.getByLabelText("允许的 IP / 网段")).toHaveValue(
      "198.51.100.1",
    );
    await user.type(screen.getByLabelText("允许的 IP / 网段"), "\n192.0.2.1");
    expect(screen.queryByText("必须允许当前 IP")).not.toBeInTheDocument();
    expect(screen.getByLabelText("允许的 IP / 网段")).toHaveAttribute("aria-invalid", "false");
  });
  it("does not queue offline saves and retains the edited rules", async () => {
    const writes: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        if (request.method === "PUT") writes.push(request);
        return json({
          data: {
            revision: 3,
            enabled: false,
            cidrs: [],
            current_ip: "192.0.2.1",
          },
        });
      }),
    );
    mount();
    const user = userEvent.setup();
    await screen.findByText("当前识别 IP：192.0.2.1");
    await user.click(screen.getByRole("button", { name: "加入当前 IP" }));
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    await user.click(screen.getByRole("button", { name: "保存白名单" }));
    await user.click(screen.getByRole("button", { name: "确认保存" }));
    await screen.findByText("网络已断开，白名单未提交。恢复连接后请重新提交。");
    expect(writes).toHaveLength(0);
    expect(screen.getByLabelText("允许的 IP / 网段")).toHaveValue("192.0.2.1");
  });
  it("重读冲突版本后保留本地规则并采用服务器修改的开关和当前 IP", async () => {
    let access = { revision: settings.revision, ...settings.admin_access, current_ip: "192.0.2.1" };
    const writes: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
      if (request.method === "GET") return json({ data: access });
      const body = await request.json();
      writes.push(body);
      if (body.revision !== access.revision)
        return json({ error: { code: "settings_revision_conflict" } }, 409);
      return json({ data: { ...settings, revision: access.revision + 1, admin_access: { enabled: body.enabled, cidrs: body.cidrs } } });
    }));
    const onSaved = mount();
    const user = userEvent.setup();
    await screen.findByText("当前识别 IP：192.0.2.1");
    await user.type(screen.getByLabelText("允许的 IP / 网段"), "192.0.2.1\n198.51.100.9");
    access = { ...access, revision: settings.revision + 1, enabled: true, current_ip: "198.51.100.9" };
    await user.click(screen.getByRole("button", { name: "保存白名单" }));
    await user.click(screen.getByRole("button", { name: "确认保存" }));
    expect(await screen.findByRole("button", { name: "重新读取配置" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "保存白名单" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "重新读取配置" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "保存白名单" })).toBeEnabled());
    expect(screen.getByLabelText("允许的 IP / 网段")).toHaveValue("192.0.2.1\n198.51.100.9");
    expect(screen.getByRole("switch", { name: "启用 IP 白名单" })).toBeChecked();
    expect(screen.getByText("当前识别 IP：198.51.100.9")).toBeVisible();
    expect(writes).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "保存白名单" }));
    await user.click(screen.getByRole("button", { name: "确认保存" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(writes[1]).toEqual({ revision: settings.revision + 1, enabled: true, cidrs: ["192.0.2.1", "198.51.100.9"] });
  });
  it.each(["保留我的修改", "采用服务器值"])("双边规则冲突必须核对后%s", async choice => {
    let access = { revision: settings.revision, ...settings.admin_access, current_ip: "192.0.2.1" };
    const writes: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
      if (request.method === "GET") return json({ data: access });
      writes.push(await request.json());
      return json({ error: { code: "settings_revision_conflict" } }, 409);
    }));
    mount();
    const user = userEvent.setup();
    await screen.findByText("当前识别 IP：192.0.2.1");
    await user.type(screen.getByLabelText("允许的 IP / 网段"), "198.51.100.10");
    access = { ...access, revision: settings.revision + 1, cidrs: ["192.0.2.1"] };
    await user.click(screen.getByRole("button", { name: "保存白名单" }));
    await user.click(screen.getByRole("button", { name: "确认保存" }));
    await user.click(await screen.findByRole("button", { name: "重新读取配置" }));
    await screen.findByText("访问规则存在不同修改");
    expect(screen.getByRole("button", { name: "保存白名单" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "应用核对结果" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: choice }));
    await user.click(screen.getByRole("button", { name: "应用核对结果" }));
    expect(screen.getByLabelText("允许的 IP / 网段")).toHaveValue(choice === "保留我的修改" ? "198.51.100.10" : "192.0.2.1");
    expect(writes).toHaveLength(1);
    if (choice === "保留我的修改") expect(screen.getByRole("button", { name: "保存白名单" })).toBeEnabled();
    else expect(screen.getByRole("button", { name: "保存白名单" })).toBeDisabled();
  });
  it("使用最新白名单响应建立草稿，重读时保留本地开关与服务器规则", async () => {
    let access = { revision: settings.revision + 1, enabled: false, cidrs: ["192.0.2.1"], current_ip: "192.0.2.1" };
    const writes: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
      if (request.method === "GET") return json({ data: access });
      const body = await request.json();
      writes.push(body);
      if (body.revision !== access.revision)
        return json({ error: { code: "settings_revision_conflict" } }, 409);
      return json({ data: { ...settings, revision: access.revision + 1, admin_access: { enabled: body.enabled, cidrs: body.cidrs } } });
    }));
    const onSaved = mount();
    const user = userEvent.setup();
    await screen.findByText("当前识别 IP：192.0.2.1");
    expect(screen.getByLabelText("允许的 IP / 网段")).toHaveValue("192.0.2.1");
    await user.click(screen.getByRole("switch", { name: "启用 IP 白名单" }));
    access = { ...access, revision: settings.revision + 2, cidrs: ["192.0.2.1", "198.51.100.9"] };
    await user.click(screen.getByRole("button", { name: "保存白名单" }));
    await user.click(screen.getByRole("button", { name: "确认保存" }));
    await user.click(await screen.findByRole("button", { name: "重新读取配置" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "保存白名单" })).toBeEnabled());
    expect(screen.getByRole("switch", { name: "启用 IP 白名单" })).toBeChecked();
    expect(screen.getByLabelText("允许的 IP / 网段")).toHaveValue("192.0.2.1\n198.51.100.9");
    await user.click(screen.getByRole("button", { name: "保存白名单" }));
    await user.click(screen.getByRole("button", { name: "确认保存" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(writes).toEqual([
      { revision: settings.revision + 1, enabled: true, cidrs: ["192.0.2.1"] },
      { revision: settings.revision + 2, enabled: true, cidrs: ["192.0.2.1", "198.51.100.9"] },
    ]);
  });
  it("重读失败时保留草稿和旧版本，成功后才恢复保存", async () => {
    let failRead = false;
    const writes: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
      if (request.method === "GET") return failRead
        ? json({ error: { code: "temporarily_unavailable", message: "读取失败" } }, 503)
        : json({ data: { revision: settings.revision, ...settings.admin_access, current_ip: "192.0.2.1" } });
      writes.push(await request.json());
      return json({ error: { code: "settings_revision_conflict" } }, 409);
    }));
    mount();
    const user = userEvent.setup();
    await screen.findByText("当前识别 IP：192.0.2.1");
    await user.type(screen.getByLabelText("允许的 IP / 网段"), "198.51.100.10");
    await user.click(screen.getByRole("button", { name: "保存白名单" }));
    await user.click(screen.getByRole("button", { name: "确认保存" }));
    failRead = true;
    await user.click(await screen.findByRole("button", { name: "重新读取配置" }));
    await screen.findByText("读取失败");
    expect(screen.getByLabelText("允许的 IP / 网段")).toHaveValue("198.51.100.10");
    expect(screen.getByRole("button", { name: "保存白名单" })).toBeDisabled();
    expect(writes).toHaveLength(1);
    failRead = false;
    await user.click(screen.getByRole("button", { name: "重新读取配置" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "保存白名单" })).toBeEnabled());
  });
});
