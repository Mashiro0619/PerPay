import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, RouterProvider } from "react-router";

import { appRoutes, AppErrorBoundary } from "./App";
import { queryClient } from "./api/client";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("找不到管理界面挂载点。");

const router = createBrowserRouter(appRoutes, { basename: "/admin" });

createRoot(root).render(<StrictMode><AppErrorBoundary><QueryClientProvider client={queryClient}>
  <RouterProvider router={router} />
</QueryClientProvider></AppErrorBoundary></StrictMode>);
