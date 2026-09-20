import { onlineManager, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useState, type ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, queryClient } from "../src/api/client";
import { ReasonDialog } from "../src/components/ReasonDialog";
import { FinancialDialog } from "../src/pages/FinancialDialog";
import { apiError, json, ledger, ledgerId, order, orderId } from "./fixtures";

function rejected(status = 0, code = "request_failed") {
  return new ApiError(status ? new Response(null, { status }) : undefined, {
    error: { code, message: "响应未确认", request_id: "recovery-test" },
  });
}
function wrap(children: ReactNode) {
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}
function unloadBlocked() {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}
afterEach(() => onlineManager.setOnline(true));

function reasonDialog(
  execute: (
    reason: string,
    id: string,
    signal?: AbortSignal,
  ) => Promise<unknown>,
  onSuccess: () => void = vi.fn(),
  onClose: () => void = vi.fn(),
  children: ReactNode = "原始核对证据",
) {
  return (
    <ReasonDialog
      title="撤销收款关联？"
      description="仅撤销账务关联，不会转出资金。"
      action="确认撤销关联"
      execute={execute}
      onSuccess={onSuccess}
      onClose={onClose}
    >
      {children}
    </ReasonDialog>
  );
}
async function submitReason(user: ReturnType<typeof userEvent.setup>) {
  const input = screen.getByLabelText("操作理由");
  await user.type(input, "原始核对理由");
  await user.click(screen.getByRole("button", { name: "确认撤销关联" }));
  return input;
}
function manual(
  handle?: (r: Request) => Response | Promise<Response> | undefined,
  onClose = vi.fn(),
) {
  const requests: Request[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (r: Request) => {
      requests.push(r);
      return (
        handle?.(r) ??
        json({ data: r.url.includes("ledger-entries") ? ledger : order })
      );
    }),
  );
  const onSuccess = vi.fn();
  const view = render(
    wrap(
      <FinancialDialog
        initialOrderId={orderId}
        initialLedgerId={ledgerId}
        onClose={onClose}
        onSuccess={onSuccess}
      />,
    ),
  );
  return {
    ...view,
    requests,
    writes: () => requests.filter((r) => r.method === "POST"),
    onSuccess,
  };
}
async function submitManual(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "查看关联信息" }));
  await user.type(await screen.findByLabelText("操作理由"), "原始人工关联理由");
  await user.click(screen.getByRole("button", { name: "确认关联收款" }));
}

describe("fixed command result recovery", () => {
  it("keeps the submitted reason, command and evidence when the response is lost, even if parent props change", async () => {
    const execute = vi
      .fn()
      .mockRejectedValueOnce(rejected())
      .mockResolvedValueOnce(undefined);
    const newer = vi.fn().mockResolvedValue(undefined);
    const success = vi.fn();
    const view = render(wrap(reasonDialog(execute, success)));
    const user = userEvent.setup();
    const input = await submitReason(user);
    await screen.findByText("操作结果待确认");
    expect(input).toHaveAttribute("readonly");
    expect(input).toHaveAccessibleDescription(
      expect.stringContaining("原操作"),
    );
    expect(unloadBlocked()).toBe(true);
    const id = execute.mock.calls[0]![1];
    expect(screen.getByText(id)).toBeVisible();
    expect(screen.getByRole("button", { name: "复制操作编号" })).toBeVisible();
    fireEvent.change(input, { target: { value: "换一个理由" } });
    expect(input).toHaveValue("原始核对理由");
    view.rerender(
      wrap(reasonDialog(newer, success, vi.fn(), "后台刷新后的新证据")),
    );
    expect(screen.getByText("原始核对证据")).toBeVisible();
    expect(screen.queryByText("后台刷新后的新证据")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试原操作" }));
    await waitFor(() => expect(success).toHaveBeenCalledOnce());
    expect(newer).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1]!.slice(0, 2)).toEqual(
      execute.mock.calls[0]!.slice(0, 2),
    );
    expect(unloadBlocked()).toBe(false);
  });

  it.each(["button", "escape", "overlay"])(
    "refreshes authoritative data when leaving an uncertain command via %s",
    async (close) => {
      const invalidate = vi
        .spyOn(queryClient, "invalidateQueries")
        .mockResolvedValue(undefined);
      const execute = vi.fn().mockRejectedValue(rejected());
      const success = vi.fn();
      function Harness() {
        const [open, setOpen] = useState(true);
        return open
          ? reasonDialog(execute, success, () => setOpen(false))
          : null;
      }
      render(wrap(<Harness />));
      const user = userEvent.setup();
      await submitReason(user);
      await screen.findByText("操作结果待确认");
      expect(
        screen.queryByRole("button", { name: "取消" }),
      ).not.toBeInTheDocument();
      if (close === "button")
        await user.click(screen.getByRole("button", { name: "关闭并刷新" }));
      else if (close === "escape") await user.keyboard("{Escape}");
      else
        fireEvent.click(
          document.querySelector('[data-slot="dialog-overlay"]')!,
        );
      await waitFor(() =>
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
      );
      expect(invalidate).toHaveBeenCalledOnce();
      expect(success).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledOnce();
      expect(unloadBlocked()).toBe(false);
    },
  );

  it("allows correcting a definite validation rejection but preserves uncertainty after a later rejection", async () => {
    const execute = vi
      .fn()
      .mockRejectedValueOnce(rejected(422, "validation_failed"))
      .mockRejectedValueOnce(rejected())
      .mockRejectedValueOnce(rejected(403, "csrf_invalid"))
      .mockResolvedValueOnce(undefined);
    const success = vi.fn();
    render(wrap(reasonDialog(execute, success)));
    const user = userEvent.setup();
    const input = await submitReason(user);
    await screen.findByText("响应未确认");
    expect(input).not.toHaveAttribute("readonly");
    expect(screen.queryByText("操作结果待确认")).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: "修正后的理由" } });
    await user.click(screen.getByRole("button", { name: "确认撤销关联" }));
    await screen.findByText("操作结果待确认");
    await user.click(screen.getByRole("button", { name: "重试原操作" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "重试原操作" })).toBeEnabled(),
    );
    expect(input).toHaveAttribute("readonly");
    await user.click(screen.getByRole("button", { name: "重试原操作" }));
    await waitFor(() => expect(success).toHaveBeenCalledOnce());
    expect(execute.mock.calls[1]!.slice(0, 2)).toEqual(
      execute.mock.calls[2]!.slice(0, 2),
    );
    expect(execute.mock.calls[2]!.slice(0, 2)).toEqual(
      execute.mock.calls[3]!.slice(0, 2),
    );
    expect(execute.mock.calls[0]![1]).not.toBe(execute.mock.calls[1]![1]);
  });

  it("does not repeat a stale command after a conflict following an uncertain response", async () => {
    const execute = vi
      .fn()
      .mockRejectedValueOnce(rejected())
      .mockRejectedValueOnce(rejected(409, "match_state_conflict"));
    render(wrap(reasonDialog(execute)));
    const user = userEvent.setup();
    const input = await submitReason(user);
    await screen.findByText("操作结果待确认");
    await user.click(screen.getByRole("button", { name: "重试原操作" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "重试原操作" }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByText("操作结果待确认")).toBeVisible();
    expect(input).toHaveAttribute("readonly");
    fireEvent.submit(input.closest("form")!);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(screen.getAllByRole("button", { name: "关闭并刷新" })).toHaveLength(
      1,
    );
  });

  it("does not silently queue a command while offline", async () => {
    const execute = vi.fn().mockRejectedValue(rejected());
    render(wrap(reasonDialog(execute)));
    const user = userEvent.setup();
    onlineManager.setOnline(false);
    await submitReason(user);
    await screen.findByText("操作结果待确认");
    expect(execute).toHaveBeenCalledOnce();
    await act(async () => {
      onlineManager.setOnline(true);
      await Promise.resolve();
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "关闭并刷新" })).toBeEnabled();
  });

  it("ends a timed-out wait in recovery, sends the original command again and ignores its late completion", async () => {
    let finish!: () => void;
    const execute = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    const success = vi.fn();
    render(wrap(reasonDialog(execute, success)));
    const input = screen.getByLabelText("操作理由");
    fireEvent.change(input, { target: { value: "超时恢复理由" } });
    vi.useFakeTimers();
    fireEvent.submit(input.closest("form")!);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_100);
    });
    expect(screen.getByText("操作结果待确认")).toBeVisible();
    expect(execute.mock.calls[0]![2]?.aborted).toBe(true);
    expect(success).not.toHaveBeenCalled();
    await act(async () => {
      finish();
      await Promise.resolve();
    });
    expect(success).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "重试原操作" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(success).toHaveBeenCalledOnce();
    expect(execute.mock.calls[1]!.slice(0, 2)).toEqual(
      execute.mock.calls[0]!.slice(0, 2),
    );
  });

  it("aborts on unmount without applying a late success callback", async () => {
    let finish!: () => void;
    const execute = vi.fn<
      (reason: string, id: string, signal?: AbortSignal) => Promise<void>
    >(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const success = vi.fn();
    const view = render(wrap(reasonDialog(execute, success)));
    await submitReason(userEvent.setup());
    view.unmount();
    expect(execute.mock.calls[0]![2]?.aborted).toBe(true);
    await act(async () => {
      finish();
    });
    expect(success).not.toHaveBeenCalled();
    expect(unloadBlocked()).toBe(false);
  });
});

describe("manual settlement recovery and evidence reading", () => {
  it("freezes original IDs and reason after a lost write, without fetching different evidence", async () => {
    let calls = 0;
    const view = manual((r) =>
      r.method === "POST"
        ? ++calls === 1
          ? Promise.reject(new TypeError("lost response"))
          : json({ data: {} })
        : undefined,
    );
    const user = userEvent.setup();
    await submitManual(user);
    await screen.findByText("操作结果待确认");
    const first = await view.writes()[0]!.clone().json();
    for (const [name, value] of [
      ["内部订单编号", orderId],
      ["收入流水编号", ledgerId],
      ["操作理由", "原始人工关联理由"],
    ]) {
      const field = screen.getByLabelText(name!);
      expect(field).toHaveAttribute("readonly");
      fireEvent.change(field, { target: { value: "modified" } });
      expect(field).toHaveValue(value);
    }
    expect(view.requests.filter((r) => r.method === "GET")).toHaveLength(2);
    expect(
      screen.queryByRole("button", { name: "重新核对证据" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试原操作" }));
    await waitFor(() => expect(view.onSuccess).toHaveBeenCalledOnce());
    expect(await view.writes()[1]!.clone().json()).toEqual(first);
    expect(view.requests.filter((r) => r.method === "GET")).toHaveLength(2);
  });

  it("does not replace selected evidence on a parent rerender while a write is unresolved", async () => {
    const requests: Request[] = [];
    let writes = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        requests.push(request);
        if (request.method === "POST") {
          if (++writes === 1) throw new TypeError("lost");
          return json({ data: {} });
        }
        return json({
          data: request.url.includes("ledger-entries") ? ledger : order,
        });
      }),
    );
    const success = vi.fn();
    const view = render(
      wrap(
        <FinancialDialog
          initialOrderId={orderId}
          initialLedgerId={ledgerId}
          lockContext
          onClose={vi.fn()}
          onSuccess={success}
        />,
      ),
    );
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("操作理由"), "固定关联上下文");
    await user.click(screen.getByRole("button", { name: "确认关联收款" }));
    await screen.findByText("操作结果待确认");
    view.rerender(
      wrap(
        <FinancialDialog
          initialOrderId={ledgerId}
          initialLedgerId={orderId}
          lockContext
          onClose={vi.fn()}
          onSuccess={success}
        />,
      ),
    );
    expect(requests.filter((request) => request.method === "GET")).toHaveLength(
      2,
    );
    await user.click(screen.getByRole("button", { name: "重试原操作" }));
    await waitFor(() => expect(success).toHaveBeenCalledOnce());
    const bodies = await Promise.all(
      requests
        .filter((request) => request.method === "POST")
        .map((request) => request.clone().json()),
    );
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[1]).toMatchObject({
      order_id: orderId,
      ledger_entry_id: ledgerId,
    });
  });

  it("does not discard an uncertain command by rechecking after a later conflict", async () => {
    let calls = 0;
    const close = vi.fn();
    const invalidate = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockResolvedValue(undefined);
    const view = manual(
      (r) =>
        r.method === "POST"
          ? ++calls === 1
            ? Promise.reject(new TypeError("lost"))
            : apiError("match_state_conflict", "资金事实已经变化", 409)
          : undefined,
      close,
    );
    const user = userEvent.setup();
    await submitManual(user);
    await screen.findByText("操作结果待确认");
    await user.click(screen.getByRole("button", { name: "重试原操作" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "重试原操作" }),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("button", { name: "重新核对证据" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "确认关联收款" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "关闭并刷新" }));
    expect(close).toHaveBeenCalledOnce();
    expect(invalidate).toHaveBeenCalledOnce();
    expect(view.writes()).toHaveLength(2);
  });

  it("lets a read-only evidence request be canceled and aborts both reads", async () => {
    const requests: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((r: Request) => {
        requests.push(r);
        return new Promise<Response>((_resolve, reject) =>
          r.signal.addEventListener("abort", () => reject(r.signal.reason), {
            once: true,
          }),
        );
      }),
    );
    function Harness() {
      const [open, setOpen] = useState(true);
      return open ? (
        <FinancialDialog
          initialOrderId={orderId}
          initialLedgerId={ledgerId}
          lockContext
          onClose={() => setOpen(false)}
          onSuccess={vi.fn()}
        />
      ) : null;
    }
    render(wrap(<Harness />));
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(screen.getByRole("button", { name: "取消" })).toBeEnabled();
    await userEvent.setup().click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(requests.every((r) => r.signal.aborted)).toBe(true);
    expect(requests.every((r) => r.method === "GET")).toBe(true);
  });
});

it("restarts the initial read cleanly under StrictMode without submitting a financial command", async () => {
  const requests: Request[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: Request) => {
      requests.push(request);
      return json({
        data: request.url.includes("ledger-entries") ? ledger : order,
      });
    }),
  );
  render(
    wrap(
      <StrictMode>
        <FinancialDialog
          initialOrderId={orderId}
          initialLedgerId={ledgerId}
          lockContext
          onClose={vi.fn()}
          onSuccess={vi.fn()}
        />
      </StrictMode>,
    ),
  );
  await screen.findByLabelText("操作理由");
  expect(screen.getByRole("button", { name: "确认关联收款" })).toBeDisabled();
  expect(requests.every((request) => request.method === "GET")).toBe(true);
});

describe("operation reason feedback", () => {
  it.each(["reason", "financial"])(
    "keeps invalid multiline reasons local in the %s workflow",
    async (kind) => {
      const execute = vi.fn();
      const view = kind === "financial" ? manual() : null;
      if (!view) render(wrap(reasonDialog(execute)));
      const user = userEvent.setup();
      if (view)
        await user.click(screen.getByRole("button", { name: "查看关联信息" }));
      const input = await screen.findByLabelText("操作理由");
      fireEvent.change(input, { target: { value: "第一行\n第二行" } });
      fireEvent.submit(input.closest("form")!);
      expect(input).toHaveAttribute("aria-invalid", "true");
      expect(input).toHaveFocus();
      expect(input).toHaveAccessibleDescription(
        expect.stringContaining("换行"),
      );
      expect(execute).not.toHaveBeenCalled();
      if (view) expect(view.writes()).toHaveLength(0);
      fireEvent.change(input, { target: { value: "一行完整理由" } });
      expect(input).not.toHaveAttribute("aria-invalid", "true");
    },
  );
});
