import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider, onlineManager, useQuery } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queryClient } from "../src/api/client";
import { QueryView } from "../src/components/request-state";

afterEach(() => onlineManager.setOnline(true));

function Read({ request, id = "current", custom = false }: { request: () => Promise<string>; id?: string; custom?: boolean }) {
  const query = useQuery({ queryKey: ["read-state", id], queryFn: request, retry: false });
  return <><button onClick={() => void query.refetch()}>更新</button>
    <QueryView query={query} loading={custom ? <p>对应区域占位</p> : undefined}>
      {value => <input aria-label="读取结果" readOnly value={value} />}
    </QueryView></>;
}
const wrap = (children: React.ReactNode) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;

describe("read state continuity", () => {
  it("keeps the existing content and focus through a failed refresh and a successful retry", async () => {
    let fail = false;
    const request = vi.fn(async () => { if (fail) throw new Error("读取失败"); return "¥129.01"; });
    render(wrap(<Read request={request} />));
    const value = await screen.findByLabelText("读取结果");
    value.focus();
    fail = true;
    fireEvent.click(screen.getByText("更新"));
    await screen.findByText("读取失败");
    expect(screen.getByText("更新未完成，以下保留上次成功读取的内容。")).toBeVisible();
    expect(screen.getByLabelText("读取结果")).toBe(value);
    expect(value).toHaveFocus();
    expect(value).toHaveValue("¥129.01");
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(screen.queryByText("读取失败")).not.toBeInTheDocument());
    expect(screen.getByLabelText("读取结果")).toBe(value);
  });

  it("distinguishes paused initial reads, resumes online, and never borrows another key's result", async () => {
    onlineManager.setOnline(false);
    const request = vi.fn(async () => "当前范围");
    const view = render(wrap(<Read request={request} custom />));
    await screen.findByText("等待网络恢复");
    expect(request).not.toHaveBeenCalled();
    expect(screen.queryByText("对应区域占位")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("读取结果")).not.toBeInTheDocument();
    act(() => onlineManager.setOnline(true));
    expect(await screen.findByLabelText("读取结果")).toHaveValue("当前范围");
    act(() => onlineManager.setOnline(false));
    view.rerender(wrap(<Read id="different" request={request} custom />));
    await screen.findByText("等待网络恢复");
    expect(screen.queryByLabelText("读取结果")).not.toBeInTheDocument();
  });

  it("keeps cached content during a paused refresh and uses the custom placeholder only without data", async () => {
    let release!: (value: string) => void;
    const request = vi.fn(() => new Promise<string>(resolve => { release = resolve; }));
    render(wrap(<Read request={request} custom />));
    expect(screen.getByText("对应区域占位")).toBeVisible();
    await act(async () => { release("已读取"); });
    const value = await screen.findByLabelText("读取结果");
    act(() => onlineManager.setOnline(false));
    fireEvent.click(screen.getByText("更新"));
    await screen.findByText("等待网络恢复");
    expect(screen.getByLabelText("读取结果")).toBe(value);
    expect(value).toHaveValue("已读取");
    expect(screen.queryByText("对应区域占位")).not.toBeInTheDocument();
    expect(request).toHaveBeenCalledTimes(1);
  });
});
