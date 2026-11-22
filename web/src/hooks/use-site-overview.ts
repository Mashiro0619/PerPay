import { useEffect } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import type { ListSiteOverviewResponse } from "@/api/client";
import { siteOverviewQueryOptions, type SiteOverviewSort } from "@/api/workspace-queries";

function hasMixedPeriods(pages: readonly ListSiteOverviewResponse[]) {
  const first = pages[0]?.period;
  return pages.some((page) => page.period.from !== first?.from || page.period.to !== first?.to);
}

export function useSiteOverview(
  range: 7 | 30 | 90,
  pageSize: 10 | 30 = 10,
  sortBy: SiteOverviewSort = "client_id",
) {
  const queryClient = useQueryClient();
  const options = siteOverviewQueryOptions(range, pageSize, sortBy);
  const query = useInfiniteQuery(options);
  const pages = query.data?.pages ?? [];
  const sites = pages.flatMap((page) => page.data);
  const mixedPeriods = hasMixedPeriods(pages);
  const pending = query.isPending || mixedPeriods;
  const latest = mixedPeriods ? undefined : pages.at(-1);

  useEffect(() => {
    const queryKey = sortBy === "client_id"
      ? ["site-overview", range, pageSize]
      : ["site-overview", range, pageSize, sortBy];
    // Never paint pages from two Shanghai date windows, including during a background refetch.
    // The cache identity check also avoids resetting twice when effects are replayed.
    if (mixedPeriods && queryClient.getQueryData(queryKey) === query.data) {
      void queryClient.resetQueries({ queryKey, exact: true });
    }
  }, [mixedPeriods, query.data, queryClient, range, pageSize, sortBy]);

  const refresh = () => { void query.refetch({ cancelRefetch: false }); };
  const loadMore = () => { void query.fetchNextPage({ cancelRefetch: false }); };
  return { query, sites, latest, pending, refresh, loadMore };
}
