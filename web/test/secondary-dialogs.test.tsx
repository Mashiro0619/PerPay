import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { RecordTools } from "../src/components/detail/RecordTools";
import { mountOnboarding } from "./onboarding-fixture";
import { recordAction } from "./menu-helper";

describe("context-preserving secondary dialogs", () => {
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
    const trigger = screen.getByRole("button", { name: "记录操作" });
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

  it.each(["/", "/orders"])(
    "opens test payment from %s without replacing the page",
    async (path) => {
      const view = mountOnboarding({ stage: 4, path });
      const trigger = await screen.findByRole("button", { name: "测试收款" });
      if (path === "/") {
        expect(trigger).not.toHaveClass("hidden");
        expect(within(trigger).getByText("测试收款")).toHaveClass(
          "sr-only",
          "sm:not-sr-only",
        );
      }
      const user = userEvent.setup();
      await user.click(trigger);
      const dialog = await screen.findByRole("dialog", { name: "测试收款" });
      expect(within(dialog).getByLabelText("测试金额（元）")).toHaveValue(
        "0.01",
      );
      expect(dialog.querySelector("[data-slot=dialog-footer]")).toHaveClass(
        "shrink-0",
        "flex-row",
      );
      expect(view.router.state.location.pathname).toBe(path);
      expect(view.writes()).toHaveLength(0);
      await user.click(within(dialog).getByRole("button", { name: "取消" }));
      await waitFor(() =>
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
      );
      expect(trigger).toHaveFocus();
      expect(view.router.state.location.pathname).toBe(path);
    },
  );
});
