import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { api, result } from "@/api/client";
import { useSystemStatus } from "@/features/system-status";
export function useOverview() {
  const [search, setSearch] = useSearchParams();
  const clientId = search.get("api_client_id");
  const selected = Number(search.get("range"));
  const range = selected === 7 || selected === 90 ? selected : 30;
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
  });
  const work = useQuery({
    queryKey: ["work-items", "recent", clientId],
    queryFn: ({ signal }) =>
      result(api.listAdministratorWorkItems({ query: { limit: 4, ...(clientId ? { api_client_id: clientId } : {}) }, signal })),
  });
  return {
    clientId,
    changeSite: (value: string) => {
      const next = new URLSearchParams(search);
      if (value) next.set("api_client_id", value); else next.delete("api_client_id");
      setSearch(next, { replace: true });
    },
    range,
    analytics,
    settings,
    status,
    orders,
    work,
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
