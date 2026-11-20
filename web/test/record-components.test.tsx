import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionBar } from "../src/components/record/ActionBar";
import { Disclosure } from "../src/components/record/Disclosure";
import { FieldList } from "../src/components/record/FieldList";
import { RecordNotice, RecordSummary } from "../src/components/record/RecordSummary";
import { Section, Sections } from "../src/components/record/Sections";
import { SubRecord } from "../src/components/record/SubRecord";
import { Timeline } from "../src/components/record/Timeline";
import { mobileMedia } from "./mobile-media";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function at(path: string, children: ReactNode) {
  return render(<MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>);
}

describe("record field list", () => {
  it("lays every field out as one label and one value, in order, and skips absent entries", () => {
    render(<FieldList items={[
      { label: "商户订单号", value: "M2026", kind: "id", copy: "M2026" },
      false,
      { label: "下单金额", value: "¥129.00", kind: "money" },
      null,
      { label: "订单备注", value: "", hint: "由业务网站提交" },
    ]} />);
    const rows = Array.from(document.querySelectorAll("[data-detail-fields] > dl > div"));
    expect(rows.map(row => [row.querySelector("dt")!.textContent, row.querySelector("dd span")!.textContent])).toEqual([
      ["商户订单号", "M2026"], ["下单金额", "¥129.00"], ["订单备注", "—"],
    ]);
    expect(rows.map(row => row.getAttribute("data-field-kind"))).toEqual(["id", "money", "text"]);
    expect(rows.every(row => row.children.length === 2 && row.children[0]!.tagName === "DT" && row.children[1]!.tagName === "DD")).toBe(true);
    expect(screen.getByText("由业务网站提交")).toBeVisible();
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("copies the raw value rather than the displayed one", async () => {
    // userEvent installs its own clipboard, so replace it afterwards.
    const user = userEvent.setup();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<FieldList items={[{ label: "支付宝订单号", value: <b>2026 1116 2200</b>, copy: "202611162200" }]} />);
    const copy = screen.getByRole("button", { name: "复制支付宝订单号" });
    await user.click(copy);
    expect(writeText).toHaveBeenCalledWith("202611162200");
    await waitFor(() => expect(copy).toHaveAttribute("data-copy-state", "success"));
  });

  it("names the copy button after the label unless a name is given", () => {
    render(<FieldList items={[
      { label: "商户订单号", value: "M2026", copy: "M2026" },
      { label: "操作编号", value: "op-1", copy: "op-1", copyLabel: "复制标记操作编号" },
    ]} />);
    expect(screen.getAllByRole("button").map(button => button.getAttribute("aria-label"))).toEqual(["复制商户订单号", "复制标记操作编号"]);
  });

  it("renders nothing when no field is present", () => {
    const { container } = render(<FieldList items={[false, undefined]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("record sections", () => {
  it("gives each section a visible title and count, and reduces an empty section to one line", () => {
    at("/record", <Sections label="订单详情内容">
      <Section id="overview" title="订单信息"><p>订单字段</p></Section>
      <Section id="payments" title="收款关联" count={2}><p>关联内容</p></Section>
      <Section id="notifications" title="通知" empty="尚未发送通知"><p>不应显示</p></Section>
    </Sections>);
    const group = screen.getByRole("group", { name: "订单详情内容" });
    expect(within(group).getAllByRole("heading", { level: 2 }).map(heading => heading.textContent)).toEqual(["订单信息", "收款关联，共 2 项", "通知"]);
    expect(screen.getByRole("region", { name: /^收款关联/ })).toHaveAttribute("data-detail-section", "payments");
    const empty = document.querySelector('[data-detail-section="notifications"]')!;
    expect(empty).toHaveAttribute("data-section-empty", "true");
    expect(empty).toHaveTextContent("通知尚未发送通知");
    expect(screen.queryByText("不应显示")).not.toBeInTheDocument();
    expect(Array.from(group.children).map(section => section.getAttribute("data-detail-section"))).toEqual(["overview", "payments", "notifications"]);
  });

  it("locates an exact anchor once, focuses it and marks it briefly", async () => {
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    at("/record?section=overview#match-2", <Sections>
      <Section id="overview" title="订单信息"><p>订单字段</p></Section>
      <Section id="payments" title="收款关联" anchorPrefixes={["match-", "candidate-"]}>
        <SubRecord id="match-1" title="第一条关联" />
        <SubRecord id="match-2" title="第二条关联" />
      </Section>
    </Sections>);
    const target = document.getElementById("match-2")!;
    await waitFor(() => expect(target).toHaveFocus());
    expect(scroll.mock.contexts).toEqual([target]);
    expect(target).toHaveAttribute("data-anchor-hit");
    expect(document.getElementById("match-1")).not.toHaveAttribute("data-anchor-hit");
    await waitFor(() => expect(target).not.toHaveAttribute("data-anchor-hit"), { timeout: 2500 });
  });

  it("falls back to the section that owns an anchor prefix, or to the requested section", async () => {
    const first = at("/record#candidate-missing", <Sections>
      <Section id="overview" title="订单信息"><p>订单字段</p></Section>
      <Section id="payments" title="收款关联" anchorPrefixes={["match-", "candidate-"]}><p>关联内容</p></Section>
    </Sections>);
    await waitFor(() => expect(document.querySelector('[data-detail-section="payments"]')).toHaveFocus());
    expect(document.querySelector("[data-anchor-hit]")).toBeNull();
    first.unmount();
    at("/record?section=history", <Sections>
      <Section id="overview" title="订单信息"><p>订单字段</p></Section>
      <Section id="history" title="动态"><p>动态内容</p></Section>
    </Sections>);
    await waitFor(() => expect(document.querySelector('[data-detail-section="history"]')).toHaveFocus());
  });

  it.each(["#obsolete", "#%E0%A4%A"])("falls back to the requested section when the anchor %s cannot be resolved", async hash => {
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    at("/record?section=history" + hash, <Sections>
      <Section id="overview" title="订单信息"><p>订单字段</p></Section>
      <Section id="history" title="动态"><p>动态内容</p></Section>
    </Sections>);
    const history = document.querySelector<HTMLElement>('[data-detail-section="history"]')!;
    await waitFor(() => expect(history).toHaveFocus());
    expect(scroll.mock.contexts).toEqual([history]);
    expect(document.querySelector("[data-anchor-hit]")).toBeNull();
  });

  it.each(["?section=unknown", "#obsolete", "#%E0%A4%A", ""])("leaves the record where it opened for the absent or invalid destination \"%s\"", async suffix => {
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    at("/record" + suffix, <Sections>
      <Section id="overview" title="订单信息"><p>订单字段</p></Section>
      <Section id="history" title="动态"><p>动态内容</p></Section>
    </Sections>);
    // Locating happens in an animation frame, so give one time to pass.
    await act(() => new Promise(resolve => setTimeout(resolve, 60)));
    expect(scroll).not.toHaveBeenCalled();
    expect(document.querySelector("[data-detail-section]:focus")).toBeNull();
    expect(screen.getByText("订单字段")).toBeVisible();
    expect(screen.getByText("动态内容")).toBeVisible();
  });

  it("opens the collapsed history around an anchor before moving to it", async () => {
    at("/record#match-old", <Sections>
      <Section id="payments" title="收款关联" anchorPrefixes={["match-"]}>
        <SubRecord id="match-new" title="当前关联" />
        <Disclosure label="已撤销的关联" count={1}><SubRecord id="match-old" title="已撤销关联" /></Disclosure>
      </Section>
    </Sections>);
    const target = document.getElementById("match-old")!;
    await waitFor(() => expect(target).toHaveFocus());
    expect(target).toBeVisible();
    expect(screen.getByRole("button", { name: /^已撤销的关联，共 ?1 ?项$/ })).toHaveAttribute("aria-expanded", "true");
  });

  it("waits for content above the destination to finish loading", async () => {
    function Loading() {
      const [ready, setReady] = useState(false);
      return <>
        <Sections>
          <Section id="overview" title="订单信息">{ready ? <p>订单字段</p> : <div data-slot="skeleton">读取中</div>}</Section>
          <Section id="history" title="动态"><p>动态内容</p></Section>
        </Sections>
        <button onClick={() => setReady(true)}>完成读取</button>
      </>;
    }
    at("/record?section=history", <Loading />);
    const history = document.querySelector<HTMLElement>('[data-detail-section="history"]')!;
    await act(() => new Promise(resolve => setTimeout(resolve, 60)));
    expect(history).not.toHaveFocus();
    await userEvent.setup().click(screen.getByRole("button", { name: "完成读取" }));
    await waitFor(() => expect(history).toHaveFocus());
  });
});

describe("record disclosure", () => {
  it("keeps collapsed content mounted but hidden until its trigger is used", async () => {
    render(<Disclosure label="匹配依据与其他凭据" count={3}><p>凭据内容</p></Disclosure>);
    // The number is read apart from the name.
    const trigger = screen.getByRole("button", { name: /^匹配依据与其他凭据，共 ?3 ?项$/ });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("凭据内容")).not.toBeVisible();
    const user = userEvent.setup();
    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("凭据内容")).toBeVisible();
    await user.click(trigger);
    await waitFor(() => expect(screen.getByText("凭据内容")).not.toBeVisible());
  });
});

describe("record sub-record", () => {
  it("shows a single action as a button that hands over its trigger", async () => {
    const onSelect = vi.fn();
    at("/record", <SubRecord id="match-1" title="支付宝收款 ¥129.01" status={<span>已关联</span>} description="金额推断"
      href="/ledger/entry-1" hrefLabel="查看流水" actions={[{ label: "撤销关联", danger: true, onSelect }]}><p>字段</p></SubRecord>);
    const record = document.getElementById("match-1")!;
    expect(within(record).getByRole("heading", { level: 3, name: "支付宝收款 ¥129.01" })).toBeVisible();
    expect(within(record).getByRole("link", { name: "查看流水" })).toHaveAttribute("href", "/ledger/entry-1");
    const action = within(record).getByRole("button", { name: "撤销关联" });
    // Marked for styling: it turns red only when pointed at or focused.
    expect(action).toHaveAttribute("data-danger", "true");
    await userEvent.setup().click(action);
    expect(onSelect).toHaveBeenCalledWith(action);
    expect(within(record).queryByRole("button", { name: "更多操作" })).not.toBeInTheDocument();
  });

  it("collects two or more actions behind one menu", async () => {
    const resend = vi.fn();
    at("/record", <SubRecord title="收款成功通知" actionsLabel="更多操作，通知操作" actions={[{ label: "重新发送", onSelect: resend }, { label: "停止重试", danger: true }]} />);
    expect(screen.queryByRole("button", { name: "重新发送" })).not.toBeInTheDocument();
    const trigger = screen.getByRole("button", { name: "更多操作，通知操作" });
    const user = userEvent.setup();
    await user.click(trigger);
    expect((await screen.findAllByRole("menuitem")).map(item => item.textContent)).toEqual(["重新发送", "停止重试"]);
    await user.click(screen.getByRole("menuitem", { name: "重新发送" }));
    expect(resend).toHaveBeenCalledWith(trigger);
  });
});

describe("record timeline", () => {
  const entries = Array.from({ length: 5 }, (_, index) => ({
    id: "event-" + index, title: "事件 " + index, time: `2026-11-16T04:03:0${index}.000Z`,
    ...(index === 0 ? { body: "PerPay 按金额和付款时间推断", tone: "success" as const } : {}),
  }));

  it("shows the newest entries with times to the second and collapses the rest", async () => {
    render(<Timeline entries={entries} label="订单动态" initial={3} moreLabel="更早动态" />);
    const list = screen.getByRole("list", { name: "订单动态" });
    const items = within(list).getAllByRole("listitem");
    expect(items.map(item => item.querySelector("time")!.textContent)).toEqual(["2026/11/16 12:03:00", "2026/11/16 12:03:01", "2026/11/16 12:03:02"]);
    expect(items[0]!.querySelector("time")).toHaveAttribute("datetime", "2026-11-16T04:03:00.000Z");
    expect(items[0]).toHaveAttribute("data-timeline-tone", "success");
    expect(items[0]).toHaveTextContent("PerPay 按金额和付款时间推断");
    const more = screen.getByRole("button", { name: /^更早动态，共 ?2 ?项$/ });
    expect(screen.getByText("事件 4")).not.toBeVisible();
    await userEvent.setup().click(more);
    expect(within(screen.getByRole("list", { name: "更早动态" })).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("事件 4")).toBeVisible();
  });

  it("says so when there is nothing to show", () => {
    render(<Timeline entries={[]} label="订单动态" empty="暂无订单事件" />);
    expect(screen.getByText("暂无订单事件")).toBeVisible();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });
});

describe("record summary", () => {
  const nav = [{ id: "overview", label: "订单信息" }, { id: "payments", label: "收款关联", count: 1 }, { id: "history", label: "动态" }];

  it("leads with the value and badges, keeps at most two conclusion lines and marks differing comparisons", () => {
    at("/record", <RecordSummary label="PerPay 收款状态" value="¥129.01" status={<span>收款已确认</span>}
      meta={["实收 · 应付 ¥129.01", false, "创建于 2026/11/16 12:03:02", "第三行不显示"]}
      compare={[{ label: "金额", left: "应付 ¥129.00", right: "流水 ¥129.01", differs: true }, { label: "时间", left: "12:08:11", right: "12:03:11", differs: false }]} />);
    const summary = screen.getByRole("group", { name: "PerPay 收款状态" });
    expect(summary.querySelector("[data-record-summary-value]")).toHaveTextContent("¥129.01");
    expect(Array.from(summary.querySelectorAll("[data-record-summary-meta] p")).map(line => line.textContent)).toEqual(["实收 · 应付 ¥129.01", "创建于 2026/11/16 12:03:02"]);
    expect(Array.from(summary.querySelectorAll("[data-record-compare] > div")).map(row => row.hasAttribute("data-differs"))).toEqual([true, false]);
    expect(within(summary).queryByRole("navigation")).not.toBeInTheDocument();
  });

  it("leads with the badges when a record has no value, and with the conclusion when it has neither", () => {
    const badges = at("/record", <RecordSummary label="日志概况" status={<span>成功</span>} meta={["12:03:02 · 管理员"]} />);
    const summary = screen.getByRole("group", { name: "日志概况" });
    expect(summary.querySelector("[data-record-summary-value]")).not.toBeInTheDocument();
    expect(summary.firstElementChild).toHaveTextContent("成功");
    badges.unmount();
    at("/record", <RecordSummary label="会话概况" status={false} meta={["这台设备上的登录仍然有效"]} />);
    expect(screen.getByRole("group", { name: "会话概况" }).firstElementChild).toHaveAttribute("data-record-summary-meta");
  });

  it("offers section navigation only from three sections and moves to the chosen one", async () => {
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    const page = (items: typeof nav) => <div data-overlay-primary>
      <RecordSummary label="PerPay 收款状态" value="¥129.01" nav={items} />
      <div data-overlay-detail><Sections>
        <Section id="overview" title="订单信息"><p>订单字段</p></Section>
        <Section id="payments" title="收款关联" count={1}><p>关联内容</p></Section>
        <Section id="history" title="动态"><p>动态内容</p></Section>
      </Sections></div>
    </div>;
    const two = at("/record", page(nav.slice(0, 2)));
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    two.unmount();
    at("/record", page(nav));
    const links = within(screen.getByRole("navigation", { name: "分区导航" })).getAllByRole("button");
    expect(links.map(link => link.textContent)).toEqual(["订单信息", "收款关联，共 1 项", "动态"]);
    expect(links.map(link => link.getAttribute("aria-current"))).toEqual(["true", null, null]);
    await userEvent.setup().click(links[2]!);
    const history = document.querySelector('[data-detail-section="history"]')!;
    expect(scroll.mock.contexts).toEqual([history]);
    // The test environment reports no reduced-motion preference, so the jump is animated.
    expect(scroll).toHaveBeenCalledWith({ block: "start", behavior: "smooth" });
    expect(history).toHaveFocus();
    expect(links.map(link => link.getAttribute("aria-current"))).toEqual([null, null, "true"]);
  });

  it("keeps a requested section marked until the reader scrolls on their own", async () => {
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    const page = <div data-overlay-primary>
      <RecordSummary label="PerPay 收款状态" value="¥129.01" nav={nav} />
      <RecordNotice tone="warning" jump={{ section: "overview", label: "查看订单信息" }}>订单金额与流水不一致。</RecordNotice>
      <div data-overlay-detail><Sections>
        <Section id="overview" title="订单信息"><p>订单字段</p></Section>
        <Section id="payments" title="收款关联" count={1}><p>关联内容</p></Section>
        <Section id="history" title="动态"><p>动态内容</p></Section>
      </Sections></div>
    </div>;
    const linked = at("/record?section=payments", page);
    const frame = () => act(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    const marked = () => within(screen.getByRole("navigation", { name: "分区导航" })).getAllByRole("button").map(link => link.getAttribute("aria-current"));
    // A section opened by its link is marked, although every position is zero here and reads as the last section.
    await frame();
    expect(document.querySelector('[data-detail-section="payments"]')).toHaveFocus();
    expect(marked()).toEqual([null, "true", null]);
    linked.unmount();

    at("/record", page);
    const user = userEvent.setup();
    const scroller = document.querySelector<HTMLElement>("[data-overlay-detail]")!;
    const scrolled = async () => { fireEvent.scroll(scroller); await frame(); };
    await scrolled();
    expect(marked()).toEqual([null, null, "true"]);
    await user.click(within(screen.getByRole("navigation", { name: "分区导航" })).getAllByRole("button")[1]!);
    expect(marked()).toEqual([null, "true", null]);
    // The content moving towards the section does not take the mark away.
    await scrolled();
    expect(marked()).toEqual([null, "true", null]);
    // A jump from the notice moves it as well.
    await user.click(screen.getByRole("button", { name: "查看订单信息" }));
    await scrolled();
    expect(marked()).toEqual(["true", null, null]);
    // The reader's own scrolling hands the mark back to the position.
    fireEvent.wheel(scroller);
    await scrolled();
    expect(marked()).toEqual([null, null, "true"]);
  });

  it("states a reason without buttons other than a jump to the section concerned", async () => {
    at("/record", <div data-overlay-primary>
      <RecordNotice tone="danger" jump={{ section: "payments", label: "查看 1 项待核对" }}>收款有争议：原收款关联已撤销，请核对付款凭证。</RecordNotice>
      <Sections><Section id="payments" title="收款关联"><p>关联内容</p></Section></Sections>
    </div>);
    expect(document.querySelector('[data-record-notice="danger"]')).toHaveTextContent("收款有争议：原收款关联已撤销，请核对付款凭证。");
    await userEvent.setup().click(screen.getByRole("button", { name: "查看 1 项待核对" }));
    expect(document.querySelector('[data-detail-section="payments"]')).toHaveFocus();
  });
});

describe("record action bar", () => {
  it("renders nothing without actions", () => {
    const { container } = at("/record", <ActionBar menuLabel="更多操作，订单操作" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("puts the secondary action before the primary one and keeps technical data behind the menu", async () => {
    const mark = vi.fn();
    at("/record", <ActionBar menuLabel="更多操作，订单操作" primary={<button>人工关联收款</button>} secondary={<button>查看收银台结果</button>}
      menu={[{ label: "标记已退款", danger: true, onSelect: mark }]}
      technical={[{ title: "订单技术信息", data: { order_id: "order-1" }, identifiers: [["内部订单编号", "order-1"]] }, { title: "关联技术信息", data: { match: 1 } }]} />);
    expect(Array.from(document.querySelectorAll("[data-record-primary-actions] button")).map(button => button.textContent)).toEqual(["查看收银台结果", "人工关联收款"]);
    const trigger = screen.getByRole("button", { name: "更多操作，订单操作" });
    expect(trigger).toHaveTextContent("更多");
    const user = userEvent.setup();
    await user.click(trigger);
    expect((await screen.findAllByRole("menuitem")).map(item => item.textContent)).toEqual(["标记已退款", "订单技术信息", "关联技术信息"]);
    await user.click(screen.getByRole("menuitem", { name: "标记已退款" }));
    expect(mark).toHaveBeenCalledWith(trigger);
    await user.click(trigger);
    await user.click(await screen.findByRole("menuitem", { name: "订单技术信息" }));
    const dialog = await screen.findByRole("dialog", { name: "订单技术信息" });
    expect(dialog).toHaveTextContent('"order_id": "order-1"');
    expect(within(dialog).getByText("内部订单编号")).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("opens an outside address in a new tab from the menu, and from a sub-record's single action", async () => {
    const checkout = { label: "查看收银台结果", href: "/api/admin/v1/orders/order-1/checkout", title: "在新标签页查看收银台" };
    at("/record", <>
      <ActionBar menuLabel="更多操作，订单操作" menu={[checkout]} />
      <SubRecord id="match-1" title="收款关联记录" actions={[checkout]} />
    </>);
    const direct = within(document.getElementById("match-1")!).getByRole("link", { name: "查看收银台结果" });
    await userEvent.setup().click(screen.getByRole("button", { name: "更多操作，订单操作" }));
    for (const link of [direct, await screen.findByRole("menuitem", { name: "查看收银台结果" })]) {
      expect(link.tagName).toBe("A");
      expect(link).toHaveAttribute("href", checkout.href);
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
      expect(link).toHaveAttribute("title", checkout.title);
    }
  });

  it("leaves the site workspace for an action marked global, as a single action and in the menu", async () => {
    const elsewhere = { label: "到全部网站处理这笔流水", to: "/reconciliation/transactions/ledger-1", global: true };
    const here = { label: "查看本站订单", to: "/orders/order-2" };
    at("/sites/site-a/orders/order-1", <>
      <SubRecord id="exception-1" title="待核对收款" actions={[elsewhere]} />
      <ActionBar menuLabel="更多操作，订单操作" menu={[elsewhere, here]} />
    </>);
    const pathname = (link: HTMLElement) => new URL(link.getAttribute("href")!, "http://perpay.test").pathname;
    expect(pathname(within(document.getElementById("exception-1")!).getByRole("link", { name: elsewhere.label }))).toBe(elsewhere.to);
    await userEvent.setup().click(screen.getByRole("button", { name: "更多操作，订单操作" }));
    expect(pathname(await screen.findByRole("menuitem", { name: elsewhere.label }))).toBe(elsewhere.to);
    expect(pathname(screen.getByRole("menuitem", { name: here.label }))).toBe("/sites/site-a" + here.to);
  });

  it("keeps technical entries with the same title apart by a note", async () => {
    at("/record", <ActionBar menuLabel="更多操作，订单操作" technical={[
      { id: "match-1", title: "收款关联技术信息", note: "12:03:40", data: { match: 1 } },
      { id: "match-2", title: "收款关联技术信息", note: "12:08:11", data: { match: 2 } },
    ]} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "更多操作，订单操作" }));
    expect((await screen.findAllByRole("menuitem")).map(item => item.textContent)).toEqual(["收款关联技术信息 · 12:03:40", "收款关联技术信息 · 12:08:11"]);
    await user.click(screen.getByRole("menuitem", { name: /12:08:11$/ }));
    const dialog = await screen.findByRole("dialog", { name: "收款关联技术信息" });
    expect(dialog).toHaveTextContent('"match": 2');
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });

  it("folds a secondary action into the menu beside a primary one on phones, but leaves a sole secondary action out", async () => {
    const media = mobileMedia(390);
    const refund = vi.fn();
    const view = at("/record", <ActionBar menuLabel="更多操作，订单操作"
      primary={<button>重新核对并确认收款</button>}
      secondary={{ label: "标记已退款", onSelect: refund }}
      menu={[{ label: "查看收银台结果", href: "/checkout" }]} />);
    expect(Array.from(document.querySelectorAll("[data-record-primary-actions] > *")).map(node => node.textContent)).toEqual(["重新核对并确认收款"]);
    const trigger = screen.getByRole("button", { name: "更多操作，订单操作" });
    const user = userEvent.setup();
    await user.click(trigger);
    expect((await screen.findAllByRole("menuitem")).map(item => item.textContent)).toEqual(["标记已退款", "查看收银台结果"]);
    await user.click(screen.getByRole("menuitem", { name: "标记已退款" }));
    expect(refund).toHaveBeenCalledWith(trigger);

    media.resize(1280);
    expect(Array.from(document.querySelectorAll("[data-record-primary-actions] > *")).map(node => node.textContent)).toEqual(["标记已退款", "重新核对并确认收款"]);

    media.resize(390);
    view.rerender(<MemoryRouter initialEntries={["/record"]}><ActionBar menuLabel="更多操作，订单操作"
      secondary={{ label: "查看收银台结果", href: "/checkout" }} /></MemoryRouter>);
    expect(screen.queryByRole("button", { name: "更多操作，订单操作" })).not.toBeInTheDocument();
    expect(Array.from(document.querySelectorAll("[data-record-primary-actions] > *")).map(node => node.textContent)).toEqual(["查看收银台结果"]);
  });
});
