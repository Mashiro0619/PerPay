import { useWorkspace } from "@/workspace";
import { useQuery } from '@/lib/workspace-query';
import { useWorkspaceApi } from "@/workspace";
import { keepPreviousData } from '@tanstack/react-query';
import { useSearchParams } from "react-router";
import { result } from "@/api/client";
import { useSystemStatus } from "@/features/system-status";
export function useOverview() {
  const api = useWorkspaceApi();
  const [search, setSearch] = useSearchParams();
  const { clientId } = useWorkspace();
  const selected = Number(search.get("range"));
  const range: 7 | 30 | 90 = selected === 7 || selected === 90 ? selected : 30;
  const { status, unavailable, checking } = useSystemStatus();
  const analytics = useQuery({
    queryKey: ["analytics", range, clientId],
    queryFn: ({ signal }) =>
      result(api.getAdministratorSystemAnalytics({ query: { range, ...(clientId ? { api_client_id: clientId } : {}) }, signal })),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: ({ signal }) => result(api.getRuntimeSettings({ signal })),
    refetchOnWindowFocus: false,
  });
  const orders = useQuery({
    queryKey: ["orders", "recent", clientId],
    queryFn: ({ signal }) =>
      result(api.listAdministratorOrders({ query: { limit: 5, ...(clientId ? { api_client_id: clientId } : {}) }, signal })),
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    refetchOnMount: "always",
  });
  const work = useQuery({
    queryKey: ["work-items", "recent", clientId, "priority"],
    queryFn: ({ signal }) =>
      result(api.listAdministratorWorkItems({ query: { limit: 4, sort_by: "priority", sort_order: "desc", ...(clientId ? { api_client_id: clientId } : {}) }, signal })),
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    refetchOnMount: "always",
  });
  const workSummary = useQuery({
    queryKey: ["work-items", "summary", clientId],
    queryFn: ({ signal }) => result(api.getAdministratorWorkItemSummary({ query: { api_client_id: clientId! }, signal })),
    enabled: !!clientId,
    refetchInterval: 60_000,
  });
  return {
    clientId,
    range,
    analytics,
    settings,
    status,
    orders,
    work,
    workSummary,
    unavailable,
    checking,
    changeRange: (value: string) => {
      if (["7", "30", "90"].includes(value)) {
        const next = new URLSearchParams(search);
        next.set("range", value);
        setSearch(next, { replace: true });
      }
    },
  };
}
