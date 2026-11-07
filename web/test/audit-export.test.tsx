import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AuditFilters } from "../../src/shared/audit";
import { invalidateSessionRequests } from "../src/api/client";
import { AuditActions, AuditExportButton, useAuditExport } from "../src/components/audit-export";
import { ErrorNotice } from "../src/components/request-state";
import { json } from "./fixtures";

const filters: AuditFilters = { created_from: "2026-10-01", created_to: "2026-11-01", category: "requests", outcome: "SUCCESS", site_id: "site_a", q: "order", source_address: "2001:db8::25" };
function Harness({ value = filters, menu = false }: { value?: AuditFilters; menu?: boolean }) {
  const state = useAuditExport(value);
  return <>{menu ? <AuditActions state={state} refresh={() => undefined} refreshing={false} /> : <AuditExportButton state={state} />}<ErrorNotice error={state.error} />{state.generated && <p role="status">文件已生成</p>}</>;
}
function downloads() {
  const create = vi.fn((_blob: Blob) => "blob:audit-export");
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() }));
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
  return { create, click };
}

describe("audit CSV export", () => {
  it("requires an explicit range and rejects more than 366 days before sending a request", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const view = render(<Harness value={{ category: "requests" }} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "导出 CSV" }));
    expect(await screen.findByText(/请先选择发生日期范围/)).toBeVisible();
    view.rerender(<Harness value={{ created_from: "2025-01-01", created_to: "2026-01-02" }} />);
    await user.click(screen.getByRole("button", { name: "导出 CSV" }));
    expect(await screen.findByText(/最多 366 天/)).toBeVisible();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("exports applied filters with CSRF and restores the UTF-8 BOM in read-only demo mode", async () => {
    const { create, click } = downloads();
    const calls: Request[] = [];
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => { calls.push(request); return new Response('"记录类型","次数"\r\n"活动汇总","5"\r\n', { headers: { "content-type": "text/csv;charset=utf-8" } }); }));
    document.cookie = "perpay_csrf=audit-export-test";
    document.documentElement.dataset.perpayDemo = "readonly";
    try {
      render(<Harness />);
      await userEvent.click(screen.getByRole("button", { name: "导出 CSV" }));
      await waitFor(() => expect(create).toHaveBeenCalledOnce());
      expect(click).toHaveBeenCalledOnce();
      expect(screen.getByRole("status")).toHaveTextContent("文件已生成");
      const request = calls[0]!;
      expect(new URL(request.url).pathname).toBe("/api/admin/v1/audit-events/export");
      expect(request.method).toBe("POST");
      expect(request.headers.get("X-CSRF-Token")).toBe("audit-export-test");
      expect(await request.json()).toEqual(filters);
      expect(Array.from(new Uint8Array(await create.mock.calls[0]![0].arrayBuffer()).slice(0, 3))).toEqual([239, 187, 191]);
    } finally { delete document.documentElement.dataset.perpayDemo; }
  });

  it("clears generated feedback on a new attempt or applied-filter change and keeps failures separate", async () => {
    downloads();
    let finish!: (response: Response) => void;
    const deferred = new Promise<Response>(resolve => { finish = resolve; });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response("csv", { headers: { "content-type": "text/csv" } }))
      .mockImplementationOnce(() => deferred)
      .mockResolvedValueOnce(new Response("csv", { headers: { "content-type": "text/csv" } })));
    const view = render(<Harness />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "导出 CSV" }));
    expect(await screen.findByRole("status")).toHaveTextContent("文件已生成");
    await user.click(screen.getByRole("button", { name: "导出 CSV" }));
    expect(screen.queryByText("文件已生成", { exact: true })).not.toBeInTheDocument();
    await act(async () => finish(json({ error: { code: "validation_failed", message: "请缩小导出范围" } }, 422)));
    expect(await screen.findByText("请缩小导出范围")).toBeVisible();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "导出 CSV" }));
    expect(await screen.findByRole("status")).toHaveTextContent("文件已生成");
    expect(screen.queryByText("请缩小导出范围")).not.toBeInTheDocument();
    view.rerender(<Harness value={{ ...filters, site_id: "site_b" }} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("keeps a mobile export running after its menu closes and downloads only once", async () => {
    const { create, click } = downloads();
    let finish!: (response: Response) => void;
    const deferred = new Promise<Response>(resolve => { finish = resolve; });
    const calls: Request[] = [];
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => { calls.push(request); return deferred; }));
    render(<Harness menu />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "更多审计日志操作" }));
    await user.click(await screen.findByRole("menuitem", { name: "导出 CSV" }));
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    expect(calls[0]!.signal.aborted).toBe(false);
    await user.click(screen.getByRole("button", { name: "更多审计日志操作" }));
    expect(await screen.findByRole("menuitem", { name: /导出 CSV/ })).toHaveAttribute("aria-disabled", "true");
    await user.keyboard("{Escape}");
    await act(async () => finish(new Response("csv", { headers: { "content-type": "text/csv" } })));
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(click).toHaveBeenCalledOnce();
    expect(calls).toHaveLength(1);
  });

  it("aborts an export when its applied filter scope changes and drops late files", async () => {
    const { create } = downloads();
    let finish!: (response: Response) => void;
    const deferred = new Promise<Response>(resolve => { finish = resolve; });
    const calls: Request[] = [];
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => { calls.push(request); return deferred; }));
    const view = render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "导出 CSV" }));
    view.rerender(<Harness value={{ ...filters, site_id: "site_b" }} />);
    expect(calls[0]!.signal.aborted).toBe(true);
    await act(async () => finish(new Response("csv", { headers: { "content-type": "text/csv" } })));
    expect(create).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("does not save limits or malformed responses as a CSV or retry them automatically", async () => {
    const { create } = downloads();
    const fetch = vi.fn().mockResolvedValue(json({ error: { code: "validation_failed", message: "导出结果超过 10,000 行，请缩小筛选范围" } }, 422));
    vi.stubGlobal("fetch", fetch);
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "导出 CSV" }));
    expect(await screen.findByText(/超过 10,000 行/)).toBeVisible();
    expect(create).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
    fetch.mockResolvedValueOnce(json({ unexpected: "not a CSV" }));
    await userEvent.click(screen.getByRole("button", { name: "导出 CSV" }));
    expect(await screen.findByText(/未收到完整的 CSV 文件/)).toBeVisible();
    expect(create).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("discards a response from a replaced administrator session", async () => {
    const { create } = downloads();
    let finish!: (response: Response) => void;
    const deferred = new Promise<Response>(resolve => { finish = resolve; });
    vi.stubGlobal("fetch", vi.fn(async () => deferred));
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "导出 CSV" }));
    invalidateSessionRequests();
    await act(async () => finish(new Response("csv", { headers: { "content-type": "text/csv" } })));
    expect(create).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
