import { createContext, useContext, useEffect, useRef, useSyncExternalStore } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ApiError, getRestoreSessionHold, queryClient, setRestoreSessionHold, subscribeRestoreSessionHold } from "@/api/client";
import { getMaintenanceJob, getMaintenanceState, maintenanceKey, startMaintenance, type MaintenanceJob, type MaintenanceRequest, type MaintenanceState } from "@/api/maintenance";
import { isOperationResultUnknown, useOperationWait } from "@/hooks/use-operation-wait";

export const MaintenanceContext = createContext<ReturnType<typeof useMaintenanceMonitor> | null>(null);

export function useMaintenanceJobs() {
  return useContext(MaintenanceContext)!;
}

export function useMaintenanceMonitor() {
  const handled = useRef<string | null>(null);
  const restoreSessionHold = useSyncExternalStore(subscribeRestoreSessionHold, getRestoreSessionHold);
  const query = useQuery({
    queryKey: maintenanceKey,
    queryFn: ({ signal }) => getMaintenanceState(signal),
    enabled: current => {
      const latest = current.state.data?.latest;
      return !latest?.result?.requires_login || latest.id !== restoreSessionHold;
    },
    staleTime: 0,
    refetchInterval: current => current.state.data?.active ? 1_000 : 15_000,
    retry: false,
  });
  const active = query.data?.active;
  const latest = query.data?.latest;
  useEffect(() => {
    if (active?.kind === "RESTORE" && getRestoreSessionHold() === null) setRestoreSessionHold(active.id);
  }, [active]);
  useEffect(() => {
    if (!latest || !["SUCCEEDED", "FAILED"].includes(latest.status) || handled.current === latest.id) return;
    handled.current = latest.id;
    if (getRestoreSessionHold() === latest.id && !latest.result?.requires_login) setRestoreSessionHold(null);
    const servicesWerePaused = latest.kind === "ARCHIVE" || latest.kind === "RESTORE";
    void queryClient.invalidateQueries({
      predicate: item => servicesWerePaused ? item.queryKey[0] !== maintenanceKey[0]
        : ["backup-files", "history-archives", "status"].includes(String(item.queryKey[0])),
      refetchType: restoreSessionHold === latest.id && latest.result?.requires_login ? "none" : "active",
    });
  }, [latest, restoreSessionHold]);
  return { ...query, active: query.data?.active ?? null, latest: query.data?.latest ?? null,
    requiresLogin: restoreSessionHold === latest?.id && !!latest?.result?.requires_login,
    blocked: query.isPending || query.isError || query.isPaused || query.data?.active != null || restoreSessionHold !== null };
}

export function useMaintenanceAction(onAccepted: (job: MaintenanceJob) => void) {
  const wait = useOperationWait();
  const command = useRef<MaintenanceRequest | null>(null);
  function accepted(job: MaintenanceJob) {
    if (job.kind === "RESTORE") {
      setRestoreSessionHold(["QUEUED", "RUNNING"].includes(job.status) || job.result?.requires_login ? job.id : null);
    }
    queryClient.setQueryData<MaintenanceState>(maintenanceKey, { active: ["QUEUED", "RUNNING"].includes(job.status) ? job : null, latest: job });
    void queryClient.invalidateQueries({ queryKey: maintenanceKey });
    onAccepted(job);
  }
  const mutation = useMutation({
    networkMode: "always", retry: false,
    mutationFn: (input: MaintenanceRequest) => wait(signal => startMaintenance(input, signal)),
    onSuccess: accepted,
  });
  const recovery = useMutation({
    networkMode: "always", retry: false,
    mutationFn: () => wait(signal => getMaintenanceJob(command.current!.operation_id, signal)),
    onSuccess: job => { mutation.reset(); accepted(job); },
    onError: error => { if (error instanceof ApiError && error.status === 404) mutation.reset(); },
  });
  const unknown = isOperationResultUnknown(mutation.error);
  return {
    pending: mutation.isPending,
    error: recovery.error ?? (unknown ? null : mutation.error),
    unknown,
    refreshing: recovery.isPending,
    submit(input: MaintenanceRequest) { command.current = input; recovery.reset(); mutation.mutate(input); },
    refresh() { recovery.mutate(); },
    reset() { if (isOperationResultUnknown(mutation.error)) return false; command.current = null; recovery.reset(); mutation.reset(); return true; },
  };
}
