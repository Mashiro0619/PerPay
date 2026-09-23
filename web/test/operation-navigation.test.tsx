import { useState } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, Link, Outlet, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { ApiError, queryClient, sessionKey } from "@/api/client";
import { AuthBoundary } from "@/auth";
import { DraftProvider, useDirtyDraft } from "@/drafts";
import { ReasonDialog } from "@/components/ReasonDialog";
import { FinancialDialog } from "@/pages/FinancialDialog";
import { json, ledger, ledgerId, order, orderId } from "./fixtures";

type Execute = (
  reason: string,
  id: string,
  signal?: AbortSignal,
) => Promise<unknown>;
const uncertain = () => new ApiError(undefined, undefined);
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function mount({
  execute = vi.fn<Execute>().mockRejectedValue(uncertain()),
  manual = false,
  dirty = false,
  authenticated = false,
} = {}) {
  const success = vi.fn();
  function OperationPage() {
    const [open, setOpen] = useState(true);
    useDirtyDraft(dirty);
    const props = {
      onClose: () => setOpen(false),
      onSuccess: () => {
        success();
        setOpen(false);
      },
    };
    return (
      <>
        <h1>操作页面</h1>
        <Link to="/other">其他页面</Link>
        {open &&
          (manual ? (
            <FinancialDialog
              initialOrderId={orderId}
              initialLedgerId={ledgerId}
              {...props}
            />
          ) : (
            <ReasonDialog
              title="撤销收款关联？"
              description="只撤销账务关联，不会转出资金。"
              action="确认撤销关联"
              execute={execute}
              {...props}
            >
              原始交易证据
            </ReasonDialog>
          ))}
      </>
    );
  }
  const router = createMemoryRouter(
    [
      {
        element: authenticated ? (
          <AuthBoundary>
            <DraftProvider>
              <Outlet />
            </DraftProvider>
          </AuthBoundary>
        ) : (
          <DraftProvider>
            <Outlet />
          </DraftProvider>
        ),
        children: [
          { path: "/previous", element: <h1>上一页面</h1> },
          { path: "/operation", element: <OperationPage /> },
          { path: "/other", element: <h1>其他页面</h1> },
        ],
      },
    ],
    { initialEntries: ["/previous", "/operation"] },
  );
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...view, router, execute, success };
}
async function submit(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("操作理由"), "保留原始核查理由");
  await user.click(screen.getByRole("button", { name: "确认撤销关联" }));
}

describe("financial operation navigation protection", () => {
  it("keeps a pending command and its original dialog when browser back is canceled", async () => {
    const pending = deferred<unknown>();
    const execute = vi.fn<Execute>(() => pending.promise);
    const view = mount({ execute });
    const user = userEvent.setup();
    await submit(user);
    const signal = execute.mock.calls[0]![2] as AbortSignal;
    await act(async () => {
      await view.router.navigate(-1);
    });
    const confirmation = await screen.findByRole("alertdialog", {
      name: "操作结果尚未确认，仍要离开？",
    });
    expect(view.router.state.location.pathname).toBe("/operation");
    expect(signal.aborted).toBe(false);
    expect(
      within(confirmation).getByText(execute.mock.calls[0]![1]),
    ).toBeVisible();
    await user.click(
      within(confirmation).getByRole("button", { name: "留在此页" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
    );
    expect(screen.getByLabelText("操作理由")).toHaveValue("保留原始核查理由");
    expect(signal.aborted).toBe(false);
    await act(async () => {
      pending.reject(uncertain());
    });
    await screen.findByText("操作结果待确认", { exact: true });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("keeps the original uncertain command on canceled PUSH and reuses it when retried", async () => {
    const execute = vi
      .fn<Execute>()
      .mockRejectedValueOnce(uncertain())
      .mockResolvedValueOnce(undefined);
    const view = mount({ execute });
    const user = userEvent.setup();
    await submit(user);
    await screen.findByText("操作结果待确认", { exact: true });
    await act(async () => {
      await view.router.navigate("/other");
    });
    const confirmation = await screen.findByRole("alertdialog");
    expect(within(confirmation).getByText(/离开不会撤销/)).toBeVisible();
    await user.click(
      within(confirmation).getByRole("button", { name: "留在此页" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: "重试原操作" }));
    await waitFor(() => expect(view.success).toHaveBeenCalledOnce());
    expect(execute.mock.calls[1]!.slice(0, 2)).toEqual(
      execute.mock.calls[0]!.slice(0, 2),
    );
    expect(view.router.state.location.pathname).toBe("/operation");
  });

  it("aborts only the local wait and refreshes data on explicit leave, ignoring a late success", async () => {
    const pending = deferred<unknown>();
    const execute = vi.fn<Execute>(() => pending.promise);
    const invalidate = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockResolvedValue(undefined);
    const view = mount({ execute });
    const user = userEvent.setup();
    await submit(user);
    const signal = execute.mock.calls[0]![2] as AbortSignal;
    await act(async () => {
      await view.router.navigate(-1);
    });
    const confirmation = await screen.findByRole("alertdialog");
    await user.click(
      within(confirmation).getByRole("button", { name: "离开并稍后核查" }),
    );
    await screen.findByRole("heading", { name: "上一页面" });
    expect(signal.aborted).toBe(true);
    expect(invalidate).toHaveBeenCalledOnce();
    await act(async () => {
      pending.resolve(undefined);
    });
    expect(view.success).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledOnce();
    await act(async () => {
      await view.router.navigate("/other");
    });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("resumes the requested destination if the pending command succeeds before a choice", async () => {
    const pending = deferred<unknown>();
    const execute = vi.fn<Execute>(() => pending.promise);
    const view = mount({ execute });
    const user = userEvent.setup();
    await submit(user);
    await act(async () => {
      await view.router.navigate("/other");
    });
    await screen.findByRole("alertdialog");
    await act(async () => {
      pending.resolve(undefined);
    });
    await screen.findByRole("heading", { name: "其他页面" });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(view.success).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
  });

  it("does not steal focus underneath the leave confirmation when the pending response fails", async () => {
    const pending = deferred<unknown>();
    const execute = vi.fn<Execute>(() => pending.promise);
    const view = mount({ execute });
    const user = userEvent.setup();
    await submit(user);
    await act(async () => {
      await view.router.navigate(-1);
    });
    const confirmation = await screen.findByRole("alertdialog");
    await waitFor(() =>
      expect(
        within(confirmation).getByRole("button", { name: "留在此页" }),
      ).toHaveFocus(),
    );
    await act(async () => {
      pending.reject(uncertain());
    });
    expect(confirmation).toContainElement(
      document.activeElement as HTMLElement,
    );
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
    );
    expect(
      screen.getByRole("dialog", { name: "撤销收款关联？" }),
    ).toBeVisible();
    expect(screen.getByLabelText("操作理由")).toHaveAttribute("readonly");
  });

  it("does not block navigation for an unsent command or a cancellable evidence query", async () => {
    const view = mount();
    await act(async () => {
      await view.router.navigate(-1);
    });
    await screen.findByRole("heading", { name: "上一页面" });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(view.execute).not.toHaveBeenCalled();
    view.unmount();
    const readSignals: AbortSignal[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((r: Request) => {
        readSignals.push(r.signal);
        return new Promise<Response>(() => {});
      }),
    );
    const manual = mount({ manual: true });
    await waitFor(() => expect(readSignals).toHaveLength(2));
    await act(async () => {
      await manual.router.navigate(-1);
    });
    await screen.findByRole("heading", { name: "上一页面" });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(readSignals.every((s) => s.aborted)).toBe(true);
  });

  it("does not bypass an unrelated dirty draft or register a second router blocker", async () => {
    const warn = vi.spyOn(console, "warn");
    const view = mount({ dirty: true });
    const user = userEvent.setup();
    await submit(user);
    await screen.findByText("操作结果待确认", { exact: true });
    await act(async () => {
      await view.router.navigate(-1);
    });
    const confirmation = await screen.findByRole("alertdialog");
    expect(within(confirmation).getByText(/未保存的修改/)).toBeVisible();
    expect(
      screen.queryByRole("alertdialog", { name: "放弃未保存的修改？" }),
    ).not.toBeInTheDocument();
    await user.click(
      within(confirmation).getByRole("button", { name: "留在此页" }),
    );
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    expect(
      warn.mock.calls.some((args) =>
        args.join(" ").includes("only supports one blocker"),
      ),
    ).toBe(false);
  });

  it("protects manual settlement without swapping its selected evidence or operation ID", async () => {
    const requests: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (r: Request) => {
        requests.push(r);
        if (r.method === "POST") throw new TypeError("network failure");
        return json({
          data: r.url.includes("ledger-entries") ? ledger : order,
        });
      }),
    );
    const view = mount({ manual: true });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "查看关联信息" }));
    await user.type(await screen.findByLabelText("操作理由"), "人工核查原证据");
    await user.click(screen.getByRole("button", { name: "确认关联收款" }));
    await screen.findByText("操作结果待确认", { exact: true });
    const body = await requests
      .find((r) => r.method === "POST")!
      .clone()
      .json();
    await act(async () => {
      await view.router.navigate(-1);
    });
    const confirmation = await screen.findByRole("alertdialog");
    expect(
      within(confirmation).getByText(body.financial_operation_id),
    ).toBeVisible();
    await user.click(
      within(confirmation).getByRole("button", { name: "留在此页" }),
    );
    expect(body.order_id).toBe(orderId);
    expect(body.ledger_entry_id).toBe(ledgerId);
    expect(screen.queryByRole("button", { name: "返回选择" })).not.toBeInTheDocument();
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(requests.filter(r => r.method === "GET")).toHaveLength(2);
    expect(screen.getByLabelText("操作理由")).toHaveAttribute("readonly");
    expect(requests.filter((r) => r.method === "POST")).toHaveLength(1);
  });
  it("lets session expiry clear a blocked operation without replaying or retaining its identifiers", async () => {
    const metadata = document.createElement("meta");
    metadata.name = "perpay-initialized";
    metadata.content = "true";
    document.head.append(metadata);
    queryClient.setQueryData(sessionKey, {
      data: {
        username: "admin",
        csrf_token_required: true,
        idle_expires_at: "2099-01-01T00:00:00Z",
        absolute_expires_at: "2099-01-01T00:00:00Z",
      },
    });
    const pending = deferred<unknown>();
    const execute = vi.fn<Execute>(() => pending.promise);
    const view = mount({ execute, authenticated: true });
    const user = userEvent.setup();
    await submit(user);
    const operationId = execute.mock.calls[0]![1];
    const signal = execute.mock.calls[0]![2]!;
    await act(async () => {
      await view.router.navigate(-1);
    });
    await screen.findByRole("alertdialog");
    await act(async () => {
      window.dispatchEvent(new Event("perpay:session-expired"));
    });
    await screen.findByRole("heading", { name: "登录管理后台" });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.queryByText(operationId)).not.toBeInTheDocument();
    expect(signal.aborted).toBe(true);
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(false);
    await act(async () => {
      pending.resolve(undefined);
    });
    expect(view.success).not.toHaveBeenCalled();
    await act(async () => {
      await view.router.navigate("/other");
    });
    expect(view.router.state.location.pathname).toBe("/other");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("keeps hash-only navigation unblocked and handles repeated destination changes without duplicate commands", async () => {
    const view = mount();
    const user = userEvent.setup();
    await submit(user);
    await screen.findByText("操作结果待确认", { exact: true });
    await act(async () => {
      await view.router.navigate("/operation#evidence");
    });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await act(async () => {
      await view.router.navigate("/previous");
    });
    await screen.findByRole("alertdialog");
    await act(async () => {
      await view.router.navigate("/other");
    });
    expect(screen.getAllByRole("alertdialog")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "离开并稍后核查" }));
    await screen.findByRole("heading", { name: "其他页面" });
    expect(view.execute).toHaveBeenCalledOnce();
  });

  it("protects a navigation attempted immediately by the sending callback before pending state is painted", async () => {
    const pending = deferred<unknown>();
    let navigate = () => {};
    const execute = vi.fn<Execute>(() => {
      navigate();
      return pending.promise;
    });
    const view = mount({ execute });
    navigate = () => {
      void view.router.navigate("/other");
    };
    const user = userEvent.setup();
    await submit(user);
    const confirmation = await screen.findByRole("alertdialog");
    expect(view.router.state.location.pathname).toBe("/operation");
    await user.click(
      within(confirmation).getByRole("button", { name: "留在此页" }),
    );
    await act(async () => {
      pending.reject(uncertain());
    });
    await screen.findByText("操作结果待确认", { exact: true });
    expect(execute).toHaveBeenCalledOnce();
  });
});
