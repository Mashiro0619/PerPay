import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { DetailSections } from "../src/components/detail/DetailSections";

function Fixture({ loading = false }: { loading?: boolean }) {
  const location = useLocation();
  const [ready, setReady] = useState(!loading);
  return <>
    <DetailSections sections={[
      { id: "overview", label: "概况", content: <p>交易概况内容</p> },
      { id: "sources", label: "采集记录", anchorPrefixes: ["source-"], content: ready
        ? <p id="source-2" tabIndex={-1}>采集来源内容</p>
        : <div data-slot="skeleton">正在读取采集记录</div> },
    ]} />
    {!ready && <button onClick={() => setReady(true)}>完成读取</button>}
    <output aria-label="当前地址">{location.pathname + location.search + location.hash}</output>
  </>;
}

describe("resource detail sections", () => {
  it("shows every section together and prioritizes a precise legacy anchor over the old selected section", async () => {
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    const router = createMemoryRouter([{ path: "/record/:id", element: <Fixture /> }], { initialEntries: ["/record/1?section=overview&cursor=detail-page#source-2"] });
    render(<RouterProvider router={router} />);
    const target = screen.getByText("采集来源内容");
    await waitFor(() => expect(target).toHaveFocus());
    expect(scroll.mock.contexts).toEqual([target]);
    expect(screen.getByText("交易概况内容")).toBeVisible();
    expect(target).toBeVisible();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.queryByRole("tabpanel")).not.toBeInTheDocument();
    expect(router.state.location.search + router.state.location.hash).toBe("?section=overview&cursor=detail-page#source-2");
  });

  it("locates an old section bookmark once without hiding other sections or resetting unrelated pagination", async () => {
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    const router = createMemoryRouter([{ path: "/record/:id", element: <Fixture /> }], { initialEntries: ["/record/1?section=sources&cursor=detail-page"] });
    render(<RouterProvider router={router} />);
    const section = screen.getByRole("region", { name: "采集记录" });
    await waitFor(() => expect(section).toHaveFocus());
    expect(scroll.mock.contexts).toEqual([section]);
    expect(screen.getByText("采集来源内容")).toBeVisible();
    expect(screen.getByText("交易概况内容")).toBeVisible();
    await act(async () => { await router.navigate("/record/1?section=sources&cursor=next-page"); });
    expect(router.state.location.search).toBe("?section=sources&cursor=next-page");
    expect(scroll).toHaveBeenCalledTimes(1);
  });

  it("waits for asynchronous evidence before locating its anchor", async () => {
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    const router = createMemoryRouter([{ path: "/record/:id", element: <Fixture loading /> }], { initialEntries: ["/record/1#source-2"] });
    render(<RouterProvider router={router} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "完成读取" }));
    const target = screen.getByText("采集来源内容");
    await waitFor(() => expect(target).toHaveFocus());
    expect(scroll.mock.contexts).toEqual([target]);
    expect(screen.getByText("交易概况内容")).toBeVisible();
  });

  it.each(["#obsolete", "#%E0%A4%A"])("falls back to the old section when its hash cannot be resolved: %s", async hash => {
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    const router = createMemoryRouter([{ path: "/record/:id", element: <Fixture /> }], { initialEntries: ["/record/1?section=sources" + hash] });
    render(<RouterProvider router={router} />);
    const section = screen.getByRole("region", { name: "采集记录" });
    await waitFor(() => expect(section).toHaveFocus());
    expect(scroll.mock.contexts).toEqual([section]);
    expect(router.state.location.search + router.state.location.hash).toBe("?section=sources" + hash);
  });

  it.each(["?section=unknown", "#%E0%A4%A", ""])("keeps all sections readable for an absent or invalid destination %s", async suffix => {
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    const router = createMemoryRouter([{ path: "/record/:id", element: <Fixture /> }], { initialEntries: ["/record/1" + suffix] });
    render(<RouterProvider router={router} />);
    expect(screen.getByText("交易概况内容")).toBeVisible();
    expect(screen.getByText("采集来源内容")).toBeVisible();
    expect(scroll).not.toHaveBeenCalled();
  });
});
