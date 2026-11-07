import { useMemo, type MouseEvent } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { parsePath, useLocation } from "react-router";
import { api, result } from "@/api/client";
import { useNavigationWorkspace, useWorkspaceNavigation } from "@/workspace";
import { actualPageAddress, isGlobalNavigationPage, switchWorkspaceHref } from "@/lib/navigation-selection";
import { siteChoiceLabel } from "@/lib/site-choice-label";

type SiteMenuEntry = {
  client_id: string;
  configuration: {
    name: string;
    accepting_orders?: boolean;
    notifications_enabled?: boolean;
  };
};

function workspaceSwitchState(location: ReturnType<typeof useLocation>, href: string | null) {
  if (href === null) return location.state;
  const destination = parsePath(href);
  const samePage = actualPageAddress(location) === actualPageAddress({
    pathname: destination.pathname ?? location.pathname,
    search: destination.search ?? "",
  });
  return samePage ? location.state : null;
}

export function useWorkspaceSwitcher(enabled: boolean) {
  const { clientId, site } = useNavigationWorkspace();
  const pending = useWorkspaceNavigation();
  const location = useLocation();
  const sites = useInfiniteQuery({
    queryKey: ["sites", "switcher"],
    enabled,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => result(api.listSites({
      query: { limit: 30, ...(pageParam ? { after: pageParam } : {}) },
      signal,
    })),
    getNextPageParam: (page) => page.page.next_cursor ?? undefined,
  });
  const currentSite = site?.data?.data;
  const entries = useMemo(() => {
    const loaded = new Map<string, SiteMenuEntry>();
    for (const page of sites.data?.pages ?? []) {
      for (const value of page.data) {
        if (!loaded.has(value.client_id)) loaded.set(value.client_id, value);
      }
    }
    if (clientId && currentSite && loaded.has(clientId)) loaded.set(clientId, currentSite);
    const values = [...loaded.values()];
    if (clientId && !loaded.has(clientId)) {
      values.unshift(currentSite ?? { client_id: clientId, configuration: { name: clientId } });
    }
    return values;
  }, [sites.data, clientId, currentSite]);
  const selectedEntry = entries.find(value => value.client_id === clientId);
  const selectedName = selectedEntry ? siteChoiceLabel(selectedEntry, entries) : "全部网站";
  const switching = pending.switching && pending.selectedClientId !== clientId;
  const pendingEntry = entries.find(value => value.client_id === pending.selectedClientId);
  const pendingName = pendingEntry ? siteChoiceLabel(pendingEntry, entries) : pending.selectedClientId ?? "全部网站";
  const metadataError = clientId && isGlobalNavigationPage(location.pathname) ? site?.error : null;

  function linkProps(nextClientId: string | null) {
    const href = switchWorkspaceHref(location, nextClientId);
    return {
      global: true,
      preserveSelectedSite: false,
      state: workspaceSwitchState(location, href),
      to: href ?? location.pathname + location.search + location.hash,
      onClick(event: MouseEvent<HTMLAnchorElement>) {
        if (href === null && !pending.switching) event.preventDefault();
      },
    };
  }

  function retrySites() {
    if (sites.isFetchNextPageError) void sites.fetchNextPage({ cancelRefetch: false });
    else void sites.refetch({ cancelRefetch: false });
  }

  return { clientId, site, pending, location, sites, entries, selectedName, switching, pendingName, metadataError, linkProps, retrySites };
}
