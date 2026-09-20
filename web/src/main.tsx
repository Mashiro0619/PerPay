import { CSPProvider } from "@base-ui/react/csp-provider";
import { TooltipProvider } from "./components/ui/tooltip";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, RouterProvider } from "react-router";

import { appRoutes, AppErrorBoundary } from "./App";
import { queryClient } from "./api/client";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("找不到管理界面挂载点。");

const basename = import.meta.env.BASE_URL;
// The backend also serves /admin; canonicalize it before the router matches /admin/.
if (window.location.pathname === basename.slice(0, -1)) {
  window.history.replaceState(
    window.history.state,
    "",
    basename + window.location.search + window.location.hash,
  );
}
const router = createBrowserRouter(appRoutes, { basename });

createRoot(root).render(
  <StrictMode>
    <CSPProvider disableStyleElements>
      <TooltipProvider>
        <AppErrorBoundary>
          <QueryClientProvider client={queryClient}>
            <RouterProvider router={router} />
          </QueryClientProvider>
        </AppErrorBoundary>
      </TooltipProvider>
    </CSPProvider>
  </StrictMode>,
);
