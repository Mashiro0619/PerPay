import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { queryClient } from "../src/api/client";
import { AuthPage } from "../src/auth";
import { apiError } from "./fixtures";

const setupToken = "synthetic-initialization-token";

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
  it("uses a non-link disclosure for password recovery while keeping its help link", async () => {
    mount("true");
    const user = userEvent.setup();
    const trigger = screen.getByRole("button", { name: "忘记密码？" });
    expect(trigger).not.toHaveClass("hover:underline");
    expect(trigger).toHaveClass("focus-visible:ring-3");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("link", { name: "查看恢复步骤" })).toHaveAttribute(
      "href",
      "https://github.com/Mashiro0619/PerPay/blob/main/docs/maintenance.md#忘记管理员密码",
    );
    trigger.focus();
    await user.keyboard("{Enter}");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    await user.keyboard(" ");
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });

  it.each(["/", "/login", "/setup"])(
    "shows only normal login after initialization at %s",
    (path) => {
      mount("true", path);
      expect(
        screen.getByRole("heading", { name: "登录管理后台" }),
      ).toBeVisible();
      expect(screen.getByLabelText("管理员密码")).toBeRequired();
      expect(screen.queryByLabelText("一次性初始化令牌")).not.toBeInTheDocument();
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
          "先创建管理员，再登录配置收款。",
        ),
      ).toBeVisible();
      expect(
        screen.getByRole("button", { name: "创建管理员" }),
      ).toHaveAttribute("type", "submit");
      expect(screen.getByLabelText("设置管理员密码")).toBeRequired();
      expect(screen.getByLabelText("再次输入密码")).toBeRequired();
      expect(screen.getByLabelText("一次性初始化令牌")).toBeRequired();
      expect(
        screen.queryByRole("link", { name: /初始化|已有管理员/ }),
      ).not.toBeInTheDocument();
      expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "登录" }),
      ).not.toBeInTheDocument();
    },
  );

  it("requires an initialization token before sending credentials to setup", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    mount("false", "/setup");
    const user = userEvent.setup();
    const token = screen.getByLabelText("一次性初始化令牌");
    expect(token).toHaveAttribute("type", "password");
    expect(token).toHaveAttribute("autocomplete", "off");
    expect(token).toHaveAccessibleDescription(/服务器启动日志.*docker compose logs app.*setup_token/);
    fireEvent.change(screen.getByLabelText("设置管理员密码"), { target: { value: "new-admin-password" } });
    fireEvent.change(screen.getByLabelText("再次输入密码"), { target: { value: "new-admin-password" } });
    await user.click(screen.getByRole("button", { name: "创建管理员" }));
    expect(token).toHaveAttribute("aria-invalid", "true");
    expect(token).toHaveAccessibleDescription("请输入服务器启动日志中的初始化令牌。");
    expect(token).toHaveFocus();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("associates a rejected token with its field and retries without persisting it or forwarding it to login", async () => {
    const requests: Request[] = [];
    let rejectToken = true;
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
      requests.push(request);
      if (new URL(request.url).pathname.endsWith("/setup") && rejectToken) {
        rejectToken = false;
        return apiError("setup_token_invalid", "初始化令牌无效", 403);
      }
      return new Response(null, { status: 204 });
    }));
    const { onLogin } = mount("false", "/setup");
    const user = userEvent.setup();
    const token = screen.getByLabelText("一次性初始化令牌");
    fireEvent.change(token, { target: { value: "synthetic-stale-token" } });
    fireEvent.change(screen.getByLabelText("设置管理员密码"), { target: { value: "new-admin-password" } });
    fireEvent.change(screen.getByLabelText("再次输入密码"), { target: { value: "new-admin-password" } });
    await user.click(screen.getByRole("button", { name: "创建管理员" }));
    await waitFor(() => expect(token).toHaveAccessibleDescription("初始化令牌无效或已失效，请从服务器最新启动日志重新获取。"));
    expect(token).toHaveFocus();
    expect(token).toBeEnabled();
    expect(token).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("设置管理员密码")).toHaveValue("new-admin-password");
    expect(screen.queryByRole("button", { name: "错误详情" })).not.toBeInTheDocument();
    expect(document.querySelector('meta[name="perpay-initialized"]')).toHaveAttribute("content", "false");

    fireEvent.change(token, { target: { value: setupToken } });
    expect(token).not.toHaveAttribute("aria-invalid", "true");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "创建管理员" }));
    await screen.findByRole("heading", { name: "登录管理后台" });
    expect(screen.queryByLabelText("一次性初始化令牌")).not.toBeInTheDocument();
    expect(screen.getByLabelText("管理员密码")).toHaveValue("");
    expect(onLogin).not.toHaveBeenCalled();
    expect(await requests[1]!.clone().json()).toEqual({ password: "new-admin-password", setup_token: setupToken });
    expect(requests.every(request => !request.url.includes(setupToken))).toBe(true);
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain(setupToken);
    fireEvent.change(screen.getByLabelText("管理员密码"), { target: { value: "new-admin-password" } });
    await user.click(screen.getByRole("button", { name: "登录" }));
    await waitFor(() => expect(onLogin).toHaveBeenCalledOnce());
    expect(await requests[2]!.json()).toEqual({ password: "new-admin-password" });
  });

  it.each([null, "", "__PERPAY_INITIALIZED__", "unknown"])(
    "does not infer initialization from an unknown state: %s",
    (state) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const { container } = mount(state, "/setup");
      expect(
        screen.getByRole("heading", { name: "无法确认系统状态" }),
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
    await user.type(screen.getByLabelText("一次性初始化令牌"), setupToken);
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
      screen.getByText("系统已初始化，请用现有管理员密码登录。"),
    ).toBeVisible();
    expect(screen.getByLabelText("管理员密码")).toHaveValue("");
    expect(screen.queryByLabelText("再次输入密码")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("一次性初始化令牌")).not.toBeInTheDocument();
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
    await user.type(screen.getByLabelText("一次性初始化令牌"), setupToken);
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
    expect(screen.getByLabelText("一次性初始化令牌")).toHaveValue(setupToken);
    expect(
      document.querySelector('meta[name="perpay-initialized"]'),
    ).toHaveAttribute("content", "false");
  });
});
