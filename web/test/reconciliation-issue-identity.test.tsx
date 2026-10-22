import { render, screen, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { queryClient } from "../src/api/client";
import Reconciliation from "../src/pages/Reconciliation";
import { json } from "./fixtures";
import { mobileMedia } from "./mobile-media";

const orderA = "11111111-1111-4111-8111-111111111111";
const orderB = "22222222-2222-4222-8222-222222222222";
const ledgerA = "33333333-3333-4333-8333-333333333333";
const ledgerB = "44444444-4444-4444-8444-444444444444";

function orderContext(input: {
  orderId: string;
  merchantOrderNo: string;
  productName: string;
  siteName: string;
  ledgerEntryId: string;
}) {
  return {
    order_summary: {
      order_id: input.orderId,
      merchant_order_no: input.merchantOrderNo,
      product_name: input.productName,
      site_name: input.siteName,
      api_client_id: "default",
      requested_amount_cents: 5_000,
      payable_amount_cents: 5_020,
      received_amount_cents: null,
      payment_confirmed_at: null,
    },
    ledger_entry_summary: {
      ledger_entry_id: input.ledgerEntryId,
      external_event_id: "event-" + input.ledgerEntryId,
      occurred_at: "2026-10-01T10:00:00.000Z",
      amount_cents: 5_100,
      direction: "CREDIT",
      currency: "CNY",
      provider_order_no: null,
      merchant_order_no: input.merchantOrderNo,
      memo: null,
      other_account: "付款人 " + input.productName,
    },
    raw_event_summary: null,
  };
}

const exceptions = [
  {
    exception_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    exception_type: "AMOUNT_MISMATCH",
    status: "OPEN",
    reminder_ignored: false,
    created_at: "2026-10-01T10:01:00.000Z",
    order_id: orderA,
    ledger_entry_id: ledgerA,
    context: orderContext({
      orderId: orderA,
      merchantOrderNo: "merchant-alpha",
      productName: "测试商品甲",
      siteName: "Alpha 业务站",
      ledgerEntryId: ledgerA,
    }),
  },
  {
    exception_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    exception_type: "AMOUNT_MISMATCH",
    status: "OPEN",
    reminder_ignored: false,
    created_at: "2026-10-01T10:02:00.000Z",
    order_id: orderB,
    ledger_entry_id: ledgerB,
    context: orderContext({
      orderId: orderB,
      merchantOrderNo: "merchant-beta",
      productName: "测试商品乙",
      siteName: "Beta 业务站",
      ledgerEntryId: ledgerB,
    }),
  },
  {
    exception_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    exception_type: "UNMATCHED_CREDIT",
    status: "OPEN",
    reminder_ignored: false,
    created_at: "2026-10-01T10:03:00.000Z",
    order_id: null,
    ledger_entry_id: ledgerA,
    context: {
      order_summary: null,
      ledger_entry_summary: {
        ledger_entry_id: ledgerA,
        external_event_id: "unmatched-credit-event",
        occurred_at: "2026-10-01T09:58:00.000Z",
        amount_cents: 4_200,
        direction: "CREDIT",
        currency: "CNY",
        provider_order_no: null,
        merchant_order_no: null,
        memo: null,
        other_account: "买家张三",
      },
      raw_event_summary: null,
    },
  },
];

const conflicts = [
  {
    conflict_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    conflict_type: "INVALID_TIMESTAMP",
    status: "OPEN",
    reminder_ignored: false,
    created_at: "2026-10-01T11:01:00.000Z",
    external_event_id: "raw-event-alpha",
    raw_page_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    raw_event_id: "11111111-aaaa-4aaa-8aaa-111111111111",
    existing_ledger_entry_id: null,
    context: {
      order_summary: null,
      ledger_entry_summary: null,
      raw_event_summary: {
        raw_event_id: "11111111-aaaa-4aaa-8aaa-111111111111",
        external_event_id: "raw-event-alpha",
        occurred_at_text: "2026-10-01 18:00",
        amount_text: "12.34",
        direction_text: "收入",
        alipay_order_no: null,
        merchant_order_no: null,
        memo: null,
        other_account: "买家甲",
      },
    },
  },
  {
    conflict_id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    conflict_type: "INVALID_TIMESTAMP",
    status: "OPEN",
    reminder_ignored: false,
    created_at: "2026-10-01T11:02:00.000Z",
    external_event_id: "raw-event-beta",
    raw_page_id: "abababab-abab-4bab-8bab-abababababab",
    raw_event_id: "22222222-bbbb-4bbb-8bbb-222222222222",
    existing_ledger_entry_id: null,
    context: {
      order_summary: null,
      ledger_entry_summary: null,
      raw_event_summary: {
        raw_event_id: "22222222-bbbb-4bbb-8bbb-222222222222",
        external_event_id: "raw-event-beta",
        occurred_at_text: "2026-10-01 18:01",
        amount_text: "56.78",
        direction_text: "支出",
        alipay_order_no: null,
        merchant_order_no: null,
        memo: null,
        other_account: "买家乙",
      },
    },
  },
  {
    conflict_id: "99999999-9999-4999-8999-999999999999",
    conflict_type: "RAW_PAGE_VARIANT",
    status: "OPEN",
    reminder_ignored: false,
    created_at: "2026-10-01T11:03:00.000Z",
    external_event_id: null,
    raw_page_id: "acacacac-acac-4cac-8cac-acacacacacac",
    raw_event_id: null,
    existing_ledger_entry_id: null,
    context: {
      order_summary: null,
      ledger_entry_summary: null,
      raw_event_summary: null,
    },
  },
];

function mount(path: string) {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/reconciliation" element={<Reconciliation />} />
          <Route path="/orders/:id" element={<h1>订单详情</h1>} />
          <Route path="/reconciliation/transactions/:id" element={<h1>流水详情</h1>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function responseFor(pathname: string) {
  if (pathname === "/api/admin/v1/reconciliation/exceptions") {
    return json({ data: exceptions, page: { next_cursor: null } });
  }
  if (pathname === "/api/admin/v1/ledger/conflicts") {
    return json({ data: conflicts, page: { next_cursor: null } });
  }
  throw new Error("unexpected request: " + pathname);
}

describe("reconciliation issue identities", () => {
  beforeEach(() => {
    localStorage.clear();
    mobileMedia(1600);
  });

  it("distinguishes repeated financial exceptions by product, order and payment source", async () => {
    vi.stubGlobal("fetch", vi.fn(async (request: Request) =>
      responseFor(new URL(request.url).pathname),
    ));
    mount("/reconciliation?tab=exceptions");
    const table = await screen.findByRole("table", { name: "账务异常" });

    expect(within(table).getByRole("columnheader", { name: "关联记录" })).toBeVisible();
    expect(within(table).getAllByRole("link", { name: "实收金额不符" })).toHaveLength(2);

    const alpha = within(table).getByRole("link", {
      name: "查看订单：测试商品甲（merchant-alpha，Alpha 业务站）",
    });
    const beta = within(table).getByRole("link", {
      name: "查看订单：测试商品乙（merchant-beta，Beta 业务站）",
    });
    expect(alpha).toHaveAttribute("href", "/orders/" + orderA);
    expect(beta).toHaveAttribute("href", "/orders/" + orderB);
    expect(within(table).getByText("merchant-alpha", { exact: true })).toBeVisible();
    expect(within(table).getByText("merchant-beta", { exact: true })).toBeVisible();

    const unmatched = within(table).getByRole("link", {
      name: /查看流水：收入流水 .*42\.00，流水号 unmatched-credit-event/,
    });
    expect(unmatched).toHaveAttribute("href", "/reconciliation/transactions/" + ledgerA + "#source-" + ledgerA);
    expect(unmatched).toHaveTextContent("买家张三");
    expect(within(table).queryByText("查看订单")).not.toBeInTheDocument();
  });

  it.each([320, 390, 1600])("distinguishes two payments for the same order at %ipx", async (width) => {
    mobileMedia(width);
    const records = [ledgerA, ledgerB].map((ledgerEntryId, index) => {
      const context = orderContext({
        orderId: orderA,
        merchantOrderNo: "merchant-shared",
        productName: "同一商品",
        siteName: "同一业务站",
        ledgerEntryId,
      });
      return {
        ...exceptions[index]!,
        order_id: orderA,
        ledger_entry_id: ledgerEntryId,
        created_at: "2026-10-01T10:01:00.000Z",
        context: {
          ...context,
          ledger_entry_summary: {
            ...context.ledger_entry_summary,
            amount_cents: (width === 320 ? 999_999_999_998 : 1_002) + index,
            external_event_id: "same-order-payment-reference-" + (index + 1),
            occurred_at: "2026-10-01T10:00:00.000Z",
          },
        },
      };
    });
    vi.stubGlobal("fetch", vi.fn(async () =>
      json({ data: records, page: { next_cursor: null } }),
    ));
    mount("/reconciliation?tab=exceptions");
    const list = await screen.findByRole(width < 640 ? "list" : "table", { name: "账务异常" });

    const orderLinks = within(list).getAllByRole("link", {
      name: "查看订单：同一商品（merchant-shared，同一业务站）",
    });
    expect(orderLinks).toHaveLength(2);
    for (const orderLink of orderLinks) expect(orderLink).toHaveAttribute("href", "/orders/" + orderA);
    for (const [index, record] of records.entries()) {
      const payment = within(list).getByRole("link", {
        name: new RegExp("查看流水：收入流水 .*，流水号 " + record.context.ledger_entry_summary.external_event_id),
      });
      expect(payment).toBeVisible();
      expect(payment).toHaveAttribute("href", "/reconciliation/transactions/" + record.ledger_entry_id + "#source-" + record.ledger_entry_id);
      expect(payment).toHaveTextContent(width === 320 ? ["9,999,999,999.98", "9,999,999,999.99"][index]! : ["10.02", "10.03"][index]!);
      expect(payment).toHaveTextContent(record.context.ledger_entry_summary.external_event_id);
      expect(payment).toHaveTextContent("2026/10/01 18:00");
    }
    expect(list.querySelector("a a")).toBeNull();
  });

  it("shows raw event and fallback identities for repeated ledger conflicts on mobile", async () => {
    mobileMedia(390);
    vi.stubGlobal("fetch", vi.fn(async (request: Request) =>
      responseFor(new URL(request.url).pathname),
    ));
    mount("/reconciliation?tab=conflicts");
    const list = await screen.findByRole("list", { name: "账本冲突" });

    expect(within(list).getAllByRole("link", { name: "流水时间无法解析" })).toHaveLength(2);
    expect(within(list).getByText(/支付宝流水 · 收入 · ¥12\.34/)).toBeVisible();
    expect(within(list).getByText(/支付宝流水 · 支出 · ¥56\.78/)).toBeVisible();
    expect(within(list).getByText("买家甲")).toBeVisible();
    expect(within(list).getByText("买家乙")).toBeVisible();
    expect(within(list).getByText("raw-event-alpha", { exact: true })).toBeVisible();
    expect(within(list).getByText("raw-event-beta", { exact: true })).toBeVisible();
    expect(within(list).getByText(/支付宝流水页 #acacacac/)).toBeVisible();
    expect(within(list).getByText("暂无可关联的订单或单笔流水")).toBeVisible();
  });

  it.each([
    "2026-02-30T10:00:00Z",
    "2025-02-29T10:00:00+08:00",
    "2026-10-01T24:00:00Z",
    "2026-10-01T10:00:00.000Z",
  ])("preserves raw provider time %s without calendar correction", async (value) => {
    mobileMedia(390);
    const conflict = conflicts[0]!;
    vi.stubGlobal("fetch", vi.fn(async () => json({
      data: [{
        ...conflict,
        context: {
          ...conflict.context,
          raw_event_summary: { ...conflict.context.raw_event_summary!, occurred_at_text: value },
        },
      }],
      page: { next_cursor: null },
    })));
    mount("/reconciliation?tab=conflicts");
    const list = await screen.findByRole("list", { name: "账本冲突" });

    expect(within(list).getByText(value, { exact: true })).toBeVisible();
    expect(within(list).queryByText("2026/03/02 18:00")).not.toBeInTheDocument();
  });
});
