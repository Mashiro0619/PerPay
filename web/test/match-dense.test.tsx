import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { queryClient, type PaymentMatchDetail } from "../src/api/client";
import { MatchCard } from "../src/components/detail/PaymentEvidence";
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

describe("compact payment match detail", () => {
  it.each(["", "/sites/shop"])(
    "keeps a short heading, copyable identity and scoped navigation at %s",
    async (scope) => {
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
      const card = await screen.findByRole("group", { name: "收款关联记录" });
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/^收款关联详情$/);
      expect(screen.getByRole("button", { name: "复制关联编号" })).toBeVisible();
      expect(screen.getByRole("link", { name: "对账" })).toHaveAttribute("href", scope + "/reconciliation?tab=matches&q=book&cursor=next&page=2");
      expect(within(card).getByRole("link", { name: paymentMatch.order.product_name })).toHaveAttribute("href", scope + "/orders/" + orderId);
      expect(within(card).getByRole("heading", { name: "匹配依据" })).toBeVisible();
      expect(within(card).queryByText("撤销时间")).not.toBeInTheDocument();
      expect(within(card).getByRole("button", { name: "收款关联记录操作" }).closest('[data-slot="card-action"]')).not.toBeNull();
      expect(fetchMock.mock.calls.every(([request]) => request.method === "GET")).toBe(true);
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
        provider_order_no: "2026".repeat(40),
        merchant_order_no: "merchant-".repeat(30),
        memo: "多行交易备注第一行\n第二行",
      },
    };
    mount(<MatchCard match={match} density="dense" />);
    expect(screen.getByText(match.ledger_entry.provider_order_no!)).toBeVisible();
    expect(screen.getByText(match.ledger_entry.merchant_order_no!)).toBeVisible();
    expect(screen.getByText("多行交易备注第一行 第二行")).toBeVisible();
    expect(screen.getByRole("heading", { name: "匹配依据" })).toBeVisible();
    expect(screen.getByText("金额占用时间")).toBeVisible();
    expect(screen.getByText("完整关联理由第一行 第二行，已核对原始凭据")).toBeVisible();
    expect(screen.getByText("完整撤销理由第一行 第二行，归属有误")).toBeVisible();
    expect(screen.getByText("撤销管理员")).toBeVisible();
    expect(screen.getByText("撤销时间")).toBeVisible();
    expect(screen.queryByRole("button", { name: "匹配依据" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "复制支付宝订单号" }));
    expect(copy).toHaveBeenCalledWith(match.ledger_entry.provider_order_no);
    await recordAction("技术详情", "收款关联记录操作");
    expect(screen.queryByRole("menuitem", { name: "撤销错误关联" })).not.toBeInTheDocument();
  });

  it("restores the inline menu trigger after cancelling a reversal with Escape", async () => {
    mount(<MatchCard match={paymentMatch} density="dense" />);
    const user = userEvent.setup();
    const trigger = screen.getByRole("button", { name: "收款关联记录操作" });
    trigger.focus();
    await user.keyboard("{Enter}");
    await user.click(await screen.findByRole("menuitem", { name: "撤销错误关联" }));
    const dialog = await screen.findByRole("dialog", { name: "撤销收款关联？" });
    expect(within(dialog).getByText(paymentMatch.ledger_entry.provider_order_no!)).toBeVisible();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("keeps the same financial operation when retrying an uncertain inline reversal", async () => {
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
    mount(<MatchCard match={paymentMatch} density="dense" />);
    const user = userEvent.setup();
    await user.click(await recordAction("撤销错误关联", "收款关联记录操作"));
    const dialog = screen.getByRole("dialog", { name: "撤销收款关联？" });
    await user.type(within(dialog).getByLabelText("操作理由"), "核对原始凭据后撤销");
    await user.click(within(dialog).getByRole("button", { name: "确认撤销关联" }));
    await user.click(await screen.findByRole("button", { name: "重试上一次操作" }));
    await screen.findByText("关联已撤销");
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
  });

  it("preserves the default embedded layout and independent detail action", async () => {
    const { container } = mount(<MatchCard match={paymentMatch} embedded />);
    expect(screen.queryByRole("link", { name: paymentMatch.order.product_name })).not.toBeInTheDocument();
    const trigger = screen.getByRole("button", { name: "收款关联记录操作" });
    expect(trigger.closest('[data-slot="card-content"]')).not.toBeNull();
    expect(container.querySelector('[data-detail-density="dense"]')).toBeNull();
    expect(await recordAction("单独打开", "收款关联记录操作")).toHaveAttribute("href", "/reconciliation/matches/" + matchId);
  });
});
