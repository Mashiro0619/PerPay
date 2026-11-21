import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { queryClient, type PaymentMatchDetail } from "../src/api/client";
import { MatchRecord } from "../src/components/detail/MatchRecord";
import { Toaster } from "../src/components/ui/toast";
import EvidenceDetail from "../src/pages/ReconciliationDetail";
import { WorkspaceProvider } from "../src/workspace";
import { matchId, paymentMatch } from "./detail-fixtures";
import { apiError, json, orderId } from "./fixtures";
import { recordAction } from "./menu-helper";

function mount(children: ReactNode) {
  return render(
    <QueryClientProvider client={queryClient}>
      <Toaster><MemoryRouter>{children}</MemoryRouter></Toaster>
    </QueryClientProvider>,
  );
}
const section = (id: string) => document.querySelector<HTMLElement>('[data-detail-section="' + id + '"]')!;
const terms = (element: HTMLElement) => within(element).getAllByRole("term").map(item => item.textContent);

describe("readable payment match detail", () => {
  it.each(["/sites/shop"])(
    "renders a scoped match as a record with summary, sections and footer menu at %s",
    async (scope) => {
      const user = userEvent.setup();
      const fetchMock = vi.fn(async (request: Request) => {
        const pathname = new URL(request.url).pathname;
        if (pathname === "/api/admin/v1/sites/shop")
          return json({ data: { client_id: "shop", deleted_at: null, configuration: { name: "测试网站" } } });
        if (pathname === "/api/admin/v1" + scope + "/reconciliation/matches/" + matchId)
          return json({ data: paymentMatch });
        throw new Error("unexpected request " + pathname);
      });
      vi.stubGlobal("fetch", fetchMock);
      render(
        <QueryClientProvider client={queryClient}>
          <Toaster>
            <MemoryRouter initialEntries={[{
              pathname: scope + "/reconciliation/matches/" + matchId,
              state: { listReturn: { to: scope + "/reconciliation?tab=matches&q=book&cursor=next&page=2", state: { pagination: { previous: [null] } } } },
            }]}>
              <WorkspaceProvider>
                <Routes>
                  <Route path={scope + "/reconciliation/:kind/:resourceId"} element={<EvidenceDetail />} />
                </Routes>
              </WorkspaceProvider>
            </MemoryRouter>
          </Toaster>
        </QueryClientProvider>,
      );
      const summary = await screen.findByRole("group", { name: "关联概况" });
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/^收款关联$/);
      expect(within(summary).getByText("¥1.01", { exact: true })).toBeVisible();
      expect(within(summary).getByText("已关联", { exact: true })).toBeVisible();
      expect(summary.querySelector("[data-record-compare]")).toBeNull();
      expect(screen.getAllByRole("heading", { level: 2 }).map(heading => heading.textContent)).toEqual(["关联订单", "支付宝流水", "匹配依据", "处理记录"]);
      expect(screen.queryByRole("button", { name: "复制关联编号" })).not.toBeInTheDocument();
      expect(screen.queryByText(matchId)).not.toBeInTheDocument();
      expect(screen.getByRole("link", { name: "对账" })).toHaveAttribute("href", scope + "/reconciliation?tab=matches&q=book&cursor=next&page=2");

      const orderSection = section("order");
      expect(within(orderSection).getByRole("heading", { level: 3 })).toHaveTextContent(paymentMatch.order.product_name);
      expect(within(orderSection).getByRole("link", { name: /^查看订单/ })).toHaveAttribute("href", scope + "/orders/" + orderId);
      expect(terms(orderSection)).toEqual(["商户订单号", "业务网站", "应付金额", "实收金额", "创建时间", "收银台有效期至"]);

      const ledgerSection = section("ledger");
      expect(within(ledgerSection).getByRole("link", { name: /^查看流水/ })).toHaveAttribute("href", scope + "/reconciliation/ledger/" + paymentMatch.ledger_entry_id);
      expect(terms(ledgerSection)).toEqual(["交易金额", "交易时间", "交易对方", "支付宝备注", "支付宝流水号", "支付宝订单号", "内部流水编号"]);

      expect(terms(section("evidence"))).toEqual(["金额占用时间"]);
      expect(within(section("history")).getAllByRole("listitem").map(item => item.querySelector("span:nth-of-type(2)")!.textContent)).toEqual(["按金额和付款时间推断"]);

      const tools = screen.getByRole("button", { name: "更多操作，收款关联记录操作" });
      expect(tools.closest("[data-overlay-actions]")).not.toBeNull();
      await user.click(await recordAction("收款关联技术信息", "收款关联记录操作"));
      const technical = await screen.findByRole("dialog", { name: "收款关联技术信息" });
      await user.click(within(technical).getByRole("button", { name: "复制关联编号" }));
      expect(await navigator.clipboard.readText()).toBe(matchId);
      await user.click(within(technical).getByRole("button", { name: "复制内部订单编号" }));
      expect(await navigator.clipboard.readText()).toBe(paymentMatch.order.order_id);
      await user.click(within(technical).getByRole("button", { name: "复制网站 ID" }));
      expect(await navigator.clipboard.readText()).toBe(paymentMatch.order.api_client_id);
      expect(fetchMock.mock.calls.every(([request]) => request.method === "GET")).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(scope ? 2 : 1);
    },
  );

  it("keeps full transaction values, matching facts and manual reversal history visible", async () => {
    const user = userEvent.setup();
    const copy = vi.spyOn(navigator.clipboard, "writeText");
    const match: PaymentMatchDetail = {
      ...paymentMatch,
      evidence_type: "MANUAL",
      status: "REVERSED",
      creation_operation: {
        ...paymentMatch.creation_operation!,
        operation_type: "MANUAL_SETTLEMENT",
        actor_type: "ADMIN",
        actor_id: "关联管理员",
        reason: "完整关联理由第一行\n第二行，已核对原始凭据",
      },
      resolution_operation: {
        ...paymentMatch.resolution_operation!,
        operation_type: "REVERSE_SETTLEMENT",
        actor_type: "ADMIN",
        actor_id: "撤销管理员",
        reason: "完整撤销理由第一行\n第二行，归属有误",
      },
      ledger_entry: {
        ...paymentMatch.ledger_entry,
        amount_cents: 102,
        provider_order_no: "2026".repeat(40),
        merchant_order_no: "merchant-".repeat(30),
        memo: "多行交易备注第一行\n第二行",
      },
    };
    mount(<MatchRecord match={match} />);
    const summary = screen.getByRole("group", { name: "关联概况" });
    expect(summary.querySelector("[data-record-compare]")).toHaveTextContent("流水 ¥1.02（多收 ¥0.01）");
    expect(screen.getByText(match.ledger_entry.provider_order_no!)).toBeVisible();
    expect(screen.getByText(match.ledger_entry.merchant_order_no!)).toBeVisible();
    expect(screen.getByText("支付宝备注", { selector: "dt" }).nextElementSibling?.textContent).toBe(match.ledger_entry.memo);
    expect(screen.getByRole("heading", { name: "匹配依据" })).toBeVisible();
    expect(screen.getByText("金额占用时间")).toBeVisible();

    const history = within(section("history")).getAllByRole("listitem");
    expect(history.map(item => item.querySelector("span:nth-of-type(2)")!.textContent)).toEqual(["撤销收款关联", "管理员人工关联"]);
    expect(history[0]).toHaveTextContent("撤销管理员：完整撤销理由第一行");
    expect(history[0]).toHaveTextContent("第二行，归属有误");
    expect(history[1]).toHaveTextContent("关联管理员：完整关联理由第一行");
    expect(history[1]).toHaveTextContent("第二行，已核对原始凭据");

    await user.click(screen.getByRole("button", { name: "复制支付宝订单号" }));
    expect(copy).toHaveBeenCalledWith(match.ledger_entry.provider_order_no);
    await recordAction("收款关联技术信息", "收款关联记录操作");
    expect(screen.queryByRole("menuitem", { name: "撤销收款关联" })).not.toBeInTheDocument();
  });

  it("restores the footer menu trigger after cancelling a reversal with Escape", async () => {
    mount(<MatchRecord match={paymentMatch} />);
    const user = userEvent.setup();
    const trigger = screen.getByRole("button", { name: "更多操作，收款关联记录操作" });
    trigger.focus();
    await user.keyboard("{Enter}");
    await user.click(await screen.findByRole("menuitem", { name: "撤销收款关联" }));
    const dialog = await screen.findByRole("dialog", { name: "撤销收款关联？" });
    expect(within(dialog).getByText(paymentMatch.ledger_entry.provider_order_no!)).toBeVisible();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("keeps the same financial operation when retrying an uncertain reversal", async () => {
    const bodies: unknown[] = [];
    const fetchMock = vi.fn(async (request: Request) => {
      expect(new URL(request.url).pathname).toBe("/api/admin/v1/reconciliation/matches/" + matchId + "/actions/reverse");
      bodies.push(await request.json());
      return bodies.length === 1
        ? apiError("internal_error", "请求未完成", 503)
        : json({ data: {} });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue(undefined);
    mount(<MatchRecord match={paymentMatch} />);
    const user = userEvent.setup();
    await user.click(await recordAction("撤销收款关联", "收款关联记录操作"));
    const dialog = screen.getByRole("dialog", { name: "撤销收款关联？" });
    await user.type(within(dialog).getByLabelText("操作理由"), "核对原始凭据后撤销");
    await user.click(within(dialog).getByRole("button", { name: "确认撤销关联" }));
    await user.click(await screen.findByRole("button", { name: "重试上一次操作" }));
    await screen.findByText("关联已撤销");
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
  });

  it("omits the matching evidence section when no candidate exists", () => {
    const match: PaymentMatchDetail = { ...paymentMatch, candidate: null };
    mount(<MatchRecord match={match} />);
    expect(document.querySelector('[data-detail-section="evidence"]')).toBeNull();
    expect(within(section("history")).getAllByRole("listitem")).toHaveLength(1);
    expect(screen.queryByText("金额占用时间")).not.toBeInTheDocument();
  });
});
