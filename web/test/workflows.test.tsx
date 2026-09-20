import { QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

import { queryClient } from "../src/api/client";
import { AuthBoundary, AuthPage } from "../src/auth";
import { ReasonDialog } from "../src/components/ReasonDialog";
import { DetailFields } from "../src/components/detail/DetailPrimitives";
import { AssociateIncomeAction } from "../src/components/detail/FinancialActions";
import { FinancialDialog } from "../src/pages/FinancialDialog";
import { SecuritySettings } from "../src/pages/SecuritySettings";
import Settings from "../src/pages/Settings";
import {
  apiError,
  json,
  ledger,
  ledgerId,
  order,
  orderId,
  settings,
} from "./fixtures";

function renderPage(children: ReactNode, path = "/") {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
    </QueryClientProvider>,
  );
}

function initialization(value: string) {
  const meta = document.createElement("meta");
  meta.name = "perpay-initialized";
  meta.content = value;
  document.head.append(meta);
}

describe("administrator authentication", () => {
  it.each(["aB3!xY", "🔐".repeat(6)])(
    "accepts six-character setup password %s and asks for a separate login",
    async (password) => {
      initialization("false");
      const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
      vi.stubGlobal("fetch", fetchMock);
      const onLogin = vi.fn();
      const user = userEvent.setup();
      renderPage(<AuthPage onLogin={onLogin} />, "/setup");
      expect(
        screen.queryByText("设置此实例的管理员密码。"),
      ).not.toBeInTheDocument();
      expect(screen.getByText("至少 6 个字符。")).toBeVisible();
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
      expect(
        await screen.findByRole("heading", { name: "登录管理后台" }),
      ).toBeVisible();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(onLogin).not.toHaveBeenCalled();
    },
  );

  it("does not expose a setup form after initialization", () => {
    initialization("true");
    renderPage(<AuthPage onLogin={vi.fn()} />, "/setup");
    expect(screen.getByRole("heading", { name: "登录管理后台" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "创建管理员" }),
    ).not.toBeInTheDocument();
  });

  it("associates a mismatched password confirmation with its official field error", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderPage(<SecuritySettings settings={settings} onSaved={vi.fn()} />);
    const password = screen.getByLabelText("新密码");
    const confirmation = screen.getByLabelText("再次输入新密码");
    fireEvent.change(password, { target: { value: "test-password-one" } });
    fireEvent.change(confirmation, { target: { value: "test-password-two" } });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "修改并重新登录" }));
    expect(confirmation).toHaveFocus();
    expect(confirmation).toHaveAttribute("aria-invalid", "true");
    expect(confirmation).toHaveAccessibleDescription("两次输入的密码不一致。");
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.change(confirmation, { target: { value: "test-password-one" } });
    expect(confirmation).not.toHaveAttribute("aria-describedby");
    expect(
      screen.queryByText("两次输入的密码不一致。"),
    ).not.toBeInTheDocument();
  });

  it.each(["aB3!xY", "🔐".repeat(6)])(
    "validates a six-character replacement password %s before saving",
    async (password) => {
      const fetchMock = vi.fn(
        async (_request: Request) => new Response(null, { status: 204 }),
      );
      vi.stubGlobal("fetch", fetchMock);
      renderPage(<SecuritySettings settings={settings} onSaved={vi.fn()} />);
      const field = screen.getByLabelText("新密码");
      const confirmation = screen.getByLabelText("再次输入新密码");
      const short = Array.from(password).slice(0, 5).join("");
      expect(field).toHaveAccessibleDescription("至少 6 个字符。");
      fireEvent.change(field, { target: { value: short } });
      fireEvent.change(confirmation, { target: { value: short } });
      const user = userEvent.setup();
      expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "修改并重新登录" }));
      expect(screen.getByText("密码至少需要 6 个字符。")).toBeVisible();
      expect(fetchMock).not.toHaveBeenCalled();
      fireEvent.change(field, { target: { value: password } });
      fireEvent.change(confirmation, { target: { value: password } });
      await user.click(screen.getByRole("button", { name: "修改并重新登录" }));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      const request = fetchMock.mock.calls[0]![0];
      expect(new URL(request.url).pathname).toBe("/api/admin/v1/password");
      expect(await request.clone().json()).toEqual({ new_password: password });
      await waitFor(() => expect(field).toHaveValue(""));
    },
  );

  it.each(["login", "setup"])(
    "uses a text-only brand while preserving authentication controls on %s",
    (page) => {
      initialization(page === "setup" ? "false" : "true");
      const { container } = renderPage(
        <AuthPage onLogin={vi.fn()} />,
        "/" + page,
      );
      const brand = screen.getByRole("link", { name: "PerPay" });
      expect(brand).toHaveAttribute("href", "/");
      expect(brand.querySelector("img")).toBeNull();
      expect(
        screen.queryByRole("heading", { name: /每一笔收款/ }),
      ).not.toBeInTheDocument();
      expect(container.querySelector(".auth-statement")).toBeNull();
      expect(
        screen.getByRole("button", { name: "显示密码" }).querySelector("svg"),
      ).not.toBeNull();
    },
  );

  it("keeps login labels without redundant decorations or implementation notes", () => {
    initialization("true");
    const { container } = renderPage(<AuthPage onLogin={vi.fn()} />, "/login");
    expect(screen.getByRole("heading", { name: "登录管理后台" })).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: /每一笔收款/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("管理员密码")).toBeRequired();
    expect(screen.queryByText("为个人开发者而建")).not.toBeInTheDocument();
    expect(
      screen.queryByText("密码不会保存在浏览器中"),
    ).not.toBeInTheDocument();
    expect(container.querySelector(".auth-emblem")).toBeNull();
    expect(container.querySelector(".auth-process")).toBeNull();
    expect(
      screen.queryByText(/经营码收款，账本自动核对/),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("你的实例，你的数据。")).not.toBeInTheDocument();
    expect(
      screen.queryByText("使用管理员密码，查看收款与实例状态。"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("此实例只有一个管理员账户，无需输入用户名。"),
    ).not.toBeInTheDocument();
  });

  it.each([false, true])(
    "sends the explicit keep-signed-in choice without storing a password (%s)",
    async (remember) => {
      initialization("true");
      const fetchMock = vi.fn(async (_request: Request) =>
        apiError("invalid_credentials", "管理员密码错误", 401),
      );
      vi.stubGlobal("fetch", fetchMock);
      const user = userEvent.setup();
      renderPage(<AuthPage onLogin={vi.fn()} />, "/login");
      const checkbox = screen.getByRole("checkbox", {
        name: "在此设备保持登录 30 天",
      });
      expect(checkbox).not.toBeChecked();
      if (remember) await user.click(checkbox);
      await user.type(
        screen.getByLabelText("管理员密码"),
        "remember-choice-test-password",
      );
      await user.click(screen.getByRole("button", { name: "登录" }));
      await screen.findByText("管理员密码错误");
      expect(await fetchMock.mock.calls[0]![0].json()).toEqual(
        remember
          ? { password: "remember-choice-test-password", remember_me: true }
          : { password: "remember-choice-test-password" },
      );
      expect(Object.values(localStorage)).not.toContain(
        "remember-choice-test-password",
      );
      expect(Object.values(sessionStorage)).not.toContain(
        "remember-choice-test-password",
      );
      expect(checkbox).toHaveAttribute("aria-checked", String(remember));
    },
  );

  it("does not offer persistent login during administrator setup", () => {
    initialization("false");
    renderPage(<AuthPage onLogin={vi.fn()} />, "/setup");
    expect(
      screen.queryByRole("checkbox", { name: "在此设备保持登录 30 天" }),
    ).not.toBeInTheDocument();
  });

  it("preserves an unsuccessful login and never sends a username field", async () => {
    initialization("true");
    const fetchMock = vi.fn(async () =>
      apiError("invalid_credentials", "管理员密码错误", 401),
    );
    vi.stubGlobal("fetch", fetchMock);
    const onLogin = vi.fn();
    const user = userEvent.setup();
    renderPage(<AuthPage onLogin={onLogin} />, "/login");
    await user.type(
      screen.getByLabelText(/管理员密码/),
      "incorrect-test-password",
    );
    await user.click(screen.getByRole("button", { name: "登录" }));
    expect(await screen.findByText("管理员密码错误")).toBeVisible();
    const request = (
      fetchMock.mock.calls as unknown as Array<[Request]>
    )[0]![0];
    expect(await request.json()).toEqual({
      password: "incorrect-test-password",
    });
    expect(onLogin).not.toHaveBeenCalled();
  });

  it("clears cached business data when a session check returns 401", async () => {
    initialization("true");
    queryClient.setQueryData(["orders"], { private: "cached-order-details" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => apiError("session_invalid", "登录已失效", 401)),
    );
    renderPage(
      <AuthBoundary>
        <p>受保护内容</p>
      </AuthBoundary>,
    );
    expect(
      await screen.findByRole("heading", { name: "登录管理后台" }),
    ).toBeVisible();
    await waitFor(() =>
      expect(queryClient.getQueryData(["orders"])).toBeUndefined(),
    );
    expect(screen.queryByText("受保护内容")).not.toBeInTheDocument();
  });
});

describe("concise settings copy", () => {
  it.each([
    "provider",
    "collection",
    "notifications",
    "security",
    "backup",
    "advanced",
  ])("omits revision and implementation notes in %s", async (section) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ data: settings })),
    );
    const { container } = renderPage(
      <Routes>
        <Route path="/settings/:section" element={<Settings />} />
      </Routes>,
      `/settings/${section}`,
    );
    await screen.findByRole("tablist", { name: "设置分类" });
    expect(container.querySelector(".page-note, .page-heading p")).toBeNull();
    expect(
      screen.queryByText(/基于配置版本|配置版本 \d|页面不会在后台覆盖/),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("未保存")).not.toBeInTheDocument();
    if (section === "collection") {
      expect(
        screen.getByLabelText("支付宝经营码内容"),
      ).not.toHaveAccessibleDescription();
      expect(screen.getByRole("button", { name: "上传二维码" })).toBeVisible();
    }
    if (section === "backup") {
      expect(
        screen.getByRole("link", { name: "查看备份状态" }),
      ).toHaveAttribute("href", "/system");
      expect(screen.getByText(/恢复需要数据库备份和主密钥/)).toBeVisible();
    }
  });

  it("shows the unsaved status only while the configuration differs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ data: settings })),
    );
    renderPage(
      <Routes>
        <Route path="/settings/:section" element={<Settings />} />
      </Routes>,
      "/settings/collection",
    );
    const field = await screen.findByLabelText("收银台有效期（秒）");
    const user = userEvent.setup();
    expect(screen.queryByText("未保存")).not.toBeInTheDocument();
    await user.clear(field);
    await user.type(field, "450");
    expect(screen.getByText("未保存")).toBeVisible();
    await user.clear(field);
    await user.type(field, "300");
    expect(screen.queryByText("未保存")).not.toBeInTheDocument();
    expect(screen.queryByText(/基于配置版本/)).not.toBeInTheDocument();
  });

  it("only offers income association in the financial dialog", () => {
    renderPage(<FinancialDialog onClose={vi.fn()} onSuccess={vi.fn()} />);
    expect(screen.getByRole("dialog", { name: "人工关联收款" })).toBeVisible();
    expect(screen.getByLabelText("收入流水编号")).toBeVisible();
    expect(screen.queryByText(/退款/)).not.toBeInTheDocument();
  });
});

describe("operation dialog layout", () => {
  it.each(["reason", "financial"] as const)(
    "keeps long evidence in the scroll body and cancellation outside it (%s)",
    async (kind) => {
      const productName = "长商品名称与核对说明".repeat(20);
      const fetchMock = vi.fn(async (request: Request) =>
        json({
          data: new URL(request.url).pathname.includes("ledger-entries")
            ? ledger
            : { ...order, product_name: productName },
        }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const execute = vi.fn();
      const onClose = vi.fn();
      const onSuccess = vi.fn();
      renderPage(
        kind === "reason" ? (
          <ReasonDialog
            title="撤销收款关联？"
            description="仅撤销账务关联，不会转出资金。"
            action="确认撤销关联"
            execute={execute}
            onClose={onClose}
            onSuccess={onSuccess}
          >
            <DetailFields items={[["商品", productName]]} />
          </ReasonDialog>
        ) : (
          <FinancialDialog
            initialOrderId={orderId}
            initialLedgerId={ledgerId}
            lockContext
            onClose={onClose}
            onSuccess={onSuccess}
          />
        ),
      );
      const evidence = await screen.findByText(productName);
      const dialog = screen.getByRole("dialog");
      const body = dialog.querySelector<HTMLElement>("[data-slot=field-group]");
      const header = dialog.querySelector<HTMLElement>(
        "[data-slot=dialog-header]",
      );
      const footer = dialog.querySelector<HTMLElement>(
        "[data-slot=dialog-footer]",
      );
      expect(dialog).toHaveClass(
        "flex-col",
        "overflow-hidden",
        "max-h-[calc(100dvh-2rem)]",
      );
      expect(body).toHaveClass("min-h-0", "w-auto", "overflow-y-auto", "pb-1");
      expect(body).toContainElement(evidence);
      expect(body).toContainElement(screen.getByLabelText("操作理由"));
      expect(header).toHaveClass("shrink-0");
      expect(footer).toHaveClass("shrink-0");
      expect(body).not.toContainElement(header);
      expect(body).not.toContainElement(footer);
      expect(dialog).toHaveAccessibleDescription(
        kind === "reason"
          ? "仅撤销账务关联，不会转出资金。"
          : "将这笔收入关联到订单并确认付款。",
      );
      const user = userEvent.setup();
      await user.type(screen.getByLabelText("操作理由"), "核对长文本证据");
      await user.click(within(dialog).getByRole("button", { name: "取消" }));
      expect(onClose).toHaveBeenCalledOnce();
      expect(execute).not.toHaveBeenCalled();
      expect(onSuccess).not.toHaveBeenCalled();
      expect(
        fetchMock.mock.calls.every(([request]) => request.method === "GET"),
      ).toBe(true);
    },
  );
});

describe("state-changing workflows", () => {
  it("keeps an unsaved settings draft after a revision conflict", async () => {
    const fetchMock = vi.fn(async (request: Request) =>
      request.method === "PUT"
        ? apiError("settings_revision_conflict", "配置版本冲突，请刷新")
        : json({ data: settings }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderPage(
      <Routes>
        <Route path="/settings/:section" element={<Settings />} />
      </Routes>,
      "/settings/collection",
    );
    const ttl = await screen.findByLabelText("收银台有效期（秒）");
    await user.clear(ttl);
    await user.type(ttl, "450");
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByText("配置版本冲突，请刷新")).toBeVisible();
    expect(ttl).toHaveValue(450);
    const writes = fetchMock.mock.calls
      .map(([request]) => request)
      .filter((request) => request.method === "PUT");
    expect(writes).toHaveLength(1);
    expect(await writes[0]!.json()).toMatchObject({
      revision: 3,
      order_ttl_seconds: 450,
    });
    expect(queryClient.getQueryData(["settings"])).toEqual({ data: settings });
  });

  it("requires direction-compatible evidence before recording a collection", async () => {
    const fetchMock = vi.fn(async (request: Request) =>
      json({
        data: new URL(request.url).pathname.includes("ledger-entries")
          ? { ...ledger, direction: "DEBIT" }
          : order,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderPage(
      <FinancialDialog
        initialOrderId={orderId}
        initialLedgerId={ledgerId}
        lockContext
        onClose={vi.fn()}
        onSuccess={vi.fn()}
      />,
    );
    // Known objects load their latest evidence when the dialog opens.
    expect(await screen.findByText(/只能关联收入流水/)).toBeVisible();
    await user.type(screen.getByLabelText(/操作理由/), "核对测试证据");
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确认关联收款" })).toBeDisabled();
    expect(
      fetchMock.mock.calls.every(([request]) => request.method === "GET"),
    ).toBe(true);
  });

  it.each([false, true])(
    "rechecks financial conflicts without repeating a write (read failure: %s)",
    async (readFails) => {
      let conflicted = false;
      let orderReads = 0;
      let ledgerReads = 0;
      const writes: Request[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (request: Request) => {
          if (request.method === "POST") {
            writes.push(request.clone());
            conflicted = true;
            return apiError(
              "match_state_conflict",
              "资金事实或处理状态已经变化",
            );
          }
          const isLedger = new URL(request.url).pathname.includes(
            "ledger-entries",
          );
          const count = isLedger ? ++ledgerReads : ++orderReads;
          if (readFails && conflicted && count === 2)
            return apiError(
              "reconciliation_unavailable",
              "无法读取最新证据",
              503,
            );
          return json({
            data: isLedger
              ? { ...ledger, state: conflicted ? "ALLOCATED" : "UNALLOCATED" }
              : conflicted
                ? {
                    ...order,
                    received_amount_cents: ledger.amount_cents,
                    payment: {
                      status: "CONFIRMED",
                      basis: "MANUAL",
                      received_amount_cents: ledger.amount_cents,
                    },
                  }
                : order,
          });
        }),
      );
      renderPage(
        <FinancialDialog
          initialOrderId={orderId}
          initialLedgerId={ledgerId}
          lockContext
          onClose={vi.fn()}
          onSuccess={vi.fn()}
        />,
      );
      const user = userEvent.setup();
      const reason = await screen.findByLabelText("操作理由");
      await user.type(reason, "初次核对理由");
      await user.click(screen.getByRole("button", { name: "确认关联收款" }));
      await screen.findByText("资金事实或处理状态已经变化");
      const recheck = await screen.findByRole("button", {
        name: "重新核对证据",
      });
      expect(recheck).toHaveAttribute("type", "button");
      expect(
        screen.queryByRole("button", { name: "确认关联收款" }),
      ).not.toBeInTheDocument();
      await act(async () => {
        fireEvent.submit(reason.closest("form")!);
      });
      expect(writes).toHaveLength(1);
      if (readFails) await user.clear(reason);
      await user.click(recheck);
      if (readFails) {
        await screen.findByText("无法读取最新证据");
        expect(
          screen.queryByRole("button", { name: "确认关联收款" }),
        ).not.toBeInTheDocument();
        expect(writes).toHaveLength(1);
        await user.click(screen.getByRole("button", { name: "查看关联信息" }));
      }
      await screen.findByText("订单或流水状态已变化，请关闭后刷新。");
      expect(
        screen.getByRole("button", { name: "确认关联收款" }),
      ).toBeDisabled();
      expect(screen.getByLabelText("操作理由")).toHaveValue(
        readFails ? "" : "初次核对理由",
      );
      expect(orderReads).toBe(readFails ? 3 : 2);
      expect(ledgerReads).toBe(readFails ? 3 : 2);
      expect(writes).toHaveLength(1);
    },
  );

  it("retries an uncertain financial response with the same operation ID and payload", async () => {
    const writes: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        if (request.method === "POST") {
          writes.push(request.clone());
          if (writes.length === 1) throw new TypeError("Failed to fetch");
          return json({ data: {} });
        }
        return json({
          data: new URL(request.url).pathname.includes("ledger-entries")
            ? ledger
            : order,
        });
      }),
    );
    const onSuccess = vi.fn();
    renderPage(
      <FinancialDialog
        initialOrderId={orderId}
        initialLedgerId={ledgerId}
        lockContext
        onClose={vi.fn()}
        onSuccess={onSuccess}
      />,
    );
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("操作理由"), "保持原请求重试");
    await user.click(screen.getByRole("button", { name: "确认关联收款" }));
    await screen.findByText("操作结果待确认");
    expect(
      screen.queryByRole("button", { name: "重新核对证据" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试原操作" }));
    await waitFor(() => expect(onSuccess).toHaveBeenCalledOnce());
    expect(writes).toHaveLength(2);
    const first = await writes[0]!.json();
    expect(first).toMatchObject({
      order_id: orderId,
      ledger_entry_id: ledgerId,
      reason: "保持原请求重试",
      financial_operation_id: expect.any(String),
    });
    expect(await writes[1]!.json()).toEqual(first);
  });

  it.each([false, true])(
    "returns financial focus to the trigger on cancel or stable content after saving (saved: %s)",
    async (saved) => {
      const writes: Request[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (request: Request) => {
          if (request.method === "POST") {
            writes.push(request.clone());
            return json({ data: {} });
          }
          return json({
            data: new URL(request.url).pathname.includes("ledger-entries")
              ? ledger
              : order,
          });
        }),
      );
      renderPage(
        <main id="main-content" aria-label="订单内容" tabIndex={-1}>
          <AssociateIncomeAction orderId={orderId} ledgerId={ledgerId} />
        </main>,
      );
      const user = userEvent.setup();
      const trigger = screen.getByRole("button", { name: "人工关联收款" });
      await user.click(trigger);
      await user.type(
        await screen.findByLabelText("操作理由"),
        "核对后确认关联",
      );
      await user.click(
        screen.getByRole("button", { name: saved ? "确认关联收款" : "取消" }),
      );
      await waitFor(() =>
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
      );
      if (saved) {
        expect(trigger).toBeDisabled();
        expect(screen.getByText("关联已保存")).toBeVisible();
        await waitFor(() =>
          expect(screen.getByRole("main", { name: "订单内容" })).toHaveFocus(),
        );
      } else {
        await waitFor(() => expect(trigger).toHaveFocus());
      }
      expect(writes).toHaveLength(saved ? 1 : 0);
    },
  );

  it("reuses the operation ID when retrying a failed confirmed action", async () => {
    const execute = vi
      .fn()
      .mockRejectedValueOnce(new Error("临时网络中断"))
      .mockResolvedValueOnce(undefined);
    const complete = vi.fn();
    const user = userEvent.setup();
    renderPage(
      <ReasonDialog
        title="撤销测试关联"
        description="测试确认流程"
        action="确认撤销"
        execute={execute}
        onClose={vi.fn()}
        onSuccess={complete}
      />,
    );
    await user.type(screen.getByLabelText(/操作理由/), "订单关联核对错误");
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "确认撤销" }));
    expect(await screen.findByText("操作结果待确认")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "响应详情" }));
    expect(await screen.findByText("临时网络中断")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "重试原操作" }));
    await waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    expect(execute.mock.calls[0]!.slice(0, 2)).toEqual(
      execute.mock.calls[1]!.slice(0, 2),
    );
  });

  it("clears revealed secrets when the tab becomes hidden", async () => {
    const configured = {
      ...settings,
      secrets: {
        ...settings.secrets,
        api_secret: {
          configured: true,
          version: 1,
          fingerprint: "a".repeat(64),
          masked: "test…secret",
          updatedAt: 0,
        },
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({ data: { name: "api_secret", value: "ephemeral-test-secret" } }),
      ),
    );
    const user = userEvent.setup();
    renderPage(<SecuritySettings settings={configured} onSaved={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "查看网站 API 密钥" }));
    expect(screen.getByText("60 秒后或切换标签页时自动清除。")).toBeVisible();
    expect(await screen.findByText("ephemeral-test-secret")).toBeVisible();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    const original = Object.getOwnPropertyDescriptor(document, "hidden");
    try {
      Object.defineProperty(document, "hidden", {
        configurable: true,
        value: true,
      });
      fireEvent(document, new Event("visibilitychange"));
      await waitFor(() =>
        expect(
          screen.queryByText("ephemeral-test-secret"),
        ).not.toBeInTheDocument(),
      );
    } finally {
      if (original) Object.defineProperty(document, "hidden", original);
      else Reflect.deleteProperty(document, "hidden");
    }
  });
});
