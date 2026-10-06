import { render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { describe, it, expect, vi } from "vitest";
import { DataTable } from "../src/components/data-table";
import { WorkspaceProvider } from "../src/workspace";
import { queryClient } from "../src/api/client";
import { order, json } from "./fixtures";
describe("quiet website identity presentation", () => {
  it.each([false, true])(
    "shows the website name only in global lists (site scope: %s)",
    async (scoped) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          json({
            data: {
              client_id: "site_a",
              deleted_at: null,
              configuration: { name: "网站 A" },
            },
          }),
        ),
      );
      render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter
            initialEntries={[scoped ? "/sites/site_a/orders" : "/orders"]}
          >
            <WorkspaceProvider>
              <DataTable
                data={[
                  { ...order, api_client_id: "site_a", site_name: "网站 A" },
                ]}
              />
            </WorkspaceProvider>
          </MemoryRouter>
        </QueryClientProvider>,
      );
      if (scoped) {
        await waitFor(() => expect(fetch).toHaveBeenCalled());
        expect(
          screen.queryByRole("link", { name: "网站 A · site_a" }),
        ).not.toBeInTheDocument();
      } else
        expect(
          screen.getByRole("link", { name: "网站 A · site_a" }),
        ).toHaveTextContent("网站 A");
      expect(
        screen.queryByText("site_a", { exact: true }),
      ).not.toBeInTheDocument();
    },
  );
});
