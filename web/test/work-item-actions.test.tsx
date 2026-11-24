import { WorkspaceProvider } from "../src/workspace";
import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { queryClient, type AdminWorkItem } from "../src/api/client";
import WorkItems from "../src/pages/WorkItems";
import { Toaster } from "../src/components/ui/toast";
import { apiError, json } from "./fixtures";

const scopes = [
  ["ALL", "全部提醒"],
  ["FINANCIAL_EXCEPTION", "账务异常"],
  ["LEDGER_CONFLICT", "账本冲突"],
  ["NOTIFICATION_FAILURE", "通知失败"],
] as const;
const item: AdminWorkItem = {
  type: "FINANCIAL_EXCEPTION",
  status: "OPEN",
  exception_type: "UNMATCHED_CREDIT",
  candidate_id: null,
  resource_id: "00000000-0000-4000-8000-000000000001",
  provider_account_key: "primary",
  order_id: null,
  ledger_entry_id: null,
  created_at: "2026-09-06T12:00:00Z",
  actionable_at: "2026-09-06T12:00:00Z",
  ignored_at: null,
  ignored_by: null,
  ended: false,
  detail_url:
    "/api/admin/v1/reconciliation/exceptions/00000000-0000-4000-8000-000000000001",
};
function Location() {
  return <output aria-label="当前地址">{useLocation().search}</output>;
}
function renderPage(search = "") {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[search.includes("api_client_id=site_a") ? "/sites/site_a/work-items" : "/work-items" + search]}><WorkspaceProvider>
        <Toaster><WorkItems /></Toaster>
        <Location />
      </WorkspaceProvider></MemoryRouter>
    </QueryClientProvider>,
  );
}
const page = (items: AdminWorkItem[] = [item]) =>
  json({ data: items, page: { next_cursor: "next-page" } });

describe("reminder type tab layout", () => {
  it.each([false, true])(
    "keeps padded scroll edges and keyboard filtering in the empty state (ignored: %s)",
    async (ignored) => {
      const reveal = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
      const requests: Request[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (request: Request) => {
          requests.push(request);
          return json({ data: [], page: { next_cursor: null } });
        }),
      );
      const user = userEvent.setup();
      renderPage(ignored ? "?visibility=IGNORED" : "");
      await screen.findByText(
        ignored ? "暂无已忽略提醒" : "暂无待处理提醒",
      );
      const tabs = screen.getByRole("tablist", { name: "待处理类型" });
      expect(tabs.parentElement).toHaveClass(
        "min-w-0",
        "overflow-x-auto",
        "scroll-p-1",
        "p-1",
        "-m-1",
      );
      expect(tabs.parentElement).not.toHaveClass("overflow-hidden");
      expect(within(tabs).getAllByRole("tab")).toHaveLength(scopes.length);
      await user.tab();
      expect(within(tabs).getByRole("tab", { name: "全部提醒" })).toHaveFocus();
      for (const [type, name] of scopes.slice(1)) {
        await user.keyboard("{ArrowRight}");
        const tab = within(tabs).getByRole("tab", { name });
        expect(tab).toHaveFocus();
        expect(reveal.mock.contexts).toContain(tab);
        expect(reveal).toHaveBeenLastCalledWith({
          block: "nearest",
          inline: "nearest",
        });
        await user.keyboard("{Enter}");
        expect(tab).toHaveAttribute("aria-selected", "true");
        expect(screen.getByLabelText("当前地址")).toHaveTextContent("type=" + type);
      }
      await user.keyboard("{Home}{Enter}");
      expect(within(tabs).getByRole("tab", { name: "全部提醒" })).toHaveFocus();
      await screen.findByText(
        ignored ? "暂无已忽略提醒" : "暂无待处理提醒",
      );
      expect(requests.every((request) => request.method === "GET")).toBe(true);
    },
  );
});

describe("reminder dismissal", () => {
  it.each([false, true])("captures the website name and ID in bulk ignore and keeps its scope (name available: %s)", async (hasName) => {
    const requests: Request[] = [];
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
      requests.push(request.clone());
      if (request.method === "GET" && new URL(request.url).pathname === "/api/admin/v1/sites/site_a")
        return json({ data: { client_id: "site_a", deleted_at: null, configuration: { name: hasName ? "主营业务网站" : "" } } });
      return request.method === "POST" ? json({ data: { ...(await request.json()), ignored_count: 1 } }) : page();
    }));
    renderPage("?api_client_id=site_a");
    const user = userEvent.setup();
    const button = await screen.findByRole("button", { name: "忽略全部筛选结果（跨页）" });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    expect(await screen.findByText(hasName ? /仅限业务网站“主营业务网站”/ : /仅限当前业务网站/)).toBeVisible();
    expect(screen.getByRole("alertdialog")).toHaveTextContent("网站 ID：site_a");
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: /确认忽略/ }));
    await waitFor(() => expect(requests.some(request => request.method === "POST")).toBe(true));
    expect(await requests.find(request => request.method === "POST")!.json()).not.toHaveProperty("api_client_id");
    expect(new URL(requests.find(request => request.method === "POST")!.url).pathname).toBe("/api/admin/v1/sites/site_a/work-items/actions/ignore-all");
    expect(requests.filter(request => request.method === "GET").every(request => new URL(request.url).pathname.startsWith("/api/admin/v1/sites/site_a"))).toBe(true);
  });
  it.each(scopes)(
    "dismisses all pages only within %s and refreshes home and every scope",
    async (type, name) => {
      const requests: Request[] = [];
      for (const [scope] of scopes)
        queryClient.setQueryData(["work-items", scope, "ACTIVE", "unvisited"], {
          data: [],
        });
      queryClient.setQueryData(["work-items", "recent"], { data: [item] });
      vi.stubGlobal(
        "fetch",
        vi.fn(async (request: Request) => {
          requests.push(request.clone());
          if (request.method === "POST") {
            const body = await request.json();
            return json({ data: { ...body, ignored_count: 35 } });
          }
          return page();
        }),
      );
      const user = userEvent.setup();
      renderPage("?type=" + type + "&cursor=later-page&page=3");
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "忽略全部筛选结果（跨页）" }),
        ).toBeEnabled(),
      );
      await user.click(
        screen.getByRole("button", { name: "忽略全部筛选结果（跨页）" }),
      );
      const dialog = await screen.findByRole("alertdialog", {
        name: "忽略全部筛选结果（跨页） · " + name,
      });
      expect(dialog).toHaveClass(
        "max-h-[calc(100dvh-2rem)]",
        "w-[calc(100%-2rem)]",
        "overflow-hidden",
      );
      expect(dialog.querySelector('[data-slot="alert-dialog-media"]')).toBeNull();
      expect(dialog).toHaveClass("sm:max-w-lg");
      expect(within(dialog).getByRole("button", { name: "确认忽略" })).toHaveClass("text-danger-foreground", "bg-danger");
      await waitFor(() => expect(within(dialog).getByRole("button", { name: "取消" })).toHaveFocus());
      expect(dialog).toHaveAccessibleDescription(
        /跨页.*仅关闭现有提醒.*不删除记录、处理冲突或停止通知重试.*新增提醒不受影响/,
      );
      expect(within(dialog).queryByRole("textbox")).not.toBeInTheDocument();
      await user.click(
        within(dialog).getByRole("button", { name: "确认忽略" }),
      );
      expect(
        await screen.findByText("已忽略“" + name + "”中的 35 条提醒。"),
      ).toBeVisible();
      const writes = requests.filter((request) => request.method === "POST");
      expect(writes).toHaveLength(1);
      expect(new URL(writes[0]!.url).pathname).toBe(
        "/api/admin/v1/work-items/actions/ignore-all",
      );
      expect(await writes[0]!.json()).toEqual({
        type,
        operation_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      });
      expect(screen.getByLabelText("当前地址")).toHaveTextContent(
        "?type=" + type,
      );
      await waitFor(() => {
        expect(screen.getByLabelText("当前地址")).not.toHaveTextContent(
          "cursor",
        );
        expect(screen.getByLabelText("当前地址")).not.toHaveTextContent("page");
      });
      await waitFor(() =>
        expect(
          queryClient.getQueryState(["work-items", "recent"])?.isInvalidated,
        ).toBe(true),
      );
      for (const [scope] of scopes)
        expect(
          queryClient.getQueryState([
            "work-items",
            scope,
            "ACTIVE",
            "unvisited",
          ])?.isInvalidated,
        ).toBe(true);
    },
  );

  it("retains a batch UUID after a lost response and captures the confirmed scope", async () => {
    const writes: Array<Record<string, string>> = [];
    let finish: (response: Response) => void = () => {
      throw new Error("request not started");
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        if (request.method === "GET") return page();
        const body = await request.json();
        writes.push(body);
        if (writes.length === 1)
          return new Promise<Response>((resolve) => {
            finish = resolve;
          });
        return json({ data: { ...body, ignored_count: 35 } });
      }),
    );
    const user = userEvent.setup();
    renderPage("?type=LEDGER_CONFLICT");
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "忽略全部筛选结果（跨页）" }),
      ).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: "忽略全部筛选结果（跨页）" }));
    await user.click(
      screen.getByRole("button", { name: "确认忽略" }),
    );
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(
      screen.getByRole("button", { name: "确认忽略" }),
    ).toBeDisabled();
    for (const [, name] of scopes)
      expect(screen.getByRole("tab", { name, hidden: true })).toHaveAttribute(
        "aria-disabled",
        "true",
      );
    finish(apiError("internal_error", "response lost", 500));
    await screen.findByText(/服务处理失败/);
    await user.click(
      screen.getByRole("button", { name: "确认忽略" }),
    );
    await screen.findByText("已忽略“账本冲突”中的 35 条提醒。");
    expect(writes[1]).toEqual(writes[0]);
    await user.click(screen.getByRole("tab", { name: "通知失败" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "忽略全部筛选结果（跨页）" }),
      ).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: "忽略全部筛选结果（跨页）" }));
    await user.click(
      screen.getByRole("button", { name: "确认忽略" }),
    );
    await screen.findByText("已忽略“通知失败”中的 35 条提醒。");
    expect(writes[2]!.type).toBe("NOTIFICATION_FAILURE");
    expect(writes[2]!.operation_id).not.toBe(writes[0]!.operation_id);
  });

  it("lists ignored and ended records, preserves the filter and restores only one live reminder", async () => {
    const requests: Request[] = [];
    const ignored = {
      ...item,
      ignored_at: "2026-09-07T12:00:00Z",
      ignored_by: "admin",
    };
    const ended = {
      ...ignored,
      resource_id: "00000000-0000-4000-8000-000000000002",
      status: "RESOLVED" as const,
      ended: true,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        requests.push(request.clone());
        if (request.method === "POST")
          return json({
            data: {
              operation_id: (await request.json()).operation_id,
              type: item.type,
              resource_id: item.resource_id,
              restored: true,
            },
          });
        return page(
          new URL(request.url).searchParams.get("visibility") === "IGNORED"
            ? [ignored, ended]
            : [item],
        );
      }),
    );
    const user = userEvent.setup();
    renderPage("?type=FINANCIAL_EXCEPTION");
    await screen.findByRole("link", { name: "收入尚未匹配订单" });
    await user.click(screen.getByRole("button", { name: "已忽略" }));
    expect(await screen.findByText("已结束", { exact: true })).toBeVisible();
    expect(screen.queryByRole("button", { name: "已结束" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "忽略全部筛选结果（跨页）" }),
    ).not.toBeInTheDocument();
    expect(
      screen
        .getAllByRole("link")
        .some(
          (link) =>
            link.getAttribute("href") ===
            "/reconciliation/exceptions/" + item.resource_id,
        ),
    ).toBe(true);
    await user.click(screen.getByRole("button", { name: /^恢复提醒/ }));
    await waitFor(() =>
      expect(
        requests.filter((request) => request.method === "POST"),
      ).toHaveLength(1),
    );
    const write = requests.find((request) => request.method === "POST")!;
    expect(new URL(write.url).pathname).toBe(
      "/api/admin/v1/work-items/FINANCIAL_EXCEPTION/" +
        item.resource_id +
        "/actions/restore",
    );
    expect(await write.json()).toEqual({ operation_id: expect.any(String) });
    await user.click(screen.getByRole("tab", { name: "账本冲突" }));
    await waitFor(() =>
      expect(
        requests.some(
          (request) =>
            new URL(request.url).searchParams.get("type") ===
              "LEDGER_CONFLICT" &&
            new URL(request.url).searchParams.get("visibility") === "IGNORED",
        ),
      ).toBe(true),
    );
    expect(screen.getByRole("button", { name: "待处理" })).toBeVisible();
  });
});

it("captures the keyword in the batch receipt and reuses it after a lost response", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: Request) => {
      if (request.method === "POST") {
        const body = await request.json();
        bodies.push(body);
        if (bodies.length === 1) throw new TypeError("Lost response");
        return json({ data: { ...body, ignored_count: 1 } });
      }
      return page();
    }),
  );
  const user = userEvent.setup();
  renderPage(
    "?q=" +
      encodeURIComponent("  精确%_  ") +
      "&type=FINANCIAL_EXCEPTION&sort_order=asc",
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "忽略全部筛选结果（跨页）" }),
    ).toBeEnabled(),
  );
  await user.click(screen.getByRole("button", { name: "忽略全部筛选结果（跨页）" }));
  const dialog = await screen.findByRole("alertdialog");
  expect(dialog).toHaveTextContent("关键词“精确%_”");
  await user.click(
    within(dialog).getByRole("button", { name: "确认忽略" }),
  );
  await waitFor(() => expect(bodies).toHaveLength(1));
  await waitFor(() =>
    expect(
      within(dialog).getByRole("button", { name: "确认忽略" }),
    ).toBeEnabled(),
  );
  await user.click(
    within(dialog).getByRole("button", { name: "确认忽略" }),
  );
  await waitFor(() => expect(bodies).toHaveLength(2));
  expect(bodies[1]).toEqual(bodies[0]);
  expect(bodies[0]).toMatchObject({ q: "精确%_", type: "FINANCIAL_EXCEPTION" });
});

it("triggers immediate notification retry inline from active work items", async () => {
  const retryDeliveryId = "77777777-7777-4777-8777-777777777777";
  const retryItem: AdminWorkItem = {
    type: "NOTIFICATION_FAILURE",
    status: "RETRY_WAIT",
    event_type: "PAYMENT_CONFIRMED",
    attempt_count: 2,
    next_attempt_at: "2026-09-06T12:15:00Z",
    last_error_code: "http_status_not_ack",
    dead_lettered_at: null,
    updated_at: "2026-09-06T12:05:00Z",
    resource_id: retryDeliveryId,
    provider_account_key: "primary",
    order_id: "88888888-8888-4888-8888-888888888888",
    ledger_entry_id: null,
    created_at: "2026-09-06T12:00:00Z",
    actionable_at: "2026-09-06T12:05:00Z",
    ignored_at: null,
    ignored_by: null,
    ended: false,
    detail_url: "/api/admin/v1/webhooks/deliveries/" + retryDeliveryId,
  };
  const posts: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (request.method === "POST") {
      posts.push(path);
      return json({ data: { delivery: { delivery_id: retryDeliveryId, status: "LEASED" } } }, 202);
    }
    return json({ data: [retryItem], page: { next_cursor: null } });
  }));
  const user = userEvent.setup();
  renderPage("?type=NOTIFICATION_FAILURE");
  const retryButton = await screen.findByRole("button", { name: "立即重试" });
  await user.click(retryButton);
  expect(await screen.findByText("已发起立即重试")).toBeVisible();
  expect(posts).toEqual(["/api/admin/v1/webhooks/deliveries/" + retryDeliveryId + "/actions/retry"]);
});

describe("selective and inline reminder dismissal", () => {
  const secondItem: AdminWorkItem = {
    ...item,
    type: "LEDGER_CONFLICT",
    conflict_type: "INVALID_AMOUNT",
    external_event_id: "ALI-SEL-002",
    resource_id: "00000000-0000-4000-8000-000000000099",
    detail_url: "/api/admin/v1/reconciliation/conflicts/00000000-0000-4000-8000-000000000099",
  };

  it("supports multi-select checkboxes, selection bar ignore-selected, and idempotent retry on lost response", async () => {
    const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        if (request.method === "POST") {
          const body = await request.json() as Record<string, unknown>;
          writes.push({ path: new URL(request.url).pathname, body });
          if (writes.length === 1) throw new TypeError("lost response");
          return json({ data: { operation_id: body.operation_id, ignored_count: 2 } });
        }
        return page([item, secondItem]);
      }),
    );
    const user = userEvent.setup();
    renderPage("");
    await screen.findByRole("link", { name: "收入尚未匹配订单" });
    expect(screen.queryByRole("region", { name: "已选提醒操作" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "全选当前页提醒" }));
    const bar = await screen.findByRole("region", { name: "已选提醒操作" });
    expect(bar).toHaveTextContent("已选 2 项");
    expect(screen.getByLabelText("当前地址")).toHaveTextContent("");

    await user.click(within(bar).getByRole("button", { name: "忽略已选（2）" }));
    const dialog = await screen.findByRole("alertdialog", { name: "忽略已选的 2 条提醒" });
    await user.click(within(dialog).getByRole("button", { name: "确认忽略" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    await screen.findByText(/无法连接服务/);

    // Retrying after lost response must reuse the exact operation_id and items payload.
    await user.click(within(dialog).getByRole("button", { name: "确认忽略" }));
    expect(await screen.findByText("已忽略选中的 2 条提醒。")).toBeVisible();
    expect(writes).toHaveLength(2);
    expect(writes[0]!.path).toBe("/api/admin/v1/work-items/actions/ignore-selected");
    expect(writes[1]!.body).toEqual(writes[0]!.body);
    expect(writes[0]!.body).toEqual({
      operation_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      items: [
        { type: "FINANCIAL_EXCEPTION", resource_id: item.resource_id },
        { type: "LEDGER_CONFLICT", resource_id: secondItem.resource_id },
      ],
    });
    expect(screen.queryByRole("region", { name: "已选提醒操作" })).not.toBeInTheDocument();
  });

  it("ignores a single active reminder inline and uses the site-scoped ignore-selected endpoint in a site workspace", async () => {
    const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        const path = new URL(request.url).pathname;
        if (request.method === "GET" && path === "/api/admin/v1/sites/site_a") {
          return json({ data: { client_id: "site_a", deleted_at: null, configuration: { name: "订阅主站" } } });
        }
        if (request.method === "POST") {
          const body = await request.json() as Record<string, unknown>;
          writes.push({ path, body });
          return json({ data: { operation_id: body.operation_id, ignored_count: 1 } });
        }
        return page([item]);
      }),
    );
    const user = userEvent.setup();
    renderPage("?api_client_id=site_a");
    await screen.findByRole("link", { name: "收入尚未匹配订单" });
    await user.click(screen.getByRole("button", { name: "忽略提醒：收入尚未匹配订单" }));
    const dialog = await screen.findByRole("alertdialog", { name: "忽略提醒 · 收入尚未匹配订单" });
    expect(dialog).toHaveTextContent("仅限业务网站“订阅主站”");
    expect(dialog).toHaveTextContent("仅关闭当前选中的这条提醒");
    await user.click(within(dialog).getByRole("button", { name: "确认忽略" }));
    expect(await screen.findByText("已忽略选中的 1 条提醒。")).toBeVisible();
    expect(writes).toHaveLength(1);
    expect(writes[0]!.path).toBe("/api/admin/v1/sites/site_a/work-items/actions/ignore-selected");
    expect(writes[0]!.body).not.toHaveProperty("api_client_id");
    expect(writes[0]!.body).toEqual({
      operation_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      items: [{ type: "FINANCIAL_EXCEPTION", resource_id: item.resource_id }],
    });
  });

  it("offers a desktop reset-to-priority sort button when active reminders are sorted by another field", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => page([item])));
    const user = userEvent.setup();
    renderPage("?sort_by=created_at&sort_order=asc");
    const resetButton = await screen.findByRole("button", { name: "恢复需要处理优先排序" });
    expect(resetButton).toBeVisible();
    await user.click(resetButton);
    await waitFor(() => expect(screen.queryByRole("button", { name: "恢复需要处理优先排序" })).not.toBeInTheDocument());
  });

  it("locks tabs and visibility switches while a restore is pending and clears 409 refresh state after refresh", async () => {
    let resolveRestore!: (response: Response) => void;
    let restored = false;
    const ignoredItem: AdminWorkItem = {
      ...item,
      ignored_at: "2026-09-07T12:00:00Z",
      ignored_by: "admin",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        if (request.method === "POST") {
          return new Promise<Response>((resolve) => {
            resolveRestore = resolve;
          });
        }
        return page(restored ? [] : [ignoredItem]);
      }),
    );
    const user = userEvent.setup();
    renderPage("?visibility=IGNORED");
    const restoreBtn = await screen.findByRole("button", { name: /^恢复提醒/ });
    await user.click(restoreBtn);
    expect(screen.getByText("1 条提醒正在恢复…")).toBeVisible();
    expect(screen.getByRole("tab", { name: "账务异常" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "待处理" })).toBeDisabled();

    // Server returns 409 conflict without work_item_ended (e.g. concurrent state change) -> offers 刷新列表.
    resolveRestore(apiError("operation_conflict", "state changed", 409));
    const refreshBtn = await screen.findByRole("button", { name: /^刷新列表/ });
    expect(refreshBtn).toBeEnabled();
    expect(screen.getByRole("button", { name: "待处理" })).toBeEnabled();

    // Clicking 刷新列表 refreshes the list and clears the stuck refresh state.
    restored = true;
    await user.click(refreshBtn);
    await screen.findByText("暂无已忽略提醒");
  });
});
