import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router";
import { describe, expect, it } from "vitest";
import { DetailNavigation } from "../src/components/detail/DetailPrimitives";

describe("detail navigation", () => {
  it("copies the complete navigation ID and preserves the saved return query and state", async () => {
    const identifier = "11111111-1111-4111-8111-111111111111";
    const user = userEvent.setup();
    function Destination() { const location = useLocation(); return <output>{JSON.stringify({ search: location.search, state: location.state })}</output>; }
    const router = createMemoryRouter([
      { path: "/ledger/:id", element: <DetailNavigation global back={{ to: "/ledger?q=a%20b&cursor=two&page=2", label: "返回流水", state: { page: 2 } }} identifier={identifier} identifierLabel="归组流水编号" /> },
      { path: "/ledger", element: <Destination /> },
    ], { initialEntries: ["/ledger/" + identifier] });
    render(<RouterProvider router={router} />);
    await user.click(screen.getByRole("button", { name: "复制归组流水编号" }));
    expect(await navigator.clipboard.readText()).toBe(identifier);
    await user.click(screen.getByRole("link", { name: "返回流水" }));
    expect(router.state.location.search).toBe("?q=a%20b&cursor=two&page=2");
    expect(router.state.location.state).toEqual({ page: 2 });
  });
});
