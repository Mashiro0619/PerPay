import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

import { queryClient } from "../src/api/client";
import { AuthBoundary, AuthPage } from "../src/auth";
import { ReasonDialog } from "../src/components/ReasonDialog";
import { FinancialDialog } from "../src/pages/FinancialDialog";
import { SecuritySettings } from "../src/pages/SecuritySettings";
import Settings from "../src/pages/Settings";
import { apiError, json, ledger, ledgerId, order, orderId, settings } from "./fixtures";

function renderPage(children: ReactNode, path = "/") {
  return render(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={[path]}>{children}</MemoryRouter></QueryClientProvider>);
}

function initialization(value: string) {
  const meta = document.createElement("meta");
  meta.name = "perpay-initialized";
  meta.content = value;
  document.head.append(meta);
}

describe("administrator authentication", () => {
  it.each(["aB3!xY", "🔐".repeat(6)])("accepts six-character setup password %s and asks for a separate login", async (password) => {
    initialization("false");
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const onLogin = vi.fn();
    const user = userEvent.setup();
    renderPage(<AuthPage onLogin={onLogin} />, "/setup");
    expect(screen.getByText("为这个实例设置管理员密码。初始化完成后，此入口会永久关闭。")).toBeVisible();
    expect(screen.getByText("至少 6 个字符，建议使用密码管理器生成并保存。")).toBeVisible();
    await user.type(screen.getByLabelText(/设置管理员密码/), "short");
    await user.type(screen.getByLabelText("再次输入密码"), "short");
    await user.click(screen.getByRole("button", { name: "创建管理员" }));
    expect(await screen.findByText("密码至少需要 6 个字符。")).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();
    await user.clear(screen.getByLabelText(/设置管理员密码/));
    await user.clear(screen.getByLabelText("再次输入密码"));
    await user.type(screen.getByLabelText(/设置管理员密码/), password);
    await user.type(screen.getByLabelText("再次输入密码"), password);
    await user.click(screen.getByRole("button", { name: "创建管理员" }));
    expect(await screen.findByRole("heading", { name: "登录管理后台" })).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onLogin).not.toHaveBeenCalled();
  });

  it("does not expose a setup form after initialization", () => {
    initialization("true");
    renderPage(<AuthPage onLogin={vi.fn()} />, "/setup");
    expect(screen.getByRole("heading", { name: "登录管理后台" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "创建管理员" })).not.toBeInTheDocument();
  });

  it.each(["aB3!xY", "🔐".repeat(6)])("validates a six-character replacement password %s before saving", async (password) => {
    const fetchMock = vi.fn(async (_request: Request) => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    renderPage(<SecuritySettings settings={settings} onSaved={vi.fn()} />);
    const field = screen.getByLabelText("新密码");
    const confirmation = screen.getByLabelText("再次输入新密码");
    const short = Array.from(password).slice(0, 5).join("");
    expect(field).toHaveAccessibleDescription("至少 6 个字符。");
    fireEvent.change(field, { target: { value: short } });
    fireEvent.change(confirmation, { target: { value: short } });
    const user = userEvent.setup();
    await user.click(screen.getByRole("checkbox", { name: "已保存新密码，并了解所有会话将被注销。" }));
    await user.click(screen.getByRole("button", { name: "修改密码并重新登录" }));
    expect(screen.getByText("密码至少需要 6 个字符。")).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: password } });
    fireEvent.change(confirmation, { target: { value: password } });
    await user.click(screen.getByRole("button", { name: "修改密码并重新登录" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const request = fetchMock.mock.calls[0]![0];
    expect(new URL(request.url).pathname).toBe("/api/admin/v1/password");
    expect(await request.clone().json()).toEqual({ new_password: password });
    await waitFor(() => expect(field).toHaveValue(""));
  });

  it.each(["login", "setup"])("uses a text-only brand while preserving authentication controls on %s", (page) => {
    initialization(page === "setup" ? "false" : "true");
    const { container } = renderPage(<AuthPage onLogin={vi.fn()} />, "/" + page);
    const brand = screen.getByRole("link", { name: "PerPay" });
    expect(brand).toHaveAttribute("href", "/");
    expect(brand.querySelector("img, svg")).toBeNull();
    expect(screen.getByRole("heading", { name: /每一笔收款/ })).toHaveTextContent("每一笔收款，都有据可查。");
    expect(container.querySelectorAll(".auth-statement br")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "显示密码" }).querySelector("svg")).not.toBeNull();
  });

  it("keeps login labels without redundant decorations or implementation notes", () => {
    initialization("true");
    const { container } = renderPage(<AuthPage onLogin={vi.fn()} />, "/login");
    expect(screen.getByRole("heading", { name: "登录管理后台" })).toBeVisible();
    expect(screen.getByRole("heading", { name: /每一笔收款/ })).toBeVisible();
    expect(screen.getByLabelText("管理员密码")).toBeRequired();
    expect(screen.queryByText("为个人开发者而建")).not.toBeInTheDocument();
    expect(screen.queryByText("密码不会保存在浏览器中")).not.toBeInTheDocument();
    expect(container.querySelector(".auth-emblem")).toBeNull();
    expect(container.querySelector(".auth-process")).toBeNull();
    expect(screen.queryByText(/经营码收款，账本自动核对/)).not.toBeInTheDocument();
    expect(screen.queryByText("你的实例，你的数据。")).not.toBeInTheDocument();
    expect(screen.queryByText("使用管理员密码，查看收款与实例状态。")).not.toBeInTheDocument();
    expect(screen.queryByText("此实例只有一个管理员账户，无需输入用户名。")).not.toBeInTheDocument();
  });

  it("preserves an unsuccessful login and never sends a username field", async () => {
    initialization("true");
    const fetchMock = vi.fn(async () => apiError("invalid_credentials", "管理员密码错误", 401));
    vi.stubGlobal("fetch", fetchMock);
    const onLogin = vi.fn();
    const user = userEvent.setup();
    renderPage(<AuthPage onLogin={onLogin} />, "/login");
    await user.type(screen.getByLabelText(/管理员密码/), "incorrect-test-password");
    await user.click(screen.getByRole("button", { name: "登录" }));
    expect(await screen.findByText("管理员密码错误")).toBeVisible();
    const request = (fetchMock.mock.calls as unknown as Array<[Request]>)[0]![0];
    expect(await request.json()).toEqual({ password: "incorrect-test-password" });
    expect(onLogin).not.toHaveBeenCalled();
  });

  it("clears cached business data when a session check returns 401", async () => {
    initialization("true");
    queryClient.setQueryData(["orders"], { private: "cached-order-details" });
    vi.stubGlobal("fetch", vi.fn(async () => apiError("session_invalid", "登录已失效", 401)));
    renderPage(<AuthBoundary><p>受保护内容</p></AuthBoundary>);
    expect(await screen.findByRole("heading", { name: "登录管理后台" })).toBeVisible();
    await waitFor(() => expect(queryClient.getQueryData(["orders"])).toBeUndefined());
    expect(screen.queryByText("受保护内容")).not.toBeInTheDocument();
  });
});

describe("concise settings copy", () => {
  it.each(["provider", "collection", "notifications", "security", "backup", "advanced"])("omits revision and implementation notes in %s", async (section) => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ data: settings })));
    const { container } = renderPage(<Routes><Route path="/settings/:section" element={<Settings />} /></Routes>, `/settings/${section}`);
    await screen.findByRole("navigation", { name: "设置分类" });
    expect(container.querySelector(".page-note, .page-heading p")).toBeNull();
    expect(screen.queryByText(/基于配置版本|配置版本 \d|页面不会在后台覆盖/)).not.toBeInTheDocument();
    expect(screen.queryByText("有未保存的修改")).not.toBeInTheDocument();
    if (section === "collection") {
      expect(screen.getByLabelText("支付宝经营码内容")).not.toHaveAccessibleDescription();
      expect(screen.getByRole("button", { name: "点击或拖拽二维码图片" })).toBeVisible();
    }
    if (section === "backup") {
      expect(screen.getByRole("link", { name: "查看备份状态" })).toHaveAttribute("href", "/system");
      expect(screen.getByText(/只有数据库备份，无法解密/)).toBeVisible();
    }
  });

  it("shows the unsaved status only while the configuration differs", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ data: settings })));
    renderPage(<Routes><Route path="/settings/:section" element={<Settings />} /></Routes>, "/settings/collection");
    const field = await screen.findByLabelText("收银台有效期（秒）");
    const user = userEvent.setup();
    expect(screen.queryByText("有未保存的修改")).not.toBeInTheDocument();
    await user.clear(field); await user.type(field, "450");
    expect(screen.getByText("有未保存的修改")).toBeVisible();
    await user.clear(field); await user.type(field, "300");
    expect(screen.queryByText("有未保存的修改")).not.toBeInTheDocument();
    expect(screen.queryByText(/基于配置版本/)).not.toBeInTheDocument();
  });

  it("keeps the no-transfer warning inside the refund action", () => {
    renderPage(<FinancialDialog mode="refund" onClose={vi.fn()} onSuccess={vi.fn()} />);
    expect(screen.getByRole("dialog", { name: "登记已发生退款" })).toHaveAccessibleDescription("仅登记已采集的退款支出流水，不会调用支付宝退款，也不会向付款人转账。");
  });
});

describe("state-changing workflows", () => {
  it("keeps an unsaved settings draft after a revision conflict", async () => {
    const fetchMock = vi.fn(async (request: Request) => request.method === "PUT"
      ? apiError("settings_revision_conflict", "配置版本冲突，请重新读取")
      : json({ data: settings }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderPage(<Routes><Route path="/settings/:section" element={<Settings />} /></Routes>, "/settings/collection");
    const ttl = await screen.findByLabelText("收银台有效期（秒）");
    await user.clear(ttl); await user.type(ttl, "450");
    await user.click(screen.getByRole("button", { name: "保存配置" }));
    expect(await screen.findByText("配置版本冲突，请重新读取")).toBeVisible();
    expect(ttl).toHaveValue(450);
    const writes = fetchMock.mock.calls.map(([request]) => request).filter((request) => request.method === "PUT");
    expect(writes).toHaveLength(1);
    expect(await writes[0]!.json()).toMatchObject({ revision: 3, order_ttl_seconds: 450 });
    expect(queryClient.getQueryData(["settings"])).toEqual({ data: settings });
  });

  it("requires direction-compatible evidence before recording a collection", async () => {
    const fetchMock = vi.fn(async (request: Request) => json({ data: new URL(request.url).pathname.includes("ledger-entries") ? { ...ledger, direction: "DEBIT" } : order }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderPage(<FinancialDialog mode="settlement" initialOrderId={orderId} initialLedgerId={ledgerId} onClose={vi.fn()} onSuccess={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "读取并核对证据" }));
    expect(await screen.findByText(/流水方向不匹配/)).toBeVisible();
    await user.type(screen.getByLabelText(/操作理由/), "核对测试证据");
    await user.click(screen.getByRole("checkbox"));
    expect(screen.getByRole("button", { name: "确认关联收款" })).toBeDisabled();
    expect(fetchMock.mock.calls.every(([request]) => request.method === "GET")).toBe(true);
  });

  it("reuses the operation ID when retrying a failed confirmed action", async () => {
    const execute = vi.fn().mockRejectedValueOnce(new Error("临时网络中断")).mockResolvedValueOnce(undefined);
    const complete = vi.fn();
    const user = userEvent.setup();
    renderPage(<ReasonDialog title="撤销测试关联" description="测试确认流程" action="确认撤销" execute={execute} onClose={vi.fn()} onSuccess={complete} />);
    await user.type(screen.getByLabelText(/操作理由/), "订单关联核对错误");
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "确认撤销" }));
    expect(await screen.findByText("临时网络中断")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "确认撤销" }));
    await waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    expect(execute.mock.calls[0]).toEqual(execute.mock.calls[1]);
  });

  it("clears revealed secrets when the tab becomes hidden", async () => {
    const configured = { ...settings, secrets: { ...settings.secrets, api_secret: { configured: true, version: 1, fingerprint: "a".repeat(64), masked: "test…secret", updatedAt: 0 } } };
    vi.stubGlobal("fetch", vi.fn(async () => json({ data: { name: "api_secret", value: "ephemeral-test-secret" } })));
    const user = userEvent.setup();
    renderPage(<SecuritySettings settings={configured} onSaved={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "显示网站 API 密钥" }));
    expect(screen.getByText("60 秒后或离开当前标签页时自动清除明文。")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "读取明文" }));
    expect(await screen.findByText("ephemeral-test-secret")).toBeVisible();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    const original = Object.getOwnPropertyDescriptor(document, "hidden");
    try {
      Object.defineProperty(document, "hidden", { configurable: true, value: true });
      fireEvent(document, new Event("visibilitychange"));
      await waitFor(() => expect(screen.queryByText("ephemeral-test-secret")).not.toBeInTheDocument());
    } finally {
      if (original) Object.defineProperty(document, "hidden", original); else Reflect.deleteProperty(document, "hidden");
    }
  });
});
