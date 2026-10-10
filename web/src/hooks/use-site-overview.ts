import { useEffect } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { api, result, type ListSiteOverviewResponse } from "@/api/client";

function hasMixedPeriods(pages: readonly ListSiteOverviewResponse[]) {
  const first = pages[0]?.period;
  return pages.some((page) => page.period.from !== first?.from || page.period.to !== first?.to);
}

export function useSiteOverview(range: 7 | 30 | 90, pageSize: 10 | 30 = 10) {
  const queryClient = useQueryClient();
  const query = useInfiniteQuery({
    queryKey: ["site-overview", range, pageSize],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      result(api.listSiteOverview({
        query: { range, limit: pageSize, ...(pageParam ? { cursor: pageParam } : {}) },
        signal,
      })),
    getNextPageParam: (page) => page.page.next_cursor ?? undefined,
    staleTime: 0,
    refetchInterval: 60_000,
  });
  const pages = query.data?.pages ?? [];
  const sites = pages.flatMap((page) => page.data);
  const mixedPeriods = hasMixedPeriods(pages);
  const pending = query.isPending || mixedPeriods;
  const latest = mixedPeriods ? undefined : pages.at(-1);

  useEffect(() => {
    const queryKey = ["site-overview", range, pageSize];
    // Never paint pages from two Shanghai date windows, including during a background refetch.
    // The cache identity check also avoids resetting twice when effects are replayed.
    if (mixedPeriods && queryClient.getQueryData(queryKey) === query.data) {
      void queryClient.resetQueries({ queryKey, exact: true });
    }
  }, [mixedPeriods, query.data, queryClient, range, pageSize]);

  const refresh = () => { void query.refetch({ cancelRefetch: false }); };
  const loadMore = () => { void query.fetchNextPage({ cancelRefetch: false }); };
  return { query, sites, latest, pending, refresh, loadMore };
}
