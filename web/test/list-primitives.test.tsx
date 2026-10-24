import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ListDateTime, ListMoney, ListSummary, ListSummaryField } from "../src/components/list-primitives";
import { LinkedSummaryRow } from "../src/components/LinkedTableRow";

describe("business record formatting", () => {
  it("keeps cents, zero and unknown amounts distinct", () => {
    render(<><ListMoney value={0} /><ListMoney value={12901} /><ListMoney value={null} /></>);
    expect(screen.getByText("¥0.00")).toBeVisible();
    expect(screen.getByText("¥129.01")).toBeVisible();
    expect(screen.getByText("—")).toBeVisible();
  });

  it("uses Beijing calendar dates at midnight and preserves the machine-readable instant", () => {
    render(<ListDateTime value="2026-10-09T16:01:00Z" />);
    const time = screen.getByTitle("2026/10/10 00:01（北京时间）");
    expect(time).toHaveAttribute("datetime", "2026-10-09T16:01:00.000Z");
    expect(time).toHaveTextContent("2026/10/10 00:01");
    expect(screen.getByText("00:01")).toBeVisible();
  });

  it.each([null, undefined, "invalid"])("keeps an unavailable timestamp %s empty", (value) => {
    const view = render(<ListDateTime value={value} />);
    expect(screen.getByText("—")).toBeVisible();
    expect(view.container.querySelector("time")).toBeNull();
  });
});

describe("summary details", () => {
  it("opens only the selected record without following its row link and removes collapsed controls from the tab order", async () => {
    const navigate = vi.fn((event: React.MouseEvent<HTMLAnchorElement>) => event.preventDefault());
    const record = (id: string) => (
      <LinkedSummaryRow rowId={id}>
        <ListSummary
          identity={<a data-row-link href={"/record/" + id} onClick={navigate}>{id}</a>}
          details={<ListSummaryField label="详细信息"><a href={"/related/" + id}>关联 {id}</a></ListSummaryField>}
        >
          <ListSummaryField label="状态">待处理</ListSummaryField>
        </ListSummary>
      </LinkedSummaryRow>
    );
    render(<>{record("first")}{record("second")}<button type="button">下一项</button></>);
    const user = userEvent.setup();
    const [first, second] = screen.getAllByRole("listitem");
    const expand = within(first!).getByRole("button", { name: "展开信息" });
    expect(expand).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("link", { name: "关联 first" })).not.toBeInTheDocument();
    expand.focus();
    await user.keyboard("{Enter}");
    expect(navigate).not.toHaveBeenCalled();
    expect(within(first!).getByRole("button", { name: "收起信息" })).toHaveAttribute("aria-expanded", "true");
    expect(within(first!).getAllByText("详细信息")).toHaveLength(1);
    expect(within(second!).getByRole("button", { name: "展开信息" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("link", { name: "关联 second" })).not.toBeInTheDocument();
    await user.tab();
    expect(screen.getByRole("link", { name: "关联 first" })).toHaveFocus();
    await user.click(within(first!).getByRole("button", { name: "收起信息" }));
    await waitFor(() => expect(screen.queryByRole("link", { name: "关联 first" })).not.toBeInTheDocument());
    expect(navigate).not.toHaveBeenCalled();
    await user.tab();
    expect(screen.getByRole("link", { name: "second" })).toHaveFocus();
  });

  it("omits the expand control when no secondary fields are selected", () => {
    render(<ListSummary identity="订单" details={[]}>{[]}</ListSummary>);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(document.querySelector("dl")).toBeNull();
  });
});
