import { fireEvent, render, screen } from "@testing-library/react";
import { useEffect, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { PageHeading, PageHeadingProvider, PageHeadingSlot } from "../src/components/page-heading";

describe("page title ownership", () => {
  it("keeps one body h1 during loading, successful refresh and route replacement without moving focus", () => {
    function Route({ identity }: { identity: string }) {
      const [loaded, setLoaded] = useState(false);
      return <><input aria-label="草稿" /><button onClick={() => setLoaded(true)}>刷新</button>
        <PageHeading title={loaded ? identity : "订单详情"} /></>;
    }
    const view = render(<PageHeadingProvider><PageHeadingSlot title="全部订单" /><Route identity="订单 A" /></PageHeadingProvider>);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("订单详情");
    const draft = screen.getByRole("textbox"); draft.focus();
    fireEvent.click(screen.getByText("刷新"));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("订单 A");
    expect(draft).toHaveFocus();
    view.rerender(<PageHeadingProvider><PageHeadingSlot title="对账" /></PageHeadingProvider>);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("对账");
  });
  it("also renders a title outside the application shell", () => {
    render(<PageHeading title="网站设置" description="网站范围" />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("网站设置");
    expect(screen.getByText("网站范围")).toBeVisible();
  });
  it("changes the title scope without remounting wizard state and unsaved fields", () => {
    const mounted = vi.fn();
    function Wizard({ title }: { title: string }) {
      useEffect(() => { mounted(); }, []);
      return <><PageHeading title={title} /><input aria-label="向导草稿" defaultValue="保留" /></>;
    }
    const view = render(<PageHeadingProvider routeKey="application"><PageHeadingSlot title="向导" /><Wizard title="应用公钥" /></PageHeadingProvider>);
    const input = screen.getByRole("textbox"); input.focus();
    view.rerender(<PageHeadingProvider routeKey="provider"><PageHeadingSlot title="向导" /><Wizard title="支付宝账号" /></PageHeadingProvider>);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("支付宝账号");
    expect(screen.getByRole("textbox")).toBe(input); expect(input).toHaveFocus();
    expect(mounted).toHaveBeenCalledTimes(1);
  });
});
