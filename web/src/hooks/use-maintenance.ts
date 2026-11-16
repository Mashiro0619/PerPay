import { createContext, useContext, useEffect, useRef, useSyncExternalStore } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ApiError, getRestoreSessionHold, queryClient, setRestoreSessionHold, subscribeRestoreSessionHold } from "@/api/client";
import { getMaintenanceJob, getMaintenanceState, maintenanceJobRequiresLogin, maintenanceKey, startMaintenance, type MaintenanceJob, type MaintenanceRequest, type MaintenanceState } from "@/api/maintenance";
import { isOperationResultUnknown, useOperationWait } from "@/hooks/use-operation-wait";

export const MaintenanceContext = createContext<ReturnType<typeof useMaintenanceMonitor> | null>(null);

export function useMaintenanceJobs() {
  return useContext(MaintenanceContext)!;
}

type MonitoredMaintenanceState = MaintenanceState & { restoreJob?: MaintenanceJob };

function heldRestoreJob(state: MonitoredMaintenanceState | undefined, operationId: string | null) {
  if (operationId === null) return undefined;
  return state?.restoreJob?.id === operationId ? state.restoreJob
    : state?.latest?.id === operationId ? state.latest : undefined;
}

export function useMaintenanceMonitor() {
  const handled = useRef<string | null>(null);
  const restoreSessionHold = useSyncExternalStore(subscribeRestoreSessionHold, getRestoreSessionHold);
  const query = useQuery<MonitoredMaintenanceState>({
    queryKey: maintenanceKey,
    queryFn: async ({ signal }) => {
      const state = await getMaintenanceState(signal);
      const operationId = getRestoreSessionHold();
      if (operationId === null || state.latest?.id === operationId) return state;
      // Another tab may have started a newer task before this tab saw the restore result.
      return { ...state, restoreJob: await getMaintenanceJob(operationId, signal) };
    },
    enabled: current => {
      const latest = heldRestoreJob(current.state.data, restoreSessionHold) ?? current.state.data?.latest;
      return !maintenanceJobRequiresLogin(latest) || latest?.id !== restoreSessionHold;
    },
    staleTime: 0,
    refetchInterval: current => {
      const restore = heldRestoreJob(current.state.data, restoreSessionHold);
      return current.state.data?.active || restore?.status === "QUEUED" || restore?.status === "RUNNING" ? 1_000 : 15_000;
    },
    retry: false,
  });
  const currentActive = query.data?.active;
  const restore = heldRestoreJob(query.data, restoreSessionHold);
  const latest = restore ?? query.data?.latest;
  const requiresLogin = restoreSessionHold === latest?.id && maintenanceJobRequiresLogin(latest);
  const active = requiresLogin ? null : restore?.status === "QUEUED" || restore?.status === "RUNNING" ? restore : currentActive ?? null;
  useEffect(() => {
    if (currentActive?.kind === "RESTORE" && getRestoreSessionHold() === null) setRestoreSessionHold(currentActive.id);
  }, [currentActive, restoreSessionHold]);
  useEffect(() => {
    if (restoreSessionHold !== null && query.error instanceof ApiError && [401, 404].includes(query.error.status)) {
      window.dispatchEvent(new Event("perpay:session-expired"));
    }
  }, [query.error, restoreSessionHold]);
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
  return { ...query, active, latest: latest ?? null, requiresLogin,
    blocked: query.isPending || query.isError || query.isPaused || active !== null || restoreSessionHold !== null };
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
