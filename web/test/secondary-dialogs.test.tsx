import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { RecordTools } from "../src/components/detail/RecordTools";
import { TechnicalDetails } from "../src/components/detail/DetailPrimitives";
import { mountOnboarding } from "./onboarding-fixture";
import { recordAction } from "./menu-helper";

describe("context-preserving secondary dialogs", () => {
  it("opens a technical reader without inserting its data into the original record", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<MemoryRouter><TechnicalDetails data={{ record: "test-order", lines: ["first", "last"] }} identifiers={[["记录编号", "test-order"]]}><p>仅这条记录的补充信息</p></TechnicalDetails></MemoryRouter>);
    const owner = container.querySelector('[data-technical-information]')!;
    const trigger = within(owner as HTMLElement).getByRole("button", { name: "技术信息" });
    expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
    await user.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "技术信息" });
    expect(dialog).toHaveAttribute("data-technical-dialog");
    expect(within(dialog).getByLabelText("技术信息")).toHaveTextContent('"record": "test-order"');
    expect(within(dialog).getByText("仅这条记录的补充信息")).toBeVisible();
    expect(owner.querySelector("pre")).toBeNull();
    expect(dialog.querySelector('[data-admin-dialog-scroll]')).toBeNull();
    expect(dialog.querySelector(':scope > [data-admin-dialog-body]')).not.toBeNull();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    await user.click(within(dialog).getByRole("button", { name: "复制记录编号" }));
    expect(await navigator.clipboard.readText()).toBe("test-order");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("opens technical records in a read-only dialog and returns focus to the record menu", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const { container } = render(
      <MemoryRouter>
        <RecordTools
          data={{ evidence: "raw-evidence", nested: { count: 2 } }}
          identifiers={[["订单编号", "test-order"]]}
        />
      </MemoryRouter>,
    );
    const trigger = screen.getByRole("button", { name: "更多操作，记录操作" });
    await user.click(await recordAction("技术详情", "记录操作"));
    const dialog = await screen.findByRole("dialog", { name: "技术详情" });
    expect(within(dialog).getByLabelText("技术详情")).toHaveTextContent(
      '"evidence": "raw-evidence"',
    );
    expect(
      within(dialog).getByRole("button", { name: "复制订单编号" }),
    ).toBeVisible();
    expect(container.querySelector("pre")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(trigger).toHaveFocus();
    await user.click(await recordAction("技术详情", "记录操作"));
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "关闭",
      }),
    );
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("opens test payment from the overview without replacing the page", async () => {
    const view = mountOnboarding({ stage: 4, path: "/" });
    const trigger = await screen.findByRole("button", { name: "测试收款" });
    expect(trigger).not.toHaveClass("hidden");
    expect(trigger).toHaveAccessibleName("测试收款");
    expect(trigger).toHaveTextContent("测试收款");
    const user = userEvent.setup();
    await user.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "测试收款" });
    expect(within(dialog).getByLabelText("测试金额（元）")).toHaveValue(
      "0.01",
    );
    expect(dialog.querySelector("[data-overlay-footer]")).toHaveClass("shrink-0");
    expect(view.router.state.location.pathname).toBe("/");
    expect(view.writes()).toHaveLength(0);
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(trigger).toHaveFocus();
    expect(view.router.state.location.pathname).toBe("/");
  });
});
