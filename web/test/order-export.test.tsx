import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { OrderExport } from "../src/components/order-export";
import { api, csvResult, invalidateSessionRequests } from "../src/api/client";
import { json } from "./fixtures";
const query = {
  sort_by: "created_at" as const,
  sort_order: "desc" as const,
  created_from: "2026-09-30",
  created_to: "2026-10-01",
  q: "商品",
};
describe("order export", () => {
  it("requires dates and does not send an unbounded export", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    render(
      <OrderExport
        query={{ sort_by: "created_at", sort_order: "desc" }}
        payment={undefined}
        checkout={undefined}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "导出 CSV" }));
    expect(await screen.findByText(/请先选择创建日期范围/)).toBeVisible();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("sends applied filters with CSRF and downloads all results with a BOM", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response('"商品"\r\n', {
          headers: { "content-type": "text/csv;charset=utf-8" },
        }),
      );
    vi.stubGlobal("fetch", fetch);
    document.cookie = "perpay_csrf=export-test";
    const create = vi.fn((_blob: Blob) => "blob:export");
    vi.stubGlobal(
      "URL",
      Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() }),
    );
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    render(<OrderExport query={query} payment="CONFIRMED" checkout="OPEN" />);
    await userEvent.click(screen.getByRole("button", { name: "导出 CSV" }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    const request = new Request(
      ...(fetch.mock.calls[0] as [RequestInfo, RequestInit]),
    );
    expect(request.method).toBe("POST");
    expect(request.headers.get("X-CSRF-Token")).toBe("export-test");
    expect(await request.json()).toEqual({
      ...query,
      payment_status: "CONFIRMED",
      checkout_status: "OPEN",
    });
    expect(
      Array.from(
        new Uint8Array(await create.mock.calls[0]![0].arrayBuffer()).slice(
          0,
          3,
        ),
      ),
    ).toEqual([239, 187, 191]);
    expect(click).toHaveBeenCalledOnce();
    document.cookie = "perpay_csrf=; Max-Age=0";
  });
  it("does not save structured errors as CSV files or retry automatically", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        json(
          {
            error: {
              code: "validation_failed",
              message: "导出结果超过 10,000 条，请缩小筛选范围",
            },
          },
          422,
        ),
      );
    vi.stubGlobal("fetch", fetch);
    render(
      <OrderExport query={query} payment={undefined} checkout={undefined} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "导出 CSV" }));
    expect(await screen.findByText(/10,000/)).toBeVisible();
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("keeps a mobile menu export active after the menu closes and downloads the completed response once", async () => {
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>(resolve => { finish = resolve; });
    const fetch = vi.fn((_request: Request) => pending);
    vi.stubGlobal("fetch", fetch);
    const create = vi.fn((_blob: Blob) => "blob:menu-export");
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<OrderExport menu query={query} payment="CONFIRMED" checkout="OPEN" />);
    const user = userEvent.setup();
    const more = screen.getByRole("button", { name: "更多订单操作" });
    await user.click(more);
    await user.click(await screen.findByRole("menuitem", { name: "导出 CSV" }));
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    const request = fetch.mock.calls[0]![0] as Request;
    expect(request.signal.aborted).toBe(false);
    expect(create).not.toHaveBeenCalled();
    await user.click(more);
    expect(await screen.findByRole("menuitem", { name: /导出 CSV/ })).toHaveAttribute("aria-disabled", "true");
    await user.keyboard("{Escape}");
    await act(async () => finish(new Response("csv", { headers: { "content-type": "text/csv;charset=utf-8" } })));
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(click).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
    click.mockRestore();
  });
  it("aborts a mobile menu export when its applied filter scope changes and ignores its late result", async () => {
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>(resolve => { finish = resolve; });
    const fetch = vi.fn((_request: Request) => pending);
    vi.stubGlobal("fetch", fetch);
    const create = vi.fn((_blob: Blob) => "blob:stale-menu-export");
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() }));
    const view = render(<OrderExport menu query={query} payment={undefined} checkout={undefined} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "更多订单操作" }));
    await user.click(await screen.findByRole("menuitem", { name: "导出 CSV" }));
    const request = fetch.mock.calls[0]![0] as Request;
    view.rerender(<OrderExport menu query={{ ...query, q: "新关键词" }} payment={undefined} checkout={undefined} />);
    expect(request.signal.aborted).toBe(true);
    await act(async () => finish(new Response("csv", { headers: { "content-type": "text/csv;charset=utf-8" } })));
    expect(create).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("drops decoded files from a previous administrator session", async () => {
    let finish!: () => void;
    const promise = new Promise<{ data: string; response: Response }>(
      (resolve) => {
        finish = () =>
          resolve({
            data: "csv",
            response: new Response("csv", {
              headers: { "content-type": "text/csv" },
            }),
          });
      },
    );
    const request = csvResult(promise);
    invalidateSessionRequests();
    finish();
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
  });
  it("blocks demo writes locally before fetch while keeping exports readable", async () => {
    document.documentElement.dataset.perpayDemo = "readonly";
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    try {
      const result = await api.createAdministratorTestPayment({
        body: {},
      } as never);
      expect(result.error).toMatchObject({ code: "demo_read_only", message: "当前操作不可用。" });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      delete document.documentElement.dataset.perpayDemo;
    }
  });
});
