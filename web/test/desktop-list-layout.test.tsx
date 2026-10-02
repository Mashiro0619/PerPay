import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  queryClient,
  type AdminWorkItem,
  type WebhookDeliverySummary,
} from "../src/api/client";
import { TestPaymentProvider } from "../src/components/test-payment-provider";
import { DataTable } from "../src/components/data-table";
import Orders from "../src/pages/Orders";
import WorkItems from "../src/pages/WorkItems";
import Reconciliation from "../src/pages/Reconciliation";
import Notifications from "../src/pages/Notifications";
import { json, order, orderId, ledgerId } from "./fixtures";
import { delivery, paymentMatch, matchId, deliveryId } from "./detail-fixtures";
import { mobileMedia } from "./mobile-media";

const longOrder = {
  ...order,
  merchant_order_no: "merchant-" + "1234567890".repeat(12),
};
const notification: WebhookDeliverySummary = {
  ...delivery.delivery,
  event: delivery.event,
  target: delivery.target,
};
const reminder: AdminWorkItem = {
  type: "FINANCIAL_EXCEPTION",
  status: "OPEN",
  exception_type: "UNMATCHED_CREDIT",
  candidate_id: null,
  resource_id: ledgerId,
  provider_account_key: "primary",
  order_id: null,
  ledger_entry_id: null,
  created_at: order.created_at,
  actionable_at: order.created_at,
  ignored_at: null,
  ignored_by: null,
  ended: false,
  detail_url: "/api/admin/v1/reconciliation/exceptions/" + ledgerId,
};
const lists = [
  {
    path: "/orders",
    element: <Orders />,
    data: [longOrder],
    hiddenColumn: "实收金额",
  },
  {
    path: "/work-items",
    element: <WorkItems />,
    data: [reminder],
    hiddenColumn: "提醒时间",
  },
  {
    path: "/reconciliation",
    element: <Reconciliation />,
    data: [paymentMatch],
    hiddenColumn: "关联订单",
  },
  {
    path: "/notifications",
    element: <Notifications />,
    data: [notification],
    hiddenColumn: "关联订单",
  },
];
function Location() {
  const location = useLocation();
  return (
    <output aria-label="当前地址">{location.pathname + location.search}</output>
  );
}
function mount(path: string, element: React.ReactNode) {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <TestPaymentProvider>
          <Routes>
            <Route path={path.split("?")[0]} element={element} />
            <Route path="/orders/:id" element={<h1>订单详情</h1>} />
            <Route
              path="/reconciliation/ledger/:id"
              element={<h1>流水详情</h1>}
            />
          </Routes>
          <Location />
        </TestPaymentProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
function pageResponse(data: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json({ data, page: { next_cursor: null } })),
  );
}
async function chooseMode(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
) {
  await user.click(screen.getByRole("button", { name: /^查询方式：/ }));
  await user.click(await screen.findByRole("menuitemradio", { name }));
}

describe("desktop business list composition", () => {
  beforeEach(() => {
    localStorage.clear();
    mobileMedia(1600);
  });

  it.each(lists)(
    "keeps search, filters and actions grouped with an in-header column menu on $path",
    async ({ path, element, data }) => {
      pageResponse(data);
      const view = mount(path, element);
      const table = await screen.findByRole("table");
      expect(screen.getAllByRole("search")).toHaveLength(1);
      expect(
        screen.queryByRole("button", { name: "筛选与排序" }),
      ).not.toBeInTheDocument();
      const row = view.container.querySelector("[data-list-toolbar-row]")!;
      expect(row.querySelector("form")).toBe(screen.getByRole("search"));
      const filters = row.querySelector("[data-list-desktop-filters]")!;
      const sort = row.querySelector("[data-list-desktop-sort]")!;
      const actions = row.querySelector("[data-list-desktop-actions]")!;
      expect(filters.parentElement).toBe(row);
      expect(sort.parentElement).toBe(row);
      expect(actions.parentElement).toBe(row);
      expect(
        filters.compareDocumentPosition(sort) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(
        sort.compareDocumentPosition(actions) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(screen.getByRole("button", { name: "显示列" }).closest("th")).toBe(
        within(table).getAllByRole("columnheader")[0],
      );
      expect(view.container.querySelector("[data-business-list]")).toHaveClass(
        "max-w-[1600px]",
        "mx-auto",
      );
      expect(table.querySelector("tbody td")).toHaveClass("py-2");
      expect(table.querySelector("tbody td")).not.toHaveClass("w-full");
    },
  );

  it.each(lists)(
    "uses the measured container and honors explicitly shown columns on $path",
    async ({ path, element, data, hiddenColumn }) => {
      let width = 400;
      const original = HTMLElement.prototype.getBoundingClientRect;
      vi.spyOn(
        HTMLElement.prototype,
        "getBoundingClientRect",
      ).mockImplementation(function (this: HTMLElement) {
        return this.hasAttribute("data-business-table")
          ? DOMRect.fromRect({ width, height: 200 })
          : original.call(this);
      });
      pageResponse(data);
      mount(path, element);
      await screen.findByRole("table");
      expect(screen.getAllByRole("columnheader")).toHaveLength(2);
      expect(
        screen.queryByRole("columnheader", { name: hiddenColumn }),
      ).not.toBeInTheDocument();
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "显示列" }));
      await user.click(
        await screen.findByRole("menuitemcheckbox", { name: hiddenColumn }),
      );
      await user.keyboard("{Escape}");
      expect(
        screen.getByRole("columnheader", { name: hiddenColumn }),
      ).toBeInTheDocument();
      width = 1300;
      act(() => window.dispatchEvent(new Event("resize")));
      expect(screen.getAllByRole("columnheader").length).toBeGreaterThan(3);
      width = 400;
      act(() => window.dispatchEvent(new Event("resize")));
      expect(
        screen.getByRole("columnheader", { name: hiddenColumn }),
      ).toBeInTheDocument();
    },
  );

  it.each([
    {
      path: "/reconciliation",
      element: <Reconciliation />,
      data: [paymentMatch],
      id: matchId,
    },
    {
      path: "/notifications",
      element: <Notifications />,
      data: [notification],
      id: deliveryId,
    },
  ])(
    "keeps technical identifiers out of primary content and retains related order navigation on $path",
    async ({ path, element, data, id }) => {
      pageResponse(data);
      mount(path, element);
      await screen.findByRole("table");
      expect(screen.queryByText(id, { exact: true })).not.toBeInTheDocument();
      const related = screen.getByRole("link", { name: "查看订单" });
      expect(related).toHaveAttribute("href", "/orders/" + orderId);
      expect(screen.getAllByRole("columnheader")[1]).toHaveTextContent(
        "关联订单",
      );
      expect(related).not.toHaveTextContent("…");
    },
  );

  it("does not truncate merchant numbers or alter the overview table's default density", async () => {
    pageResponse([longOrder]);
    const view = mount("/orders", <Orders />);
    const number = await screen.findByText(longOrder.merchant_order_no, {
      exact: true,
    });
    expect(number).toHaveClass("break-all");
    expect(number).not.toHaveClass("truncate");
    view.unmount();
    render(
      <MemoryRouter>
        <DataTable data={[longOrder]} />
      </MemoryRouter>,
    );
    expect(screen.getByText(longOrder.merchant_order_no)).toHaveClass(
      "truncate",
    );
    expect(screen.getByRole("table").querySelector("tbody td")).toHaveClass(
      "py-3",
    );
    expect(
      screen.queryByRole("button", { name: "显示列" }),
    ).not.toBeInTheDocument();
  });

  it("keeps keyword and exact drafts, mode and URL filters when crossing breakpoints", async () => {
    const media = mobileMedia(1440);
    pageResponse([order]);
    mount(
      "/orders?q=applied&payment=UNPAID&source=overview&cursor=next&page=3",
      <Orders />,
    );
    const user = userEvent.setup();
    const keyword = screen.getByRole("searchbox");
    await user.clear(keyword);
    await user.type(keyword, "尚未提交的关键词");
    await chooseMode(user, "内部订单编号");
    await user.type(screen.getByRole("searchbox", { name: "订单号" }), orderId);
    expect(
      screen.getByRole("button", { name: "查询方式：内部订单编号" }),
    ).toHaveTextContent("内部订单编号");
    media.resize(390);
    expect(screen.getByRole("searchbox", { name: "订单号" })).toHaveValue(
      orderId,
    );
    await user.click(screen.getByRole("button", { name: /^筛选与排序/ }));
    media.resize(1440);
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(screen.getAllByRole("search")).toHaveLength(1);
    expect(screen.getByRole("searchbox", { name: "订单号" })).toHaveValue(
      orderId,
    );
    await chooseMode(user, "关键词");
    expect(screen.getByRole("searchbox")).toHaveValue("尚未提交的关键词");
    expect(screen.getByLabelText("当前地址")).toHaveTextContent(
      "/orders?q=applied&payment=UNPAID&source=overview&cursor=next&page=3",
    );
  });

  it.each([
    {
      mode: "商户订单号",
      value: order.merchant_order_no,
      path: "/orders",
      element: <Orders />,
      data: [order],
      title: "订单详情",
    },
    {
      mode: "内部订单编号",
      value: orderId,
      path: "/orders",
      element: <Orders />,
      data: [order],
      title: "订单详情",
    },
    {
      mode: "流水编号",
      value: ledgerId,
      path: "/reconciliation",
      element: <Reconciliation />,
      data: [paymentMatch],
      title: "流水详情",
    },
  ])(
    "preserves exact lookup semantics for $mode on desktop",
    async ({ mode, value, path, element, data, title }) => {
      const requests: Request[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (request: Request) => {
          requests.push(request);
          return /\/(?:orders|matches)$/.test(new URL(request.url).pathname)
            ? json({ data, page: { next_cursor: null } })
            : json({ data: order });
        }),
      );
      mount(path, element);
      const user = userEvent.setup();
      await chooseMode(user, mode);
      await user.type(screen.getByRole("searchbox"), value);
      await user.click(screen.getByRole("button", { name: "查找" }));
      expect(await screen.findByRole("heading", { name: title })).toBeVisible();
      expect(requests.every((request) => request.method === "GET")).toBe(true);
    },
  );

  it("keeps the desktop bulk-ignore scope on applied filters rather than the search draft", async () => {
    pageResponse([reminder]);
    mount("/work-items?type=FINANCIAL_EXCEPTION&q=applied", <WorkItems />);
    const user = userEvent.setup();
    await screen.findByRole("table");
    const search = screen.getByRole("searchbox");
    await user.clear(search);
    await user.type(search, "not-submitted");
    const trigger = screen.getByRole("button", { name: "忽略当前筛选结果" });
    await user.click(trigger);
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent("applied");
    expect(dialog).not.toHaveTextContent("not-submitted");
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
