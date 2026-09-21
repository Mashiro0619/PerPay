import { useState, type ReactNode } from "react";
import { QueryClientProvider, onlineManager } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  MemoryRouter,
  Outlet,
  RouterProvider,
  createMemoryRouter,
} from "react-router";
import { describe, expect, it, vi } from "vitest";
import { queryClient, type AdminRefundMarkRequest } from "@/api/client";
import { RefundMarkDialog } from "@/pages/RefundMark";
import { DraftProvider } from "@/drafts";
import { apiError, json, order, orderId } from "./fixtures";

const paid = {
  ...order,
  product_name: "原订单的商品",
  received_amount_cents: 101,
  payment: {
    ...order.payment,
    status: "CONFIRMED" as const,
    received_amount_cents: 101,
  },
};
const receipt = (body: AdminRefundMarkRequest) => ({
  data: {
    operation_id: body.operation_id,
    refund_mark: {
      version: body.version + 1,
      marked: body.marked,
      note: body.note ?? null,
      updated_at: "2026-09-21T00:00:00Z",
      updated_by: "admin",
    },
  },
});
const wrap = (children: ReactNode) => (
  <QueryClientProvider client={queryClient}>
    <MemoryRouter>{children}</MemoryRouter>
  </QueryClientProvider>
);
const unloadBlocked = () => {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
};
const dialog = (
  onSuccess: () => void = vi.fn(),
  onClose: () => void = vi.fn(),
) => (
  <RefundMarkDialog
    order={paid}
    orderId={orderId}
    version={0}
    marked
    onClose={onClose}
    onSuccess={onSuccess}
  />
);

describe("refund mark result recovery", () => {
  it("locks the original note and request after a lost response and preserves the opened order snapshot", async () => {
    const requests: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        requests.push(request.clone());
        return requests.length === 1
          ? apiError("internal_error", "lost", 500)
          : json(receipt(await request.json()));
      }),
    );
    const success = vi.fn();
    const view = render(wrap(dialog(success)));
    const user = userEvent.setup();
    const note = screen.getByLabelText("备注（可选）");
    await user.type(note, "原始备注\n保留换行 🙂");
    await user.click(screen.getByRole("button", { name: "确认标记已退款" }));
    await screen.findByText("标记结果待确认", { exact: true });
    expect(note).toHaveAttribute("readonly");
    expect(unloadBlocked()).toBe(true);
    fireEvent.change(note, { target: { value: "换一条备注" } });
    expect(note).toHaveValue("原始备注\n保留换行 🙂");
    view.rerender(
      wrap(
        <RefundMarkDialog
          order={{ ...paid, product_name: "后台刷新后的商品" }}
          orderId="22222222-2222-4222-8222-222222222222"
          version={8}
          marked={false}
          onClose={vi.fn()}
          onSuccess={success}
        />,
      ),
    );
    expect(screen.getByText("原订单的商品")).toBeVisible();
    expect(screen.queryByText("后台刷新后的商品")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "标记已退款" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "重试原标记" }));
    await waitFor(() => expect(success).toHaveBeenCalledOnce());
    expect(requests).toHaveLength(2);
    expect(requests[1]!.url).toBe(requests[0]!.url);
    expect(await requests[1]!.json()).toEqual(await requests[0]!.json());
    expect(unloadBlocked()).toBe(false);
  });

  it.each(["missing", "operation", "version", "marked", "note", "metadata"])(
    "does not report a %s success receipt as saved",
    async (broken) => {
      const success = vi.fn();
      vi.stubGlobal(
        "fetch",
        vi.fn(async (request: Request) => {
          const data = receipt(await request.json());
          if (broken === "missing") return json({ data: {} });
          if (broken === "operation")
            data.data.operation_id = "another-request";
          if (broken === "version") data.data.refund_mark.version += 1;
          if (broken === "marked") data.data.refund_mark.marked = false;
          if (broken === "note") data.data.refund_mark.note = "another-note";
          if (broken === "metadata")
            data.data.refund_mark.updated_at = "not-a-date";
          return json(data);
        }),
      );
      render(wrap(dialog(success)));
      await userEvent.click(
        screen.getByRole("button", { name: "确认标记已退款" }),
      );
      await screen.findByText("标记结果待确认", { exact: true });
      expect(success).not.toHaveBeenCalled();
      expect(screen.getByLabelText("备注（可选）")).toHaveAttribute("readonly");
      expect(screen.getByRole("button", { name: "重试原标记" })).toBeEnabled();
    },
  );

  it.each(["button", "escape", "overlay"])(
    "refreshes the order when an uncertain mark is closed through %s",
    async (method) => {
      const invalidate = vi
        .spyOn(queryClient, "invalidateQueries")
        .mockResolvedValue(undefined);
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new TypeError("lost");
        }),
      );
      function Harness() {
        const [open, setOpen] = useState(true);
        return open ? dialog(vi.fn(), () => setOpen(false)) : null;
      }
      render(wrap(<Harness />));
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "确认标记已退款" }));
      await screen.findByText("标记结果待确认", { exact: true });
      if (method === "button")
        await user.click(
          screen.getByRole("button", { name: "关闭并刷新订单" }),
        );
      else if (method === "escape") await user.keyboard("{Escape}");
      else
        fireEvent.click(
          document.querySelector('[data-slot="dialog-overlay"]')!,
        );
      await waitFor(() =>
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
      );
      expect(invalidate).toHaveBeenCalledOnce();
      expect(unloadBlocked()).toBe(false);
    },
  );

  it.each([
    "refund_mark_version_conflict",
    "refund_mark_not_allowed",
    "admin_operation_conflict",
  ])(
    "does not repeat a rejected %s command and refreshes on close",
    async (code) => {
      const invalidate = vi
        .spyOn(queryClient, "invalidateQueries")
        .mockResolvedValue(undefined);
      const fetchMock = vi.fn(async () => apiError(code, "changed", 409));
      vi.stubGlobal("fetch", fetchMock);
      const close = vi.fn();
      render(wrap(dialog(vi.fn(), close)));
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "确认标记已退款" }));
      await screen.findByRole("alert");
      expect(
        screen.queryByRole("button", { name: "确认标记已退款" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "取消" }),
      ).not.toBeInTheDocument();
      await user.keyboard("{Escape}");
      expect(close).toHaveBeenCalledOnce();
      expect(invalidate).toHaveBeenCalledOnce();
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  it.each(["\u0000", "\u007f", "\ud800"])(
    "locally explains an invalid note instead of sending it (%j)",
    async (invalid) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      render(wrap(dialog()));
      const note = screen.getByLabelText("备注（可选）");
      fireEvent.change(note, { target: { value: "前缀" + invalid + "备注" } });
      fireEvent.submit(note.closest("form")!);
      expect(note).toHaveAttribute("aria-invalid", "true");
      expect(note).toHaveAccessibleDescription(
        /不支持的控制字符|无效的 Unicode 字符/,
      );
      expect(note).toHaveFocus();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("allows correcting the first definite validation rejection without treating it as uncertain", async () => {
    const requests: AdminRefundMarkRequest[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        const body = await request.json();
        requests.push(body);
        return requests.length === 1
          ? apiError("validation_failed", "invalid", 422)
          : json(receipt(body));
      }),
    );
    const success = vi.fn();
    render(wrap(dialog(success)));
    const user = userEvent.setup();
    const note = screen.getByLabelText("备注（可选）");
    await user.type(note, "第一次备注");
    await user.click(screen.getByRole("button", { name: "确认标记已退款" }));
    await screen.findByRole("alert");
    expect(note).not.toHaveAttribute("readonly");
    expect(screen.queryByText("标记结果待确认")).not.toBeInTheDocument();
    await user.clear(note);
    await user.type(note, "修正后的备注");
    await user.click(screen.getByRole("button", { name: "确认标记已退款" }));
    await waitFor(() => expect(success).toHaveBeenCalledOnce());
    expect(requests[1]!.operation_id).not.toBe(requests[0]!.operation_id);
  });

  it("does not silently queue a refund mark while offline", async () => {
    onlineManager.setOnline(false);
    const fetchMock = vi.fn(async () => {
      throw new TypeError("offline");
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      render(wrap(dialog()));
      await userEvent.click(
        screen.getByRole("button", { name: "确认标记已退款" }),
      );
      await screen.findByText("标记结果待确认", { exact: true });
      expect(fetchMock).toHaveBeenCalledOnce();
      await act(async () => {
        onlineManager.setOnline(true);
      });
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      onlineManager.setOnline(true);
    }
  });

  it("keeps record-specific recovery and navigation language without implying a money movement", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("offline");
      }),
    );
    const router = createMemoryRouter(
      [
        {
          element: (
            <DraftProvider>
              <Outlet />
            </DraftProvider>
          ),
          children: [
            { path: "/refund", element: dialog() },
            { path: "/other", element: <h1>其他页面</h1> },
          ],
        },
      ],
      { initialEntries: ["/refund"] },
    );
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "确认标记已退款" }));
    await screen.findByText("标记结果待确认", { exact: true });
    await act(async () => {
      await router.navigate("/other");
    });
    const leave = await screen.findByRole("alertdialog", {
      name: "标记结果尚未确认，仍要离开？",
    });
    expect(within(leave).getByText(/不影响实际资金/)).toBeVisible();
    await user.click(within(leave).getByRole("button", { name: "留在此页" }));
    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "重试原标记" })).toBeVisible();
  });
});
