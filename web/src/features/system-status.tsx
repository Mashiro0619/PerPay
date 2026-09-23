import { createContext, useContext, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "react-router";
import { api, result } from "@/api/client";
import { useVisibleCheck } from "@/lib/use-visible-check";
import { presentSystemStatus } from "@/lib/system-status";
function useStatusObservation() {
  const view = useVisibleCheck();
  const location = useLocation();
  const status = useQuery({
    queryKey: ["status", "shared", location.key, view.epoch],
    queryFn: async ({ signal }) => {
      const response = await result(api.getAdministratorSystemStatus({ signal }));
      const data = response.data;
      if (!data || !["ready", "degraded", "not_ready"].includes(data.status) ||
          ![data.database, data.ledger, data.reconciliation, data.webhook, data.backup].every(value => value && typeof value === "object") ||
          ![data.configured, data.database?.ok, data.ledger?.collection_ready, data.reconciliation?.confirmation_ready].every(value => typeof value === "boolean")) {
        throw new Error("运行状态响应不完整，请重试。");
      }
      return response;
    },
    enabled: view.active,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: view.active ? 30000 : false,
    refetchIntervalInBackground: false,
  });
  const unavailable = !view.active || status.isError || status.isPaused;
  const checking =
    unavailable || status.isPending || !status.isFetchedAfterMount;
  const presentation =
    !checking && status.data ? presentSystemStatus(status.data.data) : null;
  return { status, unavailable, checking, presentation };
}
const SystemStatusContext = createContext<ReturnType<
  typeof useStatusObservation
> | null>(null);
function StatusProvider({ children }: { children: ReactNode }) {
  const value = useStatusObservation();
  return <SystemStatusContext value={value}>{children}</SystemStatusContext>;
}
/** One mounted owner supplies both navigation and pages; nested boundaries do not add observers/timers. */
export function SystemStatusBoundary({ children }: { children: ReactNode }) {
  const shared = useContext(SystemStatusContext);
  return shared ? children : <StatusProvider>{children}</StatusProvider>;
}
export function useOptionalSystemStatus() {
  return useContext(SystemStatusContext);
}
export function useSystemStatus() {
  const value = useOptionalSystemStatus();
  if (!value) throw new Error("SystemStatusBoundary is required");
  return value;
}
