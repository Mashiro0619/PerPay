import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import {
  queryClient,
  type ManualSettlementOrderCandidate,
  type ManualSettlementLedgerCandidate,
} from "../src/api/client";
import { FinancialDialog } from "../src/pages/FinancialDialog";
import { paymentMatch } from "./detail-fixtures";
import { json, apiError, order, ledger, orderId, ledgerId } from "./fixtures";
const recommendation = {
  amount_match: true,
  time_window_overlap: true,
  time_distance_milliseconds: 0,
};
const orderChoice: ManualSettlementOrderCandidate = {
  order: {
    ...paymentMatch.order,
    payment_status: "UNPAID",
    payment_basis: "NONE",
    received_amount_cents: null,
  },
  recommendation,
};
const ledgerChoice: ManualSettlementLedgerCandidate = {
  ledger_entry: ledger,
  recommendation,
};
function mount(
  props: Partial<React.ComponentProps<typeof FinancialDialog>> = {},
  handle?: (request: Request) => Promise<Response> | Response | undefined,
) {
  const requests: Request[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: Request) => {
      requests.push(request);
      const custom = handle?.(request);
      if (custom) return custom;
      const path = new URL(request.url).pathname;
      if (path.endsWith("/manual/orders"))
        return json({ data: [orderChoice], page: { next_cursor: null } });
      if (path.endsWith("/manual/ledger-entries"))
        return json({ data: [ledgerChoice], page: { next_cursor: null } });
      if (path.endsWith("/orders/" + orderId)) return json({ data: order });
      if (path.endsWith("/ledger-entries/" + ledgerId))
        return json({ data: ledger });
      return apiError("route_not_found", "unexpected test request", 404);
    }),
  );
  const success = vi.fn();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <FinancialDialog onClose={vi.fn()} onSuccess={success} {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...view, requests, success };
}
const chooseLedger = () =>
  screen.findByRole("button", { name: /^选择收入流水：/ });
const chooseOrder = () => screen.findByRole("button", { name: /^选择订单：/ });
describe("manual settlement selection instead of ID entry", () => {
  it.each(["order", "ledger", "none", "both"])(
    "supports the %s entry without requiring internal IDs",
    async (kind) => {
      const p =
        kind === "order"
          ? { initialOrderId: orderId, lockContext: true }
          : kind === "ledger"
            ? { initialLedgerId: ledgerId, lockContext: true }
            : kind === "both"
              ? {
                  initialOrderId: orderId,
                  initialLedgerId: ledgerId,
                  lockContext: true,
                }
              : {};
      const view = mount(p);
      const user = userEvent.setup();
      expect(screen.queryByLabelText("内部订单编号")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("收入流水编号")).not.toBeInTheDocument();
      if (kind === "ledger" || kind === "none") {
        await chooseOrder();
        expect(screen.getByText(/收银台已过期/)).toBeVisible();
        await user.click(await chooseOrder());
      }
      if (kind === "order" || kind === "none")
        await user.click(await chooseLedger());
      expect(await screen.findByLabelText("操作理由")).toBeVisible();
      expect(view.requests.filter((r) => r.method === "POST")).toHaveLength(0);
      expect(
        screen.getByRole("button", { name: "确认关联收款" }),
      ).toBeDisabled();
      expect(
        view.requests.filter((r) =>
          new URL(r.url).pathname.endsWith("/orders/" + orderId),
        ),
      ).toHaveLength(1);
      expect(
        view.requests.filter((r) =>
          new URL(r.url).pathname.endsWith("/ledger-entries/" + ledgerId),
        ),
      ).toHaveLength(1);
      if (kind === "both")
        expect(
          view.requests.filter((r) => r.url.includes("/manual/")),
        ).toHaveLength(0);
    },
  );
  it("offers all records when recommendations are empty, with literal search and cursor paging", async () => {
    const view = mount({ initialOrderId: orderId, lockContext: true }, (r) => {
      const u = new URL(r.url);
      if (!u.pathname.endsWith("/manual/ledger-entries")) return;
      if (u.searchParams.get("view") === "recommended")
        return json({ data: [], page: { next_cursor: null } });
      return json({
        data: [ledgerChoice],
        page: {
          next_cursor: u.searchParams.has("cursor") ? null : "next-page",
        },
      });
    });
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "查看全部可关联" }),
    );
    await chooseLedger();
    const input = screen.getByRole("searchbox", { name: "搜索收入流水" });
    const count = view.requests.length;
    await user.type(input, "中文😀%_");
    expect(view.requests).toHaveLength(count);
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(view.requests.at(-1)!.url).toContain(
        encodeURIComponent("中文😀%_"),
      ),
    );
    await chooseLedger();
    await user.click(screen.getByRole("button", { name: "下一页" }));
    await waitFor(() =>
      expect(view.requests.at(-1)!.url).toContain("cursor=next-page"),
    );
    await chooseLedger();
    await user.click(screen.getByRole("button", { name: "上一页" }));
    await waitFor(() =>
      expect(view.requests.at(-1)!.url).not.toContain("cursor="),
    );
    expect(view.requests.every((r) => r.method === "GET")).toBe(true);
  });
  it("clears previous evidence and reason when returning to select another record", async () => {
    const view = mount({ initialOrderId: orderId, lockContext: true });
    const user = userEvent.setup();
    await user.click(await chooseLedger());
    await user.type(await screen.findByLabelText("操作理由"), "旧理由");
    await user.click(screen.getByRole("button", { name: "返回选择" }));
    expect(screen.queryByLabelText("操作理由")).not.toBeInTheDocument();
    await user.click(await chooseLedger());
    expect(await screen.findByLabelText("操作理由")).toHaveValue("");
    expect(view.requests.every((r) => r.method === "GET")).toBe(true);
  });
  it("does not apply a late search response or select a stale list after query changes", async () => {
    let finish!: (response: Response) => void;
    const view = mount({ initialOrderId: orderId, lockContext: true }, (r) => {
      const u = new URL(r.url);
      if (!u.pathname.endsWith("/manual/ledger-entries")) return;
      if (u.searchParams.get("q") === "old")
        return new Promise((resolve) => {
          finish = resolve;
        });
      return json({
        data: u.searchParams.get("q") === "new" ? [] : [ledgerChoice],
        page: { next_cursor: null },
      });
    });
    const user = userEvent.setup();
    await chooseLedger();
    const input = screen.getByRole("searchbox", { name: "搜索收入流水" });
    await user.type(input, "old{Enter}");
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    const oldRequest = view.requests.at(-1)!;
    expect(
      screen.queryByRole("button", { name: /^选择收入流水：/ }),
    ).not.toBeInTheDocument();
    await user.clear(input);
    await user.type(input, "new{Enter}");
    await screen.findByText("没有符合条件的收入流水");
    expect(oldRequest.signal.aborted).toBe(true);
    await act(async () =>
      finish(json({ data: [ledgerChoice], page: { next_cursor: null } })),
    );
    expect(
      screen.queryByRole("button", { name: /^选择收入流水：/ }),
    ).not.toBeInTheDocument();
  });
  it("distinguishes failed reads from an empty list and lets the user retry or change the search", async () => {
    let failed = true;
    mount({ initialLedgerId: ledgerId, lockContext: true }, (r) =>
      new URL(r.url).pathname.endsWith("/manual/orders") && failed
        ? apiError("unavailable", "候选读取失败", 503)
        : undefined,
    );
    const user = userEvent.setup();
    await screen.findByText("候选读取失败");
    expect(screen.queryByText("没有推荐候选")).not.toBeInTheDocument();
    failed = false;
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(await chooseOrder()).toBeVisible();
  });
  it("locks the chosen pair after a lost write and retries the same operation without a new search", async () => {
    let posts = 0;
    const view = mount({ initialOrderId: orderId, lockContext: true }, (r) =>
      r.method === "POST"
        ? ++posts === 1
          ? Promise.reject(new TypeError("response lost"))
          : json({ data: {} })
        : undefined,
    );
    const user = userEvent.setup();
    await user.click(await chooseLedger());
    await user.type(await screen.findByLabelText("操作理由"), "核对所选记录");
    await user.click(screen.getByRole("button", { name: "确认关联收款" }));
    await screen.findByText("操作结果待确认");
    expect(
      screen.queryByRole("button", { name: "返回选择" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    const reason = screen.getByLabelText("操作理由");
    expect(reason).toHaveAttribute("readonly");
    fireEvent.change(reason, { target: { value: "不能替换" } });
    expect(reason).toHaveValue("核对所选记录");
    const reads = view.requests.filter((r) => r.method === "GET").length;
    await user.click(screen.getByRole("button", { name: "重试原操作" }));
    await waitFor(() => expect(view.success).toHaveBeenCalledOnce());
    const writes = view.requests.filter((r) => r.method === "POST");
    expect(await writes[0]!.clone().json()).toEqual(
      await writes[1]!.clone().json(),
    );
    expect(view.requests.filter((r) => r.method === "GET")).toHaveLength(reads);
  });
});
