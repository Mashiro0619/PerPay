import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router";
import { describe, expect, it } from "vitest";
import { DetailSections } from "../src/components/detail/DetailSections";

function Fixture() {
  const location = useLocation();
  return <>
    <DetailSections sections={[
      { id: "overview", label: "概况", content: <p>交易概况内容</p> },
      { id: "sources", label: "采集记录", anchorPrefixes: ["source-"], content: <p>采集来源内容</p> },
    ]} />
    <output aria-label="当前地址">{location.pathname + location.search + location.hash}</output>
  </>;
}

describe("resource detail sections", () => {
  it("opens the section containing a legacy anchor and lets an explicit tab clear that anchor", async () => {
    const router = createMemoryRouter([{ path: "/record/:id", element: <Fixture /> }], { initialEntries: ["/record/1?cursor=detail-page#source-2"] });
    render(<RouterProvider router={router} />);
    expect(screen.getByRole("tab", { name: "采集记录" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("采集来源内容")).toBeVisible();
    await userEvent.setup().click(screen.getByRole("tab", { name: "概况" }));
    await waitFor(() => expect(screen.getByLabelText("当前地址")).toHaveTextContent("/record/1?cursor=detail-page"));
    expect(router.state.location.hash).toBe("");
    expect(screen.getByText("交易概况内容")).toBeVisible();
  });

  it("restores a section from the URL and retains unrelated detail pagination", async () => {
    const router = createMemoryRouter([{ path: "/record/:id", element: <Fixture /> }], { initialEntries: ["/record/1?section=sources&cursor=detail-page"] });
    render(<RouterProvider router={router} />);
    expect(screen.getByText("采集来源内容")).toBeVisible();
    expect(screen.queryByText("交易概况内容")).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("tab", { name: "概况" }));
    expect(router.state.location.search).toBe("?cursor=detail-page");
  });
});
