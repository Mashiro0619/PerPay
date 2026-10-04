import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
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
});
