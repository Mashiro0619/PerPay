import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "react-router";
import { api, refreshOperationalData, result } from "@/api/client";
import { isManualScanStatus, manualScanActive, manualScanSource } from "@/lib/manual-ledger-scan";
import { useVisibleCheck } from "@/lib/use-visible-check";
import { presentSystemStatus } from "@/lib/system-status";
import { actualPageAddress } from "@/lib/navigation-selection";
function useStatusObservation() {
  const view = useVisibleCheck();
  const location = useLocation();
  const address = actualPageAddress(location);
  const observation = useRef({ address, epoch: view.epoch });
  const completedScan = useRef<string | null>(null);
  const status = useQuery({
    queryKey: ["status", "shared", view.epoch],
    queryFn: async ({ signal }) => {
      const response = await result(api.getAdministratorSystemStatus({ signal }));
      const data = response.data;
      const workItems = data?.work_items;
      const validWorkItems = workItems === null || (
        workItems && typeof workItems === "object" && !Array.isArray(workItems) &&
        [workItems.total, workItems.financial_exceptions, workItems.ledger_conflicts, workItems.notification_failures]
          .every(value => Number.isSafeInteger(value) && value >= 0) &&
        workItems.total === workItems.financial_exceptions + workItems.ledger_conflicts + workItems.notification_failures
      );
      if (!data || !validWorkItems || !["ready", "degraded", "not_ready"].includes(data.status) ||
          ![data.database, data.ledger, data.reconciliation, data.webhook, data.backup].every(value => value && typeof value === "object") ||
          ![data.configured, data.database?.ok, data.ledger?.collection_ready, data.reconciliation?.confirmation_ready].every(value => typeof value === "boolean") ||
          (data.ledger.manual_scan !== undefined && !isManualScanStatus(data.ledger.manual_scan))) {
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
    refetchInterval: query => view.active
      ? manualScanActive(query.state.data?.data.ledger.manual_scan?.request) || query.state.data?.data.alipay_accounts?.some(account => manualScanActive(account.manual_scan?.request)) ? 2000 : 30000
      : false,
    refetchIntervalInBackground: false,
  });
  const { refetch } = status;
  useEffect(() => {
    const previous = observation.current;
    observation.current = { address, epoch: view.epoch };
    // Runtime health is global. Navigation refreshes its current snapshot in
    // place; a visibility/network epoch still starts a fresh observation.
    if (view.active && previous.epoch === view.epoch && previous.address !== address) {
      void refetch();
    }
  }, [address, view.active, view.epoch, refetch]);
  useEffect(() => {
    const data = status.data?.data;
    if (!view.active || !status.isSuccess || !data) return;
    const requests = [data.ledger.manual_scan?.request, ...(data.alipay_accounts?.map(account => account.manual_scan?.request) ?? [])].filter(request => request && !manualScanActive(request));
    if (!requests.length) return;
    const completed = `${manualScanSource(data)}:${requests.map(request => `${request!.id}:${request!.state}:${request!.finished_at}`).join("|")}`;
    if (completedScan.current === completed) return;
    completedScan.current = completed;
    // The server's terminal state, rather than the POST's 202 response, proves
    // this attempt ended. Refresh ledger/summary views without polling status twice.
    void refreshOperationalData({ includeStatus: false });
  }, [status.data, status.isSuccess, view.active]);
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
