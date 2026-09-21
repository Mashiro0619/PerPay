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
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { queryClient, type AdminWorkItem } from "@/api/client";
import WorkItems from "@/pages/WorkItems";
import { apiError, json } from "./fixtures";

const makeItem = (index: number, ended = false): AdminWorkItem => ({
  type: "LEDGER_CONFLICT",
  resource_id: "00000000-0000-4000-8000-" + String(index).padStart(12, "0"),
  provider_account_key: "primary",
  conflict_type: "INVALID_AMOUNT",
  external_event_id: "流水-" + index,
  status: ended ? "IGNORED" : "OPEN",
  created_at: "2026-09-20T01:00:00Z",
  actionable_at: "2026-09-20T02:00:00Z",
  ignored_at: "2026-09-21T03:00:00Z",
  ignored_by: "admin",
  ended,
  detail_url: "unused",
  order_id: null,
  ledger_entry_id: null,
});
function mount(
  options: {
    rows?: AdminWorkItem[];
    initial?: string;
    restore?: (request: Request) => Response | Promise<Response>;
    get?: (url: URL) => Response | undefined;
  } = {},
) {
  const rows = options.rows ?? [makeItem(1), makeItem(2), makeItem(3)];
  const writes: Request[] = [];
  const gets: string[] = [];
  const removed = new Set<string>();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (request.method === "POST") {
        writes.push(request.clone());
        if (options.restore) return options.restore(request);
        const id = url.pathname.split("/").at(-3)!;
        removed.add(id);
        return json({
          data: {
            operation_id: (await request.json()).operation_id,
            type: "LEDGER_CONFLICT",
            resource_id: id,
            restored: true,
          },
        });
      }
      gets.push(url.search);
      return (
        options.get?.(url) ??
        json({
          data: rows.filter((item) => !removed.has(item.resource_id)),
          page: { next_cursor: null },
        })
      );
    }),
  );
  const router = createMemoryRouter(
    [
      { path: "/work-items", element: <WorkItems /> },
      { path: "/other", element: <h1>其他页面</h1> },
    ],
    {
      initialEntries: [
        options.initial ??
          "/work-items?type=LEDGER_CONFLICT&visibility=IGNORED&cursor=second&page=2",
      ],
    },
  );
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...view, router, writes, gets, removed, rows };
}
const row = (index: number) => screen.getByText("流水-" + index).closest("tr")!;

describe("reminder restore list continuity", () => {
  it("times out each request independently and ignores its late receipt after an explicit retry", async () => {
    let finish!: (response: Response) => void;
    let first!: Request;
    let attempt = 0;
    const view = mount({
      restore: async (request) => {
        attempt++;
        if (attempt === 1) {
          first = request;
          return new Promise((resolve) => {
            finish = resolve;
          });
        }
        return json({
          data: {
            ...(await request.json()),
            type: "LEDGER_CONFLICT",
            resource_id: makeItem(1).resource_id,
            restored: false,
          },
        });
      },
    });
    await screen.findByText("流水-1");
    vi.useFakeTimers();
    const button = within(row(1)).getByRole("button", { name: "恢复提醒" });
    fireEvent.click(button);
    fireEvent.click(button);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_100);
    });
    expect(view.writes).toHaveLength(1);
    expect(first.signal.aborted).toBe(true);
    expect(
      within(row(1)).getByRole("button", { name: "重试恢复" }),
    ).toBeEnabled();
    fireEvent.click(within(row(1)).getByRole("button", { name: "重试恢复" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(await view.writes[1]!.json()).toEqual(await view.writes[0]!.json());
    expect(screen.getByText("这条提醒已恢复，无需重复操作。")).toBeVisible();
    await act(async () => {
      finish(
        json({
          data: {
            ...(await first.json()),
            type: "LEDGER_CONFLICT",
            resource_id: makeItem(1).resource_id,
            restored: true,
          },
        }),
      );
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(screen.getByText("这条提醒已恢复，无需重复操作。")).toBeVisible();
    expect(screen.queryByText("本次提醒恢复已完成。")).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it("keeps the last chosen position when its neighbor is another pending restore", async () => {
    const removed = new Set<string>();
    const pending = new Map<
      string,
      { request: Request; resolve: (response: Response) => void }
    >();
    mount({
      rows: [makeItem(1), makeItem(2), makeItem(3), makeItem(4)],
      get: () =>
        json({
          data: [makeItem(1), makeItem(2), makeItem(3), makeItem(4)].filter(
            (item) => !removed.has(item.resource_id),
          ),
          page: { next_cursor: null },
        }),
      restore: (request) =>
        new Promise((resolve) =>
          pending.set(new URL(request.url).pathname.split("/").at(-3)!, {
            request,
            resolve,
          }),
        ),
    });
    const user = userEvent.setup();
    await screen.findByText("流水-4");
    await user.click(within(row(3)).getByRole("button", { name: "恢复提醒" }));
    await user.click(within(row(2)).getByRole("button", { name: "恢复提醒" }));
    const finish = async (index: number) => {
      const id = makeItem(index).resource_id;
      removed.add(id);
      const entry = pending.get(id)!;
      entry.resolve(
        json({
          data: {
            ...(await entry.request.json()),
            type: "LEDGER_CONFLICT",
            resource_id: id,
            restored: true,
          },
        }),
      );
    };
    await act(async () => {
      await finish(2);
    });
    await waitFor(() =>
      expect(screen.queryByText("流水-2")).not.toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(
        within(row(4)).getByRole("button", { name: "恢复提醒" }),
      ).toHaveFocus(),
    );
    await act(async () => {
      await finish(3);
    });
    await waitFor(() =>
      expect(screen.queryByText("流水-3")).not.toBeInTheDocument(),
    );
    expect(
      within(row(4)).getByRole("button", { name: "恢复提醒" }),
    ).toHaveFocus();
  });

  it("retreats an emptied tail page even when the older request finishes last", async () => {
    const removed = new Set<string>();
    const pending = new Map<
      string,
      { request: Request; resolve: (response: Response) => void }
    >();
    const view = mount({
      initial: "/work-items?type=LEDGER_CONFLICT&visibility=IGNORED",
      get: (url) =>
        json({
          data: (url.searchParams.has("cursor")
            ? [makeItem(3), makeItem(4)]
            : [makeItem(1), makeItem(2)]
          ).filter((item) => !removed.has(item.resource_id)),
          page: {
            next_cursor: url.searchParams.has("cursor") ? null : "second",
          },
        }),
      restore: (request) =>
        new Promise((resolve) =>
          pending.set(new URL(request.url).pathname.split("/").at(-3)!, {
            request,
            resolve,
          }),
        ),
    });
    const user = userEvent.setup();
    await screen.findByText("流水-1");
    await user.click(screen.getByRole("button", { name: "下一页" }));
    await screen.findByText("流水-4");
    await user.click(within(row(3)).getByRole("button", { name: "恢复提醒" }));
    await user.click(within(row(4)).getByRole("button", { name: "恢复提醒" }));
    const finish = async (index: number) => {
      const id = makeItem(index).resource_id;
      removed.add(id);
      const entry = pending.get(id)!;
      entry.resolve(
        json({
          data: {
            ...(await entry.request.json()),
            type: "LEDGER_CONFLICT",
            resource_id: id,
            restored: true,
          },
        }),
      );
    };
    await act(async () => {
      await finish(4);
    });
    await waitFor(() =>
      expect(screen.queryByText("流水-4")).not.toBeInTheDocument(),
    );
    await act(async () => {
      await finish(3);
    });
    await screen.findByText("流水-2");
    expect(view.router.state.location.search).not.toContain("cursor");
    expect(view.router.state.historyAction).toBe("REPLACE");
  });

  it("keeps the failed request retryable when another restoration succeeds", async () => {
    const removed = new Set<string>();
    const view = mount({
      get: () =>
        json({
          data: [makeItem(1), makeItem(2), makeItem(3)].filter(
            (item) => !removed.has(item.resource_id),
          ),
          page: { next_cursor: null },
        }),
      restore: async (request) => {
        const id = new URL(request.url).pathname.split("/").at(-3)!;
        if (id === makeItem(2).resource_id && !removed.has(id)) {
          throw new TypeError("response lost before sending");
        }
        removed.add(id);
        return json({
          data: {
            ...(await request.json()),
            type: "LEDGER_CONFLICT",
            resource_id: id,
            restored: true,
          },
        });
      },
    });
    const user = userEvent.setup();
    await screen.findByText("流水-3");
    await user.click(within(row(2)).getByRole("button", { name: "恢复提醒" }));
    await screen.findByRole("button", { name: "重试恢复" });
    await user.click(within(row(1)).getByRole("button", { name: "恢复提醒" }));
    await waitFor(() =>
      expect(screen.queryByText("流水-1")).not.toBeInTheDocument(),
    );
    expect(
      within(row(2)).getByRole("button", { name: "重试恢复" }),
    ).toBeEnabled();
    removed.add(makeItem(2).resource_id);
    await user.click(within(row(2)).getByRole("button", { name: "重试恢复" }));
    await waitFor(() =>
      expect(screen.queryByText("流水-2")).not.toBeInTheDocument(),
    );
    expect(await view.writes[2]!.json()).toEqual(await view.writes[0]!.json());
    await waitFor(() =>
      expect(
        within(row(3)).getByRole("button", { name: "恢复提醒" }),
      ).toHaveFocus(),
    );
  });

  it("does not reclaim focus after the user chooses a different row that is also removed", async () => {
    const removed = new Set<string>();
    const pending = new Map<
      string,
      { request: Request; resolve: (response: Response) => void }
    >();
    mount({
      rows: [makeItem(1), makeItem(2), makeItem(3), makeItem(4)],
      get: () =>
        json({
          data: [makeItem(1), makeItem(2), makeItem(3), makeItem(4)].filter(
            (item) => !removed.has(item.resource_id),
          ),
          page: { next_cursor: null },
        }),
      restore: (request) =>
        new Promise((resolve) => {
          const id = new URL(request.url).pathname.split("/").at(-3)!;
          removed.add(id);
          pending.set(id, { request, resolve });
        }),
    });
    const user = userEvent.setup();
    await screen.findByText("流水-4");
    await user.click(within(row(1)).getByRole("button", { name: "恢复提醒" }));
    await user.click(within(row(3)).getByRole("button", { name: "恢复提醒" }));
    within(row(1)).getByRole("link").focus();
    await act(async () => {
      for (const [id, entry] of pending)
        entry.resolve(
          json({
            data: {
              ...(await entry.request.json()),
              type: "LEDGER_CONFLICT",
              resource_id: id,
              restored: true,
            },
          }),
        );
    });
    await waitFor(() =>
      expect(screen.queryByText("流水-3")).not.toBeInTheDocument(),
    );
    expect(document.body).toHaveFocus();
  });

  it("does not reuse a focus request after paging away and back to the same cursor", async () => {
    let pending!: { request: Request; resolve: (response: Response) => void };
    const view = mount({
      restore: (request) =>
        new Promise((resolve) => {
          pending = { request, resolve };
        }),
    });
    const user = userEvent.setup();
    await screen.findByText("流水-2");
    const original =
      view.router.state.location.pathname + view.router.state.location.search;
    await user.click(within(row(1)).getByRole("button", { name: "恢复提醒" }));
    await act(async () => {
      await view.router.navigate(
        "/work-items?type=LEDGER_CONFLICT&visibility=IGNORED",
      );
    });
    await act(async () => {
      await view.router.navigate(original);
    });
    await screen.findByText("流水-2");
    expect(pending.request.signal.aborted).toBe(false);
    await act(async () => {
      pending.resolve(
        json({
          data: {
            ...(await pending.request.json()),
            type: "LEDGER_CONFLICT",
            resource_id: makeItem(1).resource_id,
            restored: true,
          },
        }),
      );
    });
    await waitFor(() =>
      expect(
        within(row(1)).getByRole("button", { name: "刷新列表" }),
      ).toBeEnabled(),
    );
    expect(document.body).toHaveFocus();
    expect(screen.queryByText("本次提醒恢复已完成。")).not.toBeInTheDocument();
  });

  it("aborts all outstanding waits on leaving the list without warning or later navigation", async () => {
    const requests: Request[] = [];
    const view = mount({
      restore: (request) => {
        requests.push(request);
        return new Promise(() => {});
      },
    });
    const user = userEvent.setup();
    await screen.findByText("流水-3");
    await user.click(within(row(1)).getByRole("button", { name: "恢复提醒" }));
    await user.click(within(row(2)).getByRole("button", { name: "恢复提醒" }));
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(false);
    await act(async () => {
      await view.router.navigate("/other");
    });
    expect(screen.getByRole("heading", { name: "其他页面" })).toBeVisible();
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.signal.aborted)).toBe(true);
  });

  it.each(["first", "last", "together"] as const)(
    "keeps both requests alive and follows the last action when %s response arrives first",
    async (order) => {
      const removed = new Set<string>();
      const pending = new Map<
        string,
        { request: Request; resolve: (response: Response) => void }
      >();
      const view = mount({
        rows: Array.from({ length: 6 }, (_, index) => makeItem(index + 1)),
        get: () =>
          json({
            data: Array.from({ length: 6 }, (_, index) =>
              makeItem(index + 1),
            ).filter((item) => !removed.has(item.resource_id)),
            page: { next_cursor: null },
          }),
        restore: (request) => {
          const id = new URL(request.url).pathname.split("/").at(-3)!;
          removed.add(id);
          return new Promise((resolve) =>
            pending.set(id, { request, resolve }),
          );
        },
      });
      const user = userEvent.setup();
      await screen.findByText("流水-6");
      const initialSearch = view.router.state.location.search;
      await user.click(
        within(row(2)).getByRole("button", { name: "恢复提醒" }),
      );
      await user.click(
        within(row(5)).getByRole("button", { name: "恢复提醒" }),
      );
      const finish = async (index: number) => {
        const entry = pending.get(makeItem(index).resource_id)!;
        const body = await entry.request.clone().json();
        entry.resolve(
          json({
            data: {
              ...body,
              type: "LEDGER_CONFLICT",
              resource_id: makeItem(index).resource_id,
              restored: index === 2,
            },
          }),
        );
      };
      await act(async () => {
        if (order === "together") await Promise.all([finish(2), finish(5)]);
        else await finish(order === "first" ? 2 : 5);
      });
      await waitFor(() =>
        expect(screen.queryByText("流水-5")).not.toBeInTheDocument(),
      );
      expect(
        pending.get(makeItem(order === "last" ? 2 : 5).resource_id)!.request
          .signal.aborted,
      ).toBe(false);
      if (order !== "together")
        await act(async () => {
          await finish(order === "first" ? 5 : 2);
        });
      await screen.findByText("这条提醒已恢复，无需重复操作。");
      await waitFor(() =>
        expect(
          within(row(6)).getByRole("button", { name: "恢复提醒" }),
        ).toHaveFocus(),
      );
      expect(view.router.state.location.search).toBe(initialSearch);
      expect(view.writes).toHaveLength(2);
    },
  );

  it("keeps the same page and moves focus to the next row rather than restarting the list", async () => {
    const view = mount();
    const user = userEvent.setup();
    await screen.findByText("流水-2");
    const before = view.router.state.location.search;
    await user.click(within(row(2)).getByRole("button", { name: "恢复提醒" }));
    await screen.findByText("本次提醒恢复已完成。");
    await waitFor(() =>
      expect(screen.queryByText("流水-2")).not.toBeInTheDocument(),
    );
    expect(view.router.state.location.search).toBe(before);
    await waitFor(() =>
      expect(
        within(row(3)).getByRole("button", { name: "恢复提醒" }),
      ).toHaveFocus(),
    );
    expect(view.writes).toHaveLength(1);
  });
  it("retreats only an emptied page using the visited cursor trail, without adding a history entry", async () => {
    let restored = false;
    const view = mount({
      initial: "/work-items?type=LEDGER_CONFLICT&visibility=IGNORED",
      get: (url) =>
        json({
          data: url.searchParams.has("cursor")
            ? restored
              ? []
              : [makeItem(3)]
            : [makeItem(1), makeItem(2)],
          page: {
            next_cursor: url.searchParams.has("cursor") ? null : "second",
          },
        }),
      restore: async (request) => {
        restored = true;
        return json({
          data: {
            operation_id: (await request.json()).operation_id,
            type: "LEDGER_CONFLICT",
            resource_id: makeItem(3).resource_id,
            restored: true,
          },
        });
      },
    });
    const user = userEvent.setup();
    await screen.findByText("流水-1");
    await user.click(screen.getByRole("button", { name: "下一页" }));
    await screen.findByText("流水-3");
    await user.click(within(row(3)).getByRole("button", { name: "恢复提醒" }));
    await screen.findByText("流水-2");
    expect(view.router.state.location.search).not.toContain("cursor");
    expect(view.router.state.historyAction).toBe("REPLACE");
    await waitFor(() =>
      expect(
        within(row(2)).getByRole("button", { name: "恢复提醒" }),
      ).toHaveFocus(),
    );
  });
  it("does not return to an old page or steal focus if the user paged elsewhere during restoration", async () => {
    let finish!: (response: Response) => void;
    const view = mount({
      restore: () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
      get: (url) =>
        json({
          data:
            url.searchParams.get("cursor") === "third"
              ? [makeItem(8)]
              : [makeItem(1)],
          page: { next_cursor: "third" },
        }),
    });
    const user = userEvent.setup();
    await screen.findByText("流水-1");
    await user.click(within(row(1)).getByRole("button", { name: "恢复提醒" }));
    await user.click(screen.getByRole("button", { name: "下一页" }));
    await screen.findByText("流水-8");
    const focused = within(row(8)).getByRole("link");
    focused.focus();
    const body = await view.writes[0]!.json();
    await act(async () => {
      finish(
        json({
          data: {
            ...body,
            type: "LEDGER_CONFLICT",
            resource_id: makeItem(1).resource_id,
            restored: true,
          },
        }),
      );
    });
    expect(view.router.state.location.search).toContain("cursor=third");
    expect(focused).toHaveFocus();
  });
  it("announces an already-restored receipt accurately instead of claiming a new recovery", async () => {
    const view = mount({
      restore: async (request) =>
        json({
          data: {
            operation_id: (await request.json()).operation_id,
            type: "LEDGER_CONFLICT",
            resource_id: makeItem(1).resource_id,
            restored: false,
          },
        }),
    });
    const user = userEvent.setup();
    await screen.findByText("流水-1");
    await user.click(within(row(1)).getByRole("button", { name: "恢复提醒" }));
    expect(
      await screen.findByText("这条提醒已恢复，无需重复操作。"),
    ).toBeVisible();
    expect(view.writes).toHaveLength(1);
  });
  it("refreshes an ended item into a disabled state instead of offering an endless failing retry", async () => {
    let ended = false;
    const view = mount({
      get: () =>
        json({ data: [makeItem(1, ended)], page: { next_cursor: null } }),
      restore: () => {
        ended = true;
        return apiError("work_item_ended", "ended", 409);
      },
    });
    const user = userEvent.setup();
    await screen.findByText("流水-1");
    await user.click(within(row(1)).getByRole("button", { name: "恢复提醒" }));
    await screen.findByText("事项已结束，无需恢复提醒。");
    await waitFor(() =>
      expect(
        within(row(1)).getByRole("button", { name: "已结束" }),
      ).toBeDisabled(),
    );
    expect(view.writes).toHaveLength(1);
    expect(
      within(row(1)).queryByRole("button", { name: "重试恢复" }),
    ).not.toBeInTheDocument();
  });
  it("retains the exact request after a lost response and does not block leaving a reversible reminder action", async () => {
    let attempt = 0;
    const view = mount({
      restore: async (request) => {
        attempt++;
        if (attempt === 1) throw new TypeError("lost response");
        return json({
          data: {
            operation_id: (await request.json()).operation_id,
            type: "LEDGER_CONFLICT",
            resource_id: makeItem(1).resource_id,
            restored: true,
          },
        });
      },
    });
    const user = userEvent.setup();
    await screen.findByText("流水-1");
    await user.click(within(row(1)).getByRole("button", { name: "恢复提醒" }));
    await screen.findByRole("button", { name: "重试恢复" });
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(false);
    await user.click(within(row(1)).getByRole("button", { name: "重试恢复" }));
    await screen.findByText("本次提醒恢复已完成。");
    expect(await view.writes[1]!.json()).toEqual(await view.writes[0]!.json());
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
  it("rejects an empty or mismatched success receipt instead of announcing restoration", async () => {
    const view = mount({ restore: () => json({ data: {} }) });
    const user = userEvent.setup();
    await screen.findByText("流水-1");
    await user.click(within(row(1)).getByRole("button", { name: "恢复提醒" }));
    await screen.findByRole("button", { name: "重试恢复" });
    expect(screen.queryByText("本次提醒恢复已完成。")).not.toBeInTheDocument();
    expect(view.writes).toHaveLength(1);
  });
  it("attempts an explicit offline restore without queuing it for a later unrelated page", async () => {
    onlineManager.setOnline(false);
    try {
      const view = mount({
        restore: () => {
          throw new TypeError("offline");
        },
      });
      await act(async () => {
        onlineManager.setOnline(true);
      });
      await screen.findByText("流水-1");
      onlineManager.setOnline(false);
      await userEvent.click(
        within(row(1)).getByRole("button", { name: "恢复提醒" }),
      );
      await screen.findByRole("button", { name: "重试恢复" });
      expect(view.writes).toHaveLength(1);
      await act(async () => {
        onlineManager.setOnline(true);
      });
      expect(view.writes).toHaveLength(1);
    } finally {
      onlineManager.setOnline(true);
    }
  });
  it("keeps another chosen control focused when the user moved on before the response", async () => {
    let finish!: (response: Response) => void;
    const view = mount({
      restore: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    const user = userEvent.setup();
    await screen.findByText("流水-1");
    await user.click(within(row(1)).getByRole("button", { name: "恢复提醒" }));
    const other = within(row(3)).getByRole("link");
    other.focus();
    const body = await view.writes[0]!.json();
    await act(async () => {
      finish(
        json({
          data: {
            ...body,
            type: "LEDGER_CONFLICT",
            resource_id: makeItem(1).resource_id,
            restored: true,
          },
        }),
      );
    });
    await screen.findByText("本次提醒恢复已完成。");
    expect(other).toHaveFocus();
  });
  it("does not confuse a failed refresh with an empty page or discard the current cursor", async () => {
    let failed = false;
    const view = mount({
      get: () =>
        failed ? apiError("internal_error", "read failed", 503) : undefined,
      restore: async (request) => {
        failed = true;
        return json({
          data: {
            operation_id: (await request.json()).operation_id,
            type: "LEDGER_CONFLICT",
            resource_id: makeItem(1).resource_id,
            restored: true,
          },
        });
      },
    });
    const user = userEvent.setup();
    await screen.findByText("流水-1");
    const before = view.router.state.location.search;
    await user.click(within(row(1)).getByRole("button", { name: "恢复提醒" }));
    await screen.findByRole("alert");
    expect(view.router.state.location.search).toBe(before);
    expect(screen.getByText("流水-2")).toBeVisible();
    expect(screen.getByText("本次提醒恢复已完成。")).toBeVisible();
  });
  it("focuses the empty result region after restoring the final row on the first page", async () => {
    const view = mount({
      rows: [makeItem(1)],
      initial: "/work-items?type=LEDGER_CONFLICT&visibility=IGNORED",
    });
    const user = userEvent.setup();
    await screen.findByText("流水-1");
    await user.click(within(row(1)).getByRole("button", { name: "恢复提醒" }));
    await screen.findByRole("heading", { name: "暂无已忽略提醒" });
    await waitFor(() =>
      expect(
        screen.getByRole("region", { name: "已忽略提醒列表" }),
      ).toHaveFocus(),
    );
    expect(view.router.state.location.search).not.toContain("cursor");
  });
  it("treats a missing reminder as a no-longer-available record and reads the latest list", async () => {
    let missing = false;
    const view = mount({
      get: () =>
        json({
          data: missing ? [] : [makeItem(1)],
          page: { next_cursor: null },
        }),
      initial: "/work-items?type=LEDGER_CONFLICT&visibility=IGNORED",
      restore: () => {
        missing = true;
        return apiError("work_item_not_found", "missing", 404);
      },
    });
    const user = userEvent.setup();
    await screen.findByText("流水-1");
    await user.click(within(row(1)).getByRole("button", { name: "恢复提醒" }));
    await screen.findByText("提醒对应的记录已不存在。");
    await screen.findByRole("heading", { name: "暂无已忽略提醒" });
    expect(view.writes).toHaveLength(1);
  });
  it("clears the previous success when a new row starts an uncertain recovery", async () => {
    let attempt = 0;
    const view = mount({
      restore: async (request) => {
        attempt++;
        if (attempt === 2) throw new TypeError("lost");
        const id = new URL(request.url).pathname.split("/").at(-3)!;
        return json({
          data: {
            operation_id: (await request.json()).operation_id,
            type: "LEDGER_CONFLICT",
            resource_id: id,
            restored: true,
          },
        });
      },
    });
    const user = userEvent.setup();
    await screen.findByText("流水-1");
    await user.click(within(row(1)).getByRole("button", { name: "恢复提醒" }));
    await screen.findByText("本次提醒恢复已完成。");
    await user.click(within(row(2)).getByRole("button", { name: "恢复提醒" }));
    await screen.findByRole("button", { name: "重试恢复" });
    expect(screen.queryByText("本次提醒恢复已完成。")).not.toBeInTheDocument();
    expect(view.writes).toHaveLength(2);
  });
  it("keeps long recovery diagnostics out of the action column and exposes them on demand without navigating", async () => {
    const view = mount({
      restore: () => {
        throw new TypeError("network failure");
      },
    });
    const user = userEvent.setup();
    await screen.findByText("流水-1");
    await user.click(within(row(1)).getByRole("button", { name: "恢复提醒" }));
    await screen.findByRole("button", { name: "重试恢复" });
    expect(within(row(1)).queryByRole("alert")).not.toBeInTheDocument();
    const details = within(row(1)).getByRole("button", { name: "响应详情" });
    await user.click(details);
    const popover = await screen.findByRole("dialog", {
      name: "恢复提醒的响应",
    });
    expect(within(popover).getByRole("alert")).toHaveTextContent(
      "无法连接服务",
    );
    expect(row(1)).not.toContainElement(popover);
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(view.router.state.location.pathname).toBe("/work-items");
    expect(view.writes).toHaveLength(1);
  });
});
