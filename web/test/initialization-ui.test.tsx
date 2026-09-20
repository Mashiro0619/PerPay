import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { queryClient } from "../src/api/client";
import { AuthPage } from "../src/auth";
import { apiError } from "./fixtures";

function mount(initialized: string | null, path = "/login") {
  if (initialized !== null) {
    const meta = document.createElement("meta");
    meta.name = "perpay-initialized";
    meta.content = initialized;
    document.head.append(meta);
  }
  const onLogin = vi.fn();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <AuthPage onLogin={onLogin} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...view, onLogin };
}

describe("first-deployment authentication presentation", () => {
  it.each(["/", "/login", "/setup"])(
    "shows only normal login after initialization at %s",
    (path) => {
      mount("true", path);
      expect(
        screen.getByRole("heading", { name: "登录管理后台" }),
      ).toBeVisible();
      expect(screen.getByLabelText("管理员密码")).toBeRequired();
      expect(
        screen.queryByRole("link", { name: /初始化|已有管理员/ }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "创建管理员" }),
      ).not.toBeInTheDocument();
    },
  );

  it.each(["/", "/login", "/setup"])(
    "makes initialization the primary page for a new instance at %s",
    (path) => {
      mount("false", path);
      expect(
        screen.getByRole("heading", { name: "初始化 PerPay", level: 1 }),
      ).toBeVisible();
      expect(
        screen.getByText(
          "首次部署，请先创建管理员。完成后登录，继续配置收款。",
        ),
      ).toBeVisible();
      expect(
        screen.getByRole("button", { name: "创建管理员" }),
      ).toHaveAttribute("type", "submit");
      expect(screen.getByLabelText("设置管理员密码")).toBeRequired();
      expect(screen.getByLabelText("再次输入密码")).toBeRequired();
      expect(
        screen.queryByRole("link", { name: /初始化|已有管理员/ }),
      ).not.toBeInTheDocument();
      expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "登录" }),
      ).not.toBeInTheDocument();
    },
  );

  it.each([null, "", "__PERPAY_INITIALIZED__", "unknown"])(
    "does not infer initialization from an unknown state: %s",
    (state) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const { container } = mount(state, "/setup");
      expect(
        screen.getByRole("heading", { name: "无法确认实例状态" }),
      ).toBeVisible();
      expect(screen.getByRole("button", { name: "重试" })).toBeEnabled();
      expect(container.querySelector("form")).toBeNull();
      expect(
        screen.queryByRole("link", { name: /初始化/ }),
      ).not.toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("closes a stale setup page when another client has already initialized the instance", async () => {
    const requests: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        requests.push(request);
        if (new URL(request.url).pathname.endsWith("/setup"))
          return apiError(
            "identity_already_initialized",
            "系统已经初始化",
            409,
          );
        return new Response(null, { status: 204 });
      }),
    );
    const { onLogin } = mount("false", "/setup");
    const user = userEvent.setup();
    await user.type(
      screen.getByLabelText("设置管理员密码"),
      "new-admin-password",
    );
    await user.type(
      screen.getByLabelText("再次输入密码"),
      "new-admin-password",
    );
    await user.click(screen.getByRole("button", { name: "创建管理员" }));
    await screen.findByRole("heading", { name: "登录管理后台" });
    expect(
      screen.getByText("此实例已完成初始化，请使用现有管理员密码登录。"),
    ).toBeVisible();
    expect(screen.getByLabelText("管理员密码")).toHaveValue("");
    expect(screen.queryByLabelText("再次输入密码")).not.toBeInTheDocument();
    expect(screen.queryByText("管理员已创建")).not.toBeInTheDocument();
    expect(
      document.querySelector('meta[name="perpay-initialized"]'),
    ).toHaveAttribute("content", "true");
    expect(onLogin).not.toHaveBeenCalled();
    await user.type(
      screen.getByLabelText("管理员密码"),
      "existing-admin-password",
    );
    await user.click(screen.getByRole("button", { name: "登录" }));
    await waitFor(() => expect(onLogin).toHaveBeenCalledOnce());
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/api/admin/v1/setup",
      "/api/admin/v1/session/login",
    ]);
    expect(await requests[1]!.json()).toEqual({
      password: "existing-admin-password",
    });
  });

  it("keeps a recoverable setup failure on the initialization form without marking it initialized", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => apiError("temporarily_unavailable", "请稍后重试", 503)),
    );
    mount("false", "/login");
    const user = userEvent.setup();
    await user.type(
      screen.getByLabelText("设置管理员密码"),
      "new-admin-password",
    );
    await user.type(
      screen.getByLabelText("再次输入密码"),
      "new-admin-password",
    );
    await user.click(screen.getByRole("button", { name: "创建管理员" }));
    await screen.findByText("请稍后重试");
    expect(
      screen.getByRole("heading", { name: "初始化 PerPay" }),
    ).toBeVisible();
    expect(screen.getByLabelText("设置管理员密码")).toHaveValue(
      "new-admin-password",
    );
    expect(
      document.querySelector('meta[name="perpay-initialized"]'),
    ).toHaveAttribute("content", "false");
  });
});
