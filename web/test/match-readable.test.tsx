import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
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

describe("readable payment match detail", () => {
  it.each(["/sites/shop"])(
    "separates readable facts into standard cards and keeps scoped navigation at %s",
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
      const card = await screen.findByRole("group", { name: "收款关联记录" });
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/^收款关联详情$/);
      expect(screen.getAllByRole("heading", { level: 2 }).map(heading => heading.textContent)).toEqual(["关联摘要与订单", "支付宝交易", "匹配依据与处理记录"]);
      for (const group of [card, screen.getByRole("group", { name: "支付宝交易" }), screen.getByRole("group", { name: "匹配依据与处理记录" })]) {
        expect(group).toHaveAttribute("data-size", "default");
        expect(group.querySelector('[data-slot="card-header"] .record-list-meta')).toBeNull();
        const facts = group.querySelectorAll('[data-detail-fields]');
        expect(facts.length).toBeGreaterThan(0);
        for (const factGroup of facts) {
          expect(factGroup).toHaveAttribute("data-layout", "flow");
          const terms = factGroup.querySelectorAll("dl > div > dt");
          expect(terms.length).toBeGreaterThan(0);
          for (const term of terms) expect(term.nextElementSibling?.tagName).toBe("DD");
        }
      }
      expect(screen.queryByRole("button", { name: "复制关联编号" })).not.toBeInTheDocument();
      expect(screen.queryByText(matchId)).not.toBeInTheDocument();
      expect(screen.getByRole("link", { name: "对账" })).toHaveAttribute("href", scope + "/reconciliation?tab=matches&q=book&cursor=next&page=2");
      expect(within(card).getByRole("link", { name: paymentMatch.order.product_name })).toHaveAttribute("href", scope + "/orders/" + orderId);
      expect(within(screen.getByRole("group", { name: "匹配依据与处理记录" })).getByRole("heading", { name: "匹配依据" })).toBeVisible();
      expect(screen.queryByText("撤销时间")).not.toBeInTheDocument();
      expect(within(card).getByRole("button", { name: "收款关联记录操作" }).closest('[data-slot="card-action"]')).not.toBeNull();
      await user.click(await recordAction("技术详情", "收款关联记录操作"));
      const technical = await screen.findByRole("dialog", { name: "技术详情" });
      await user.click(within(technical).getByRole("button", { name: "复制关联编号" }));
      expect(await navigator.clipboard.readText()).toBe(matchId);
      await user.click(within(technical).getByRole("button", { name: "复制内部订单编号" }));
      expect(await navigator.clipboard.readText()).toBe(paymentMatch.order.order_id);
      await user.click(within(technical).getByRole("button", { name: "复制客户端 ID" }));
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
        provider_order_no: "2026".repeat(40),
        merchant_order_no: "merchant-".repeat(30),
        memo: "多行交易备注第一行\n第二行",
      },
    };
    mount(<MatchCard match={match} density="comfortable" />);
    expect(screen.getByText(match.ledger_entry.provider_order_no!)).toBeVisible();
    expect(screen.getByText(match.ledger_entry.merchant_order_no!)).toBeVisible();
    expect(screen.getByText("多行交易备注第一行 第二行")).toBeVisible();
    expect(screen.getByRole("heading", { name: "匹配依据" })).toBeVisible();
    expect(screen.getByText("金额占用时间")).toBeVisible();
    expect(screen.getByText("完整关联理由第一行 第二行，已核对原始凭据")).toBeVisible();
    expect(screen.getByText("完整撤销理由第一行 第二行，归属有误")).toBeVisible();
    expect(screen.getByText("撤销管理员")).toBeVisible();
    expect(screen.getByText("关联管理员")).toBeVisible();
    expect(screen.getByText("撤销时间")).toBeVisible();
    expect(screen.getByRole("region", { name: "人工关联记录" })).toBeVisible();
    expect(screen.getByRole("region", { name: "撤销记录" })).toBeVisible();
    expect(screen.getByRole("group", { name: "匹配依据与处理记录" }).querySelectorAll('[data-slot="separator"]')).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "匹配依据" })).not.toBeInTheDocument();
    for (const label of ["商户订单号（业务网站）", "支付宝订单号", "支付宝商户单号", "支付宝交易备注", "金额占用时间", "关联理由", "撤销理由"]) {
      const field = screen.getByText(label, { selector: "dt" }).parentElement;
      expect(field).toHaveAttribute("data-field-wide", "true");
      expect(field?.closest('[data-detail-fields]')).toHaveAttribute("data-layout", "flow");
      expect(field?.querySelector("dd")).not.toBeEmptyDOMElement();
    }
    expect(screen.getByText("关联理由", { selector: "dt" }).nextElementSibling?.textContent).toBe(match.creation_operation!.reason);
    expect(screen.getByText("撤销理由", { selector: "dt" }).nextElementSibling?.textContent).toBe(match.resolution_operation!.reason);
    expect(screen.getByText("支付宝交易备注", { selector: "dt" }).nextElementSibling?.textContent).toBe(match.ledger_entry.memo);
    await user.click(screen.getByRole("button", { name: "复制支付宝订单号" }));
    expect(copy).toHaveBeenCalledWith(match.ledger_entry.provider_order_no);
    await recordAction("技术详情", "收款关联记录操作");
    expect(screen.queryByRole("menuitem", { name: "撤销错误关联" })).not.toBeInTheDocument();
  });

  it("restores the inline menu trigger after cancelling a reversal with Escape", async () => {
    mount(<MatchCard match={paymentMatch} density="comfortable" />);
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
    mount(<MatchCard match={paymentMatch} density="comfortable" />);
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

  it.each([undefined, "comfortable"] as const)("preserves the embedded layout and independent detail action (density=%s)", async (density) => {
    const { container } = mount(<MatchCard match={paymentMatch} embedded {...(density ? { density } : {})} />);
    expect(screen.queryByRole("link", { name: paymentMatch.order.product_name })).not.toBeInTheDocument();
    const trigger = screen.getByRole("button", { name: "收款关联记录操作" });
    expect(trigger.closest('[data-slot="card-content"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-slot="card"]')).toHaveLength(1);
    expect(screen.queryByRole("heading", { name: "关联摘要与订单" })).not.toBeInTheDocument();
    const facts = container.querySelectorAll('[data-detail-fields]');
    expect(facts.length).toBeGreaterThan(0);
    for (const factGroup of facts) {
      expect(factGroup).toHaveAttribute("data-density", "default");
      expect(factGroup).toHaveAttribute("data-layout", "columns");
    }
    expect(await recordAction("单独打开", "收款关联记录操作")).toHaveAttribute("href", "/reconciliation/matches/" + matchId);
  });

  it("restores focus after a unified association moves into history on successful reversal", async () => {
    let moveIntoHistory = () => {};
    function Transaction() {
      const [reversed, setReversed] = useState(false);
      moveIntoHistory = () => setReversed(true);
      return <main id="main-content" tabIndex={-1}>
        <MatchCard key={String(reversed)} transactionContext match={{ ...paymentMatch, status: reversed ? "REVERSED" : "SETTLED" }} />
      </main>;
    }
    vi.spyOn(queryClient, "invalidateQueries").mockImplementation(async () => { moveIntoHistory(); });
    const fetchMock = vi.fn(async (request: Request) => {
      expect(request.method).toBe("POST");
      expect(new URL(request.url).pathname).toBe("/api/admin/v1/reconciliation/matches/" + matchId + "/actions/reverse");
      return json({ data: {} });
    });
    vi.stubGlobal("fetch", fetchMock);
    mount(<Transaction />);
    const user = userEvent.setup();
    await user.click(await recordAction("撤销错误关联", "收款关联记录操作"));
    const dialog = await screen.findByRole("dialog", { name: "撤销收款关联？" });
    await user.type(within(dialog).getByLabelText("操作理由"), "已核对订单归属");
    await user.click(within(dialog).getByRole("button", { name: "确认撤销关联" }));
    await screen.findByRole("heading", { name: "已撤销的关联" });
    // Base UI resolves a container target to its first tabbable descendant.
    await waitFor(() => {
      expect(document.getElementById("main-content")).toContainElement(document.activeElement as HTMLElement);
      expect(document.activeElement).not.toBe(document.body);
      expect(document.activeElement?.isConnected).toBe(true);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not introduce separators or invented evidence when no candidate or reasons exist", () => {
    const match: PaymentMatchDetail = { ...paymentMatch, candidate: null };
    mount(<MatchCard match={match} density="comfortable" />);
    const card = screen.getByRole("group", { name: "匹配依据与处理记录" });
    expect(card.querySelectorAll('[data-slot="separator"]')).toHaveLength(0);
    expect(within(card).getByRole("region", { name: "关联记录" })).toBeVisible();
    expect(within(card).getByText("关联时间")).toBeVisible();
    expect(within(card).queryByText("金额占用时间")).not.toBeInTheDocument();
    expect(within(card).queryByText("关联理由")).not.toBeInTheDocument();
    expect(within(card).queryByText("撤销时间")).not.toBeInTheDocument();
  });
});
