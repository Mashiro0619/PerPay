import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, MemoryRouter, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BusinessTable,
  type BusinessColumn,
} from "../src/components/business-table";
import { ListColumnsProvider } from "../src/components/list-columns";
import { ListQueryToolbar } from "../src/components/list-query-toolbar";
import { Button } from "../src/components/ui/button";
import { useListQuery, type ListQueryControl } from "../src/lib/list-query";
import { mobileMedia } from "./mobile-media";

const record = {
  id: "record-1",
  title: "服务订阅",
  amount: "¥129.01",
  status: "已确认",
  reference: "REFERENCE-123456",
};
type SummaryRecord = typeof record;
const tableId = "business-summary-test";
const storageKey = "perpay.table-columns.v2." + tableId;
const sortFields = ["created_at", "payable_amount_cents"] as const;

function columns(onAction: () => void = () => {}): BusinessColumn<SummaryRecord>[] {
  return [
    {
      id: "identity",
      label: "记录",
      hideable: false,
      layout: "identity",
      cell: (item, context) => (
        <div>
          <Link data-row-link to={"/records/" + item.id}>
            {item.title}
          </Link>
          {context.showInSummary("reference") && <span>{item.reference}</span>}
        </div>
      ),
    },
    {
      id: "display_amount",
      label: "金额",
      sortBy: "payable_amount_cents",
      layout: "amount",
      summaryDefault: true,
      cell: (item) => item.amount,
    },
    {
      id: "status",
      label: "状态",
      layout: "status",
      summaryDefault: true,
      responsive: { minWidthRem: 48, basis: "container" },
      cell: (item) => item.status,
    },
    {
      id: "reference",
      label: "跟踪编号",
      summaryDefault: false,
      responsive: { minWidthRem: 64, basis: "container" },
      cell: (item) => item.reference,
    },
    {
      id: "actions",
      label: "操作",
      hideable: false,
      layout: "actions",
      cell: () => (
        <>
          <Link to="/related">关联订单</Link>
          <Button onClick={onAction}>复制编号</Button>
        </>
      ),
    },
  ];
}

function CurrentLocation() {
  const location = useLocation();
  return <output aria-label="当前地址">{location.pathname + location.search}</output>;
}

function mountSummary(onAction = vi.fn(), specs = columns(onAction)) {
  return render(
    <MemoryRouter initialEntries={["/records"]}>
      <BusinessTable
        id={tableId}
        aria-label="记录列表"
        items={[record]}
        columns={specs}
        rowId={(item) => item.id}
        columnsMenu={false}
      />
      <CurrentLocation />
    </MemoryRouter>,
  );
}

function ListHarness() {
  const control = useListQuery(sortFields, "created_at", "desc");
  return (
    <ListColumnsProvider>
      <ListQueryToolbar
        label="记录关键词搜索"
        control={control}
        sorts={[
          { value: "created_at", label: "创建时间" },
          { value: "payable_amount_cents", label: "金额" },
        ]}
      />
      <BusinessTable
        id={tableId}
        aria-label="记录列表"
        items={[record]}
        columns={columns()}
        rowId={(item) => item.id}
        control={control}
      />
      <CurrentLocation />
    </ListColumnsProvider>
  );
}

beforeEach(() => {
  localStorage.clear();
  mobileMedia();
});

describe("business summaries", () => {
  it("switches at the available container's 40rem boundary and mounts each record once", () => {
    mobileMedia(1440);
    let containerWidth = 639;
    const original = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        return this.hasAttribute("data-business-table")
          ? DOMRect.fromRect({ width: containerWidth, height: 200 })
          : original.call(this);
      },
    );
    const view = mountSummary();
    expect(screen.getByRole("list", { name: "记录列表" })).toBeVisible();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: record.title })).toHaveLength(1);
    expect(screen.getByText(record.status)).toBeVisible();
    expect(screen.queryByText(record.reference)).not.toBeInTheDocument();

    containerWidth = 640;
    act(() => window.dispatchEvent(new Event("resize")));
    expect(screen.getByRole("table", { name: "记录列表" })).toBeVisible();
    expect(screen.queryByRole("list", { name: "记录列表" })).not.toBeInTheDocument();
    expect(view.container.querySelectorAll("[data-business-row]")).toHaveLength(1);
    expect(screen.getAllByRole("link", { name: record.title })).toHaveLength(1);
  });

  it("opens the primary record from summary whitespace without adding another tab stop", async () => {
    mountSummary();
    const item = screen.getByRole("listitem");
    expect(item).not.toHaveAttribute("tabindex");
    await userEvent.setup().click(item);
    expect(screen.getByLabelText("当前地址").textContent).toBe("/records/record-1");
  });

  it("keeps nested actions and related links independent from the primary record", async () => {
    const onAction = vi.fn();
    mountSummary(onAction);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "复制编号" }));
    expect(onAction).toHaveBeenCalledOnce();
    expect(screen.getByLabelText("当前地址").textContent).toBe("/records");
    await user.click(screen.getByRole("link", { name: "关联订单" }));
    expect(screen.getByLabelText("当前地址").textContent).toBe("/related");
  });

  it("keeps selected secondary fields in preferences while expanding each field once without navigation", async () => {
    const preferences = { status: false, reference: true };
    localStorage.setItem(storageKey, JSON.stringify(preferences));
    const view = mountSummary();
    const user = userEvent.setup();
    expect(screen.getByText(record.amount)).toBeVisible();
    expect(screen.queryByText(record.status)).not.toBeInTheDocument();
    expect(screen.queryByText(record.reference)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "展开信息" }));
    expect(screen.getAllByText(record.reference)).toHaveLength(1);
    expect(screen.getByText(record.reference)).toBeVisible();
    expect(screen.getByLabelText("当前地址")).toHaveTextContent(/^\/records$/);
    expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual(preferences);
    await user.click(screen.getByRole("button", { name: "收起信息" }));
    expect(screen.queryByText(record.reference)).not.toBeInTheDocument();
    view.unmount();
    mountSummary();
    expect(screen.getByRole("button", { name: "展开信息" })).toHaveAttribute("aria-expanded", "false");
    expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual(preferences);
  });

  it("allows placement overrides while identity and actions stay primary and visibility remains independent", async () => {
    localStorage.setItem(storageKey, JSON.stringify({ reference: true }));
    const specs = columns().map((column) => ({
      ...column,
      summaryPriority: column.id === "reference" ? "primary" as const : "details" as const,
    }));
    mountSummary(vi.fn(), specs);
    expect(screen.getByRole("link", { name: record.title })).toBeVisible();
    expect(screen.getByRole("button", { name: "复制编号" })).toBeVisible();
    expect(screen.getByRole("link", { name: "关联订单" })).toBeVisible();
    expect(screen.getByText(record.reference)).toBeVisible();
    expect(screen.queryByText(record.amount)).not.toBeInTheDocument();
    expect(screen.queryByText(record.status)).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "展开信息" }));
    for (const value of [record.reference, record.amount, record.status]) {
      expect(screen.getAllByText(value)).toHaveLength(1);
    }
    expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual({ reference: true });
  });

  it("leaves selected summary text available for copying", () => {
    mountSummary();
    const amount = screen.getByText(record.amount);
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(amount);
    selection.removeAllRanges();
    selection.addRange(range);
    try {
      fireEvent.click(amount);
      expect(selection.toString()).toBe(record.amount);
      expect(screen.getByLabelText("当前地址").textContent).toBe("/records");
    } finally {
      selection.removeAllRanges();
    }
  });

  it("forwards modified and middle clicks to the native link without handling right clicks", () => {
    mountSummary();
    const primary = screen.getByRole("link", { name: record.title });
    const forwardedClick = vi.fn((event: Event) => event.preventDefault());
    const forwardedAux = vi.fn((event: Event) => event.preventDefault());
    primary.addEventListener("click", forwardedClick);
    primary.addEventListener("auxclick", forwardedAux);
    const item = screen.getByRole("listitem");
    fireEvent.click(item, { ctrlKey: true });
    expect(forwardedClick).toHaveBeenCalledOnce();
    expect(forwardedClick.mock.calls[0]![0]).toMatchObject({
      button: 0,
      ctrlKey: true,
    });
    fireEvent(
      item,
      new MouseEvent("auxclick", {
        bubbles: true,
        cancelable: true,
        button: 1,
        shiftKey: true,
      }),
    );
    expect(forwardedAux).toHaveBeenCalledOnce();
    expect(forwardedAux.mock.calls[0]![0]).toMatchObject({
      button: 1,
      shiftKey: true,
    });
    fireEvent(item, new MouseEvent("auxclick", { bubbles: true, button: 2 }));
    expect(forwardedAux).toHaveBeenCalledOnce();
    expect(screen.getByLabelText("当前地址").textContent).toBe("/records");
  });

  it("keeps an unsent search draft while sharing field choices between the mobile display sheet and desktop menu", async () => {
    const media = mobileMedia(1440);
    const initial = "/records?q=applied&cursor=next&page=3&source=overview";
    const view = render(
      <MemoryRouter initialEntries={[initial]}>
        <ListHarness />
      </MemoryRouter>,
    );
    const user = userEvent.setup();
    const trigger = screen.getByRole("button", { name: "显示列" });
    expect(view.container.querySelector("[data-list-columns-slot]")).toContainElement(trigger);
    expect(trigger.closest("th")).toBeNull();
    const search = screen.getByRole("searchbox");
    await user.clear(search);
    await user.type(search, "尚未提交的关键词");

    media.resize(390);
    expect(screen.queryByRole("button", { name: "显示列" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "更多列表操作" })).toHaveLength(1);
    expect(screen.getByRole("searchbox")).toHaveValue("尚未提交的关键词");
    expect(screen.getByRole("list", { name: "记录列表" })).toBeVisible();
    const more = screen.getByRole("button", { name: "更多列表操作" });
    await user.click(more);
    await user.click(await screen.findByRole("menuitem", { name: "列表显示" }));
    const sheet = await screen.findByRole("dialog", { name: "列表显示" });
    expect(document.querySelectorAll("[data-list-columns-slot]")).toHaveLength(1);
    expect(within(sheet).getByRole("checkbox", { name: "状态" })).toHaveAttribute("aria-checked", "true");
    expect(within(sheet).getByRole("checkbox", { name: "记录" })).toHaveAttribute("aria-disabled", "true");
    await user.click(within(sheet).getByRole("checkbox", { name: "状态" }));
    await user.click(within(sheet).getByRole("checkbox", { name: "跟踪编号" }));
    expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual({
      status: false,
      reference: true,
    });
    expect(screen.queryByText(record.status)).not.toBeInTheDocument();
    expect(screen.queryByText(record.reference)).not.toBeInTheDocument();
    await user.click(within(sheet).getByRole("button", { name: "完成" }));
    expect(more).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "展开信息" }));
    expect(screen.getByText(record.reference)).toBeVisible();
    const reference = screen.getByText(record.reference).closest<HTMLElement>(".business-summary-field")!;
    expect(within(reference).getByText("跟踪编号")).toBeVisible();
    media.resize(1440);
    expect(screen.getByRole("table", { name: "记录列表" })).toBeVisible();
    expect(screen.queryByRole("columnheader", { name: "状态" })).not.toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "跟踪编号" })).toBeVisible();
    expect(view.container.querySelectorAll("[data-list-columns-slot]")).toHaveLength(1);
    expect(screen.getByRole("searchbox")).toHaveValue("尚未提交的关键词");
    expect(screen.getByLabelText("当前地址").textContent).toBe(initial);

    media.resize(390);
    await user.click(screen.getByRole("button", { name: "更多列表操作" }));
    await user.click(await screen.findByRole("menuitem", { name: "列表显示" }));
    await user.click(await screen.findByRole("button", { name: "恢复默认列" }));
    await user.click(screen.getByRole("button", { name: "完成" }));
    expect(screen.getByText(record.status)).toBeVisible();
    expect(screen.queryByText(record.reference)).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual({});
    expect(screen.getByRole("searchbox")).toHaveValue("尚未提交的关键词");
    expect(screen.getByLabelText("当前地址").textContent).toBe(initial);
  });

  it("maps a displayed column id to its server sort field in both directions", async () => {
    mobileMedia(1440);
    const setSort = vi.fn();
    const control: ListQueryControl = {
      query: { q: "", sortBy: "payable_amount_cents", sortOrder: "desc" },
      setSort,
      setKeyword: vi.fn(),
      clear: vi.fn(),
      update: vi.fn(),
    };
    render(
      <MemoryRouter>
        <BusinessTable
          id={tableId}
          items={[record]}
          columns={columns()}
          rowId={(item) => item.id}
          control={control}
          columnsMenu={false}
        />
      </MemoryRouter>,
    );
    const header = screen.getByRole("columnheader", { name: "金额" });
    expect(header).toHaveAttribute("aria-sort", "descending");
    await userEvent.setup().click(within(header).getByRole("button", { name: "金额" }));
    expect(setSort).toHaveBeenCalledExactlyOnceWith("payable_amount_cents", "asc");
  });
});
