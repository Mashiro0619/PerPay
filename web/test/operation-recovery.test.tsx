import { QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { ApiError, queryClient } from "../src/api/client";
import { ReasonDialog } from "../src/components/ReasonDialog";
import { ReverseMatchAction } from "../src/components/detail/FinancialActions";
import { paymentMatch } from "./detail-fixtures";
import { json } from "./fixtures";
import { recordAction } from "./menu-helper";

function mount(children: ReactNode) {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>,
  );
}
function rejected(status: number, code: string) {
  return new ApiError(new Response(null, { status }), {
    error: {
      code,
      message: "请求未完成",
      request_id: "operation-recovery-test",
    },
  });
}

describe("fixed-evidence operation recovery", () => {
  it.each([
    { code: "match_state_conflict", close: "recovery" },
    { code: "ledger_conflict_state_conflict", close: "cancel" },
    { code: "webhook_delivery_state_conflict", close: "escape" },
  ])(
    "blocks a stale $code command and refreshes once on $close",
    async ({ code, close }) => {
      const invalidate = vi
        .spyOn(queryClient, "invalidateQueries")
        .mockResolvedValue(undefined);
      const execute = vi.fn().mockRejectedValue(rejected(409, code));
      const onClose = vi.fn();
      const onSuccess = vi.fn();
      mount(
        <ReasonDialog
          title="核对固定证据"
          description="确认后执行当前操作。"
          action="确认处理"
          execute={execute}
          onClose={onClose}
          onSuccess={onSuccess}
        />,
      );
      const user = userEvent.setup();
      const reason = screen.getByLabelText("操作理由");
      await user.type(reason, "已经核对的处理理由");
      await user.click(screen.getByRole("button", { name: "确认处理" }));
      await screen.findByText("请求未完成");
      const recovery = await screen.findByRole("button", {
        name: "关闭并刷新",
      });
      expect(recovery).toHaveAttribute("type", "button");
      expect(
        screen.queryByRole("button", { name: "确认处理" }),
      ).not.toBeInTheDocument();
      await act(async () => {
        fireEvent.submit(reason.closest("form")!);
      });
      expect(execute).toHaveBeenCalledOnce();
      await user.clear(reason);
      expect(recovery).toBeEnabled();
      if (close === "recovery") await user.click(recovery);
      else if (close === "cancel")
        await user.click(screen.getByRole("button", { name: "关闭对话框" }));
      else await user.keyboard("{Escape}");
      await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
      expect(invalidate).toHaveBeenCalledOnce();
      expect(execute).toHaveBeenCalledOnce();
      expect(onSuccess).not.toHaveBeenCalled();
    },
  );

  it.each([422, 503])(
    "preserves an intentional same-command retry after HTTP %s",
    async (status) => {
      const invalidate = vi
        .spyOn(queryClient, "invalidateQueries")
        .mockResolvedValue(undefined);
      const execute = vi
        .fn()
        .mockRejectedValueOnce(
          rejected(
            status,
            status === 422 ? "validation_failed" : "internal_error",
          ),
        )
        .mockResolvedValueOnce(undefined);
      const onSuccess = vi.fn();
      mount(
        <ReasonDialog
          title="核对固定证据"
          description="确认后执行当前操作。"
          action="确认处理"
          execute={execute}
          onClose={vi.fn()}
          onSuccess={onSuccess}
        />,
      );
      const user = userEvent.setup();
      await user.type(screen.getByLabelText("操作理由"), "保持原请求重试");
      await user.click(screen.getByRole("button", { name: "确认处理" }));
      await screen.findByText(status === 503 ? "操作结果待确认" : "请求未完成");
      expect(
        screen.queryByRole("button", { name: "重新核对证据" }),
      ).not.toBeInTheDocument();
      await user.click(
        screen.getByRole("button", {
          name: status === 503 ? "重试原操作" : "确认处理",
        }),
      );
      await waitFor(() => expect(onSuccess).toHaveBeenCalledOnce());
      expect(execute).toHaveBeenCalledTimes(2);
      expect(execute.mock.calls[1]!.slice(0, 2)).toEqual(
        execute.mock.calls[0]!.slice(0, 2),
      );
      expect(invalidate).not.toHaveBeenCalled();
    },
  );
});

describe("reversal focus after success", () => {
  it.each([true, false])(
    "uses stable content only for an embedded action (%s)",
    async (embedded) => {
      vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue(undefined);
      const fetchMock = vi.fn(async () => json({ data: {} }));
      vi.stubGlobal("fetch", fetchMock);
      mount(
        <main id="main-content" tabIndex={-1}>
          <a href="#order-overview">返回订单</a>
          <ReverseMatchAction match={paymentMatch} embedded={embedded} />
        </main>,
      );
      const user = userEvent.setup();
      const trigger = screen.getByRole("button", { name: "收款记录操作" });
      await user.click(await recordAction("撤销错误关联", "收款记录操作"));
      const dialog = screen.getByRole("dialog");
      await user.type(
        within(dialog).getByLabelText("操作理由"),
        "核对后撤销错误关联",
      );
      await user.click(
        within(dialog).getByRole("button", { name: "确认撤销关联" }),
      );
      await screen.findByText("关联已撤销");
      await waitFor(() =>
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
      );
      await waitFor(() =>
        expect(
          embedded ? screen.getByRole("link", { name: "返回订单" }) : trigger,
        ).toHaveFocus(),
      );
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );
});
