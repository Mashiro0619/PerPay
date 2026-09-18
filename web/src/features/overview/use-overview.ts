import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { api, result } from "@/api/client";
import { useVisibleCheck } from "@/lib/use-visible-check";
export function useOverview() {
  const [search, setSearch] = useSearchParams();
  const selected = Number(search.get("range"));
  const range = selected === 7 || selected === 90 ? selected : 30;
  const view = useVisibleCheck();
  const analytics = useQuery({
    queryKey: ["analytics", range],
    queryFn: ({ signal }) =>
      result(api.getAdministratorSystemAnalytics({ query: { range }, signal })),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: ({ signal }) => result(api.getRuntimeSettings({ signal })),
    refetchOnWindowFocus: false,
  });
  const status = useQuery({
    queryKey: ["dashboard", "status", view.epoch],
    queryFn: ({ signal }) =>
      result(api.getAdministratorSystemStatus({ signal })),
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
  const orders = useQuery({
    queryKey: ["orders", "recent"],
    queryFn: ({ signal }) =>
      result(api.listAdministratorOrders({ query: { limit: 5 }, signal })),
  });
  const work = useQuery({
    queryKey: ["work-items", "recent"],
    queryFn: ({ signal }) =>
      result(api.listAdministratorWorkItems({ query: { limit: 4 }, signal })),
  });
  return {
    range,
    analytics,
    settings,
    status,
    orders,
    work,
    unavailable: !view.active || status.isError || status.isPaused,
    checking:
      !view.active ||
      status.isPending ||
      status.isError ||
      status.isPaused ||
      !status.isFetchedAfterMount,
    changeRange: (value: string) => {
      if (["7", "30", "90"].includes(value))
        setSearch({ range: value }, { replace: true });
    },
  };
}
