import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation, useSearchParams } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ListQueryToolbar,
  type ListQueryLookup,
} from "../src/components/list-query-toolbar";
import { useListQuery, ORDER_SORT_FIELDS } from "../src/lib/list-query";
import { mobileMedia } from "./mobile-media";
import { CreatedDateFilter } from "../src/components/created-date-filter";
import { LedgerAmountFilter } from "../src/components/ledger-amount-filter";
import { LEDGER_DATE_FIELDS, LEDGER_ASSOCIATED_DATE_FIELDS } from "../src/lib/ledger-filters";
import { ListColumnsProvider } from "../src/components/list-columns";
import { ListDensityProvider, LIST_DENSITY_KEY } from "../src/components/list-density";
import { ListActionsMenu } from "../src/components/list-actions-menu";
import { DropdownMenuItem } from "../src/components/ui/dropdown-menu";
const sorts = [
  { value: "created_at", label: "创建时间" },
  { value: "payable_amount_cents", label: "应付金额" },
];
const options = [
  { value: "", label: "全部付款状态" },
  { value: "UNPAID", label: "未付款" },
];
function Harness({
  lookup,
  disabled = false,
  updated,
  toolbar = {},
}: {
  lookup?: ListQueryLookup;
  disabled?: boolean;
  updated?: (values: Record<string, string | null>) => void;
  toolbar?: Partial<React.ComponentProps<typeof ListQueryToolbar>>;
}) {
  const query = useListQuery(ORDER_SORT_FIELDS, "created_at", "desc");
  const [search] = useSearchParams();
  const location = useLocation();
  return (
    <>
      <ListQueryToolbar
        label="订单关键词搜索"
        sorts={sorts}
        lookup={lookup}
        disabled={disabled}
        control={{
          ...query,
          update: (values) => {
            updated?.(values);
            query.update(values);
          },
        }}
        filters={[
          {
            key: "payment",
            label: "付款状态",
            value: search.get("payment") ?? "",
            options,
          },
        ]}
        {...toolbar}
      />
      <output aria-label="查询地址">{location.search}</output>
    </>
  );
}
function mount(
  props: React.ComponentProps<typeof Harness> = {},
  url = "/orders?cursor=next&page=3&source=overview",
) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Harness {...props} />
    </MemoryRouter>,
  );
}
const address = () =>
  new URLSearchParams(screen.getByLabelText("查询地址").textContent ?? "");
async function choose(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
  value: string,
) {
  await user.click(screen.getByLabelText(name, { exact: true }));
  await user.click(await screen.findByRole("option", { name: value }));
}

describe("mobile list query hierarchy", () => {
  beforeEach(() => {
    mobileMedia();
  });
  it.each([768, 844, 1023])(
    "keeps narrow tablet and landscape tools compact at %ipx",
    (width) => {
      const media = mobileMedia(width);
      mount();
      expect(
        screen.getByRole("button", { name: "筛选与排序" }),
      ).toBeInTheDocument();
      expect(
        screen.queryByLabelText("排序字段", { exact: true }),
      ).not.toBeInTheDocument();
      media.resize(1024);
      expect(
        screen.queryByLabelText("排序字段", { exact: true }),
      ).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "筛选与排序" })).not.toBeInTheDocument();
      expect(screen.getByRole("searchbox")).toBeVisible();
    },
  );
  it("keeps only one search form and hides sort/filter controls until requested", () => {
    mount();
    expect(screen.getAllByRole("search")).toHaveLength(1);
    expect(
      screen.queryByLabelText("排序字段", { exact: true }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("付款状态", { exact: true }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "筛选与排序" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("searchbox")).toHaveAttribute(
      "placeholder",
      "输入关键词",
    );
  });

  it("applies filters and sort in one update, preserving keyword/context and resetting pagination once", async () => {
    const updated = vi.fn();
    mount({ updated }, "/orders?q=kept&source=overview&cursor=next&page=3");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "筛选与排序" }));
    await choose(user, "付款状态", "未付款");
    await choose(user, "排序字段", "应付金额");
    await user.click(
      within(screen.getByRole("group", { name: "排序方向" })).getByRole(
        "button",
        { name: "升序" },
      ),
    );
    expect(updated).not.toHaveBeenCalled();
    expect(address().get("cursor")).toBe("next");
    await user.click(screen.getByRole("button", { name: "应用" }));
    expect(updated).toHaveBeenCalledExactlyOnceWith({
      payment: "UNPAID",
      sort_by: "payable_amount_cents",
      sort_order: "asc",
    });
    expect(Object.fromEntries(address())).toEqual({
      q: "kept",
      source: "overview",
      payment: "UNPAID",
      sort_by: "payable_amount_cents",
      sort_order: "asc",
    });
    expect(screen.getByLabelText("当前查询条件")).toHaveTextContent(
      "付款状态：未付款",
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /筛选与排序/ })).toHaveFocus(),
    );
  });

  it("discards cancelled edits, and applying unchanged settings does not reset a later page", async () => {
    const updated = vi.fn();
    mount({ updated });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "筛选与排序" }));
    await choose(user, "付款状态", "未付款");
    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(updated).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "筛选与排序" }));
    expect(
      screen.getByLabelText("付款状态", { exact: true }),
    ).toHaveTextContent("全部付款状态");
    await user.click(screen.getByRole("button", { name: "应用" }));
    expect(updated).not.toHaveBeenCalled();
    expect(address().get("page")).toBe("3");
  });

  it("switches keyword/exact lookup modes without changing their semantics or losing drafts", async () => {
    const onSubmit = vi.fn();
    mount({
      lookup: {
        inputLabel: "订单号",
        inputName: "order-query",
        maxLength: 128,
        onSubmit,
        modes: [
          {
            value: "merchant",
            label: "商户订单号",
            placeholder: "输入完整商户订单号",
          },
        ],
      },
    });
    const user = userEvent.setup();
    await user.type(screen.getByRole("searchbox"), "商品名称{Enter}");
    expect(address().get("q")).toBe("商品名称");
    expect(onSubmit).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "查询方式：关键词" }));
    await user.click(
      await screen.findByRole("menuitemradio", { name: "商户订单号" }),
    );
    expect(screen.getAllByRole("search")).toHaveLength(1);
    const input = screen.getByRole("searchbox", { name: "订单号" });
    expect(input).toHaveAttribute("maxlength", "128");
    await user.type(input, "  merchant/%_order  {Enter}");
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith(
      "merchant",
      "merchant/%_order",
    );
    expect(address().get("q")).toBe("商品名称");
    await user.click(
      screen.getByRole("button", { name: "查询方式：商户订单号" }),
    );
    await user.click(
      await screen.findByRole("menuitemradio", { name: "关键词" }),
    );
    expect(screen.getByRole("searchbox")).toHaveValue("商品名称");
  });

  it("keeps Unicode keyword validation and clears applied conditions without dropping unrelated parameters", async () => {
    mount(
      {},
      "/orders?q=kept&payment=UNPAID&source=overview&cursor=next&page=3&sort_order=asc",
    );
    const user = userEvent.setup();
    const input = screen.getByRole("searchbox");
    await user.clear(input);
    await user.type(input, "😀".repeat(101));
    await user.click(screen.getByRole("button", { name: "搜索" }));
    expect(
      screen.getByText("关键词最多 100 个字符。"),
    ).toBeInTheDocument();
    expect(address().get("q")).toBe("kept");
    await user.click(screen.getByRole("button", { name: "清除搜索和筛选" }));
    expect(Object.fromEntries(address())).toEqual({
      source: "overview",
      sort_order: "asc",
    });
    expect(screen.queryByLabelText("当前查询条件")).not.toBeInTheDocument();
  });

  it("retains search text and removes the mobile overlay when resized to desktop", async () => {
    const media = mobileMedia();
    mount();
    const user = userEvent.setup();
    await user.type(screen.getByRole("searchbox"), "未提交内容");
    await user.click(screen.getByRole("button", { name: "筛选与排序" }));
    media.resize(1280);
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("searchbox")).toHaveValue("未提交内容");
    expect(
      screen.queryByLabelText("排序字段", { exact: true }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "筛选与排序" })).not.toBeInTheDocument();
    media.resize(390);
    expect(screen.getByRole("searchbox")).toHaveValue("未提交内容");
    expect(
      screen.queryByLabelText("排序字段", { exact: true }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "筛选与排序" })).toBeVisible();
  });

  it("keeps protected operations from changing queries while disabled", () => {
    mount({ disabled: true });
    expect(screen.getByRole("searchbox")).toBeDisabled();
    expect(screen.getByRole("button", { name: "筛选与排序" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "搜索" })).toBeDisabled();
  });
});

describe("compact list display and staged filters", () => {
  beforeEach(() => {
    mobileMedia();
    localStorage.removeItem(LIST_DENSITY_KEY);
  });

  it("separates leading state from the two action controls and appends display settings to the existing More menu", async () => {
    const refresh = vi.fn();
    const { container } = mount({ toolbar: {
      mobileLeading: <div role="group" aria-label="显示范围"><button>待处理</button><button>已忽略</button></div>,
      mobileActions: <ListActionsMenu label="更多提醒操作">{() => <DropdownMenuItem onClick={refresh}>刷新</DropdownMenuItem>}</ListActionsMenu>,
    } });
    const leading = container.querySelector("[data-list-mobile-leading]")!;
    const actions = container.querySelector("[data-list-mobile-actions]")!;
    expect(within(leading as HTMLElement).getByRole("group", { name: "显示范围" })).toBeVisible();
    expect(within(actions as HTMLElement).getAllByRole("button")).toHaveLength(2);
    expect(within(actions as HTMLElement).queryByRole("group", { name: "显示范围" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "列表密度" })).not.toBeInTheDocument();
    const user = userEvent.setup();
    const more = screen.getByRole("button", { name: "更多提醒操作" });
    await user.click(more);
    await user.click(await screen.findByRole("menuitem", { name: "刷新" }));
    expect(refresh).toHaveBeenCalledOnce();
    await user.click(more);
    await user.click(await screen.findByRole("menuitem", { name: "列表显示" }));
    expect(await screen.findByRole("dialog", { name: "列表显示" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "完成" }));
    await waitFor(() => expect(more).toHaveFocus());
  });

  it("offers density in the display sheet, persists changes and preserves an unsent search draft", async () => {
    render(<ListDensityProvider><ListColumnsProvider><MemoryRouter initialEntries={["/orders"]}><Harness /></MemoryRouter></ListColumnsProvider></ListDensityProvider>);
    const user = userEvent.setup();
    await user.type(screen.getByRole("searchbox"), "未提交");
    const more = screen.getByRole("button", { name: "更多列表操作" });
    await user.click(more);
    await user.click(await screen.findByRole("menuitem", { name: "列表显示" }));
    await user.click(within(screen.getByRole("group", { name: "列表密度" })).getByRole("button", { name: "舒适" }));
    expect(localStorage.getItem(LIST_DENSITY_KEY)).toBe("comfortable");
    await user.click(screen.getByRole("button", { name: "完成" }));
    await waitFor(() => expect(more).toHaveFocus());
    expect(screen.getByRole("searchbox")).toHaveValue("未提交");
  });

  const filterContent: React.ComponentProps<typeof ListQueryToolbar>["mobileFilterContent"] = draft => <>
    <CreatedDateFilter control={draft.withDates(LEDGER_DATE_FIELDS)} label="交易日期" fields={LEDGER_DATE_FIELDS} />
    <CreatedDateFilter control={draft.withDates(LEDGER_ASSOCIATED_DATE_FIELDS)} label="关联日期" fields={LEDGER_ASSOCIATED_DATE_FIELDS} />
    <LedgerAmountFilter control={draft} searchParams={draft.searchParams} />
  </>;

  it("cancels staged date and amount edits without writing the URL, then applies all changed conditions once", async () => {
    const updated = vi.fn();
    mount({ updated, toolbar: { mobileFilterContent: filterContent } }, "/orders?q=kept&source=overview&cursor=next&page=3&min_amount_cents=100");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "筛选与排序" }));
    await user.click(screen.getByRole("combobox", { name: "交易日期范围" }));
    await user.click(await screen.findByRole("option", { name: "近 7 天" }));
    await user.click(screen.getByRole("button", { name: "金额范围，已筛选" }));
    const amount = screen.getByRole("dialog", { name: "金额范围" });
    await user.clear(within(amount).getByRole("textbox", { name: "最低金额（元）" }));
    await user.type(within(amount).getByRole("textbox", { name: "最低金额（元）" }), "12.34");
    await user.type(within(amount).getByRole("textbox", { name: "最高金额（元）" }), "99");
    await user.click(within(amount).getByRole("button", { name: "应用金额" }));
    expect(updated).not.toHaveBeenCalled();
    expect(address().get("min_amount_cents")).toBe("100");
    expect(address().get("cursor")).toBe("next");
    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(updated).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "筛选与排序" }));
    expect(screen.getByRole("combobox", { name: "交易日期范围" })).toHaveTextContent("全部");
    await user.click(screen.getByRole("button", { name: "金额范围，已筛选" }));
    expect(screen.getByRole("textbox", { name: "最低金额（元）" })).toHaveValue("1.00");
    await user.clear(screen.getByRole("textbox", { name: "最低金额（元）" }));
    await user.type(screen.getByRole("textbox", { name: "最低金额（元）" }), "12.34");
    await user.click(screen.getByRole("button", { name: "应用金额" }));
    await user.click(screen.getByRole("button", { name: "金额范围，已筛选" }));
    expect(screen.getByRole("textbox", { name: "最低金额（元）" })).toHaveValue("12.34");
    await user.click(within(screen.getByRole("dialog", { name: "金额范围" })).getByRole("button", { name: "取消" }));
    await user.click(screen.getByRole("combobox", { name: "关联日期范围" }));
    await user.click(await screen.findByRole("option", { name: "自定义日期" }));
    const date = screen.getByRole("dialog", { name: "自定义关联日期" });
    await user.clear(within(date).getByLabelText("开始日期"));
    await user.type(within(date).getByLabelText("开始日期"), "2026-10-01");
    await user.clear(within(date).getByLabelText("结束日期"));
    await user.type(within(date).getByLabelText("结束日期"), "2026-10-05");
    await user.click(within(date).getByRole("button", { name: "应用日期" }));
    await choose(user, "付款状态", "未付款");
    expect(updated).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "应用" }));
    expect(updated).toHaveBeenCalledExactlyOnceWith({
      min_amount_cents: "1234",
      max_amount_cents: null,
      associated_from: "2026-10-01",
      associated_to: "2026-10-05",
      payment: "UNPAID",
      sort_by: "created_at",
      sort_order: "desc",
    });
    expect(Object.fromEntries(address())).toEqual({ q: "kept", source: "overview", min_amount_cents: "1234", associated_from: "2026-10-01", associated_to: "2026-10-05", payment: "UNPAID", sort_by: "created_at", sort_order: "desc" });
  });

  it("clears extra filter summaries with the standard conditions while retaining route context and sorting", async () => {
    mount({ toolbar: { mobileFilterSummary: ["交易日期：2026-10-01 至 2026-10-05", "金额：1.00 元起"], mobileFilterReset: { occurred_from: null, occurred_to: null, min_amount_cents: null } } }, "/orders?q=kept&payment=UNPAID&occurred_from=2026-10-01&occurred_to=2026-10-05&min_amount_cents=100&source=overview&sort_order=asc&page=3");
    expect(screen.getByLabelText("当前查询条件")).toHaveTextContent("交易日期：2026-10-01 至 2026-10-05");
    await userEvent.setup().click(screen.getByRole("button", { name: "清除搜索和筛选" }));
    expect(Object.fromEntries(address())).toEqual({ source: "overview", sort_order: "asc" });
  });
});
