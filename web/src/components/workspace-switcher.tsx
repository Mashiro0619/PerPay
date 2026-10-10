import { siteChoiceLabel } from "@/lib/site-choice-label";
import { useId, useMemo } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { parsePath, useLocation } from "react-router";
import { Check, ChevronRight, Globe } from "lucide-react";
import { api, result } from "@/api/client";
import { useNavigationWorkspace } from "@/workspace";
import { Link } from "@/navigation";
import {
  actualPageAddress,
  isGlobalNavigationPage,
  switchWorkspaceHref,
} from "@/lib/navigation-selection";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { InlineEmpty } from "@/components/admin-empty";
import { ErrorNotice, Loading } from "@/components/request-state";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import {
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarMenuSub,
  SidebarMenuSubItem,
  SidebarMenuSubButton,
  useSidebar,
} from "@/components/ui/sidebar";

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

export function WorkspaceSwitcher({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const selection = useNavigationWorkspace();
  const { clientId, site } = selection;
  const location = useLocation();
  const { pathname } = location;
  const currentNameId = useId();
  const sidebar = useSidebar();
  const visible = sidebar.isMobile ? sidebar.openMobile : sidebar.open;
  const sites = useInfiniteQuery({
    queryKey: ["sites", "switcher"],
    enabled: open && visible,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      result(
        api.listSites({
          query: {
            limit: 30,
            ...(pageParam ? { after: pageParam } : {}),
          },
          signal,
        }),
      ),
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
  const currentHref = location.pathname + location.search + location.hash;
  const allSitesHref = switchWorkspaceHref(location, null);
  const metadataError = clientId && isGlobalNavigationPage(pathname) ? site?.error : null;

  return (
    <Collapsible
      open={open}
      onOpenChange={onOpenChange}
      render={<SidebarMenuItem />}
      className="group/collapsible"
    >
      <CollapsibleTrigger
        render={
          <SidebarMenuButton
            size="lg"
            tooltip="业务网站"
            aria-label={open ? "收起业务网站" : "展开业务网站"}
            aria-describedby={currentNameId}
          />
        }
      >
        <Globe />
        <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
          <span className="w-full truncate">业务网站</span>
          <span
            id={currentNameId}
            data-current-workspace
            className="w-full min-w-0 truncate text-xs text-muted-foreground"
            title={selectedName}
          >
            {selectedName}
          </span>
        </span>
        <ChevronRight aria-hidden="true" className="ml-auto transition-transform group-data-open/collapsible:rotate-90" />
      </CollapsibleTrigger>
      {metadataError && (
        <div className="px-2 py-1">
          <ErrorNotice
            error={metadataError}
            retry={() => void site?.refetch({ cancelRefetch: false })}
          />
        </div>
      )}
      <CollapsibleContent>
        <SidebarMenuSub aria-label="业务网站列表">
          <SidebarMenuSubItem>
            <SidebarMenuSubButton
              aria-current={!clientId ? "location" : undefined}
              render={
                <Link
                  global
                  preserveSelectedSite={false}
                  state={workspaceSwitchState(location, allSitesHref)}
                  to={allSitesHref ?? currentHref}
                  onClick={event => {
                    if (allSitesHref === null) event.preventDefault();
                  }}
                />
              }
            >
              <span className="min-w-0 flex-1 truncate">全部网站</span>
              {!clientId && <Check aria-hidden="true" />}
            </SidebarMenuSubButton>
          </SidebarMenuSubItem>
          {entries.map(value => {
            const label = siteChoiceLabel(value, entries);
            const selected = value.client_id === clientId;
            const href = switchWorkspaceHref(location, value.client_id);
            const hasStatus = value.configuration.accepting_orders === false ||
              value.configuration.notifications_enabled === false;
            const statusId = hasStatus
              ? `${currentNameId}-${encodeURIComponent(value.client_id)}-status`
              : undefined;
            return (
              <SidebarMenuSubItem key={value.client_id}>
                <SidebarMenuSubButton
                  aria-label={label}
                  aria-describedby={statusId}
                  aria-current={selected ? "location" : undefined}
                  className="h-auto min-h-7 py-1"
                  title={label}
                  render={
                    <Link
                      global
                      preserveSelectedSite={false}
                      state={workspaceSwitchState(location, href)}
                      to={href ?? currentHref}
                      onClick={event => {
                        if (href === null) event.preventDefault();
                      }}
                    />
                  }
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="min-w-0 truncate">{label}</span>
                    {hasStatus && (
                      <span id={statusId} className="flex flex-wrap gap-1">
                        {value.configuration.accepting_orders === false && (
                          <Badge variant="outline">暂停接单</Badge>
                        )}
                        {value.configuration.notifications_enabled === false && (
                          <Badge variant="outline">通知关闭</Badge>
                        )}
                      </span>
                    )}
                  </span>
                  {selected && <Check aria-hidden="true" />}
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
            );
          })}
          {sites.isPending && (
            <SidebarMenuSubItem className="p-2">
              <Loading label="正在加载网站…" />
            </SidebarMenuSubItem>
          )}
          {sites.error && (
            <SidebarMenuSubItem className="py-2">
              <ErrorNotice
                error={sites.error}
                retry={() => {
                  if (sites.isFetchNextPageError) void sites.fetchNextPage({ cancelRefetch: false });
                  else void sites.refetch({ cancelRefetch: false });
                }}
              />
            </SidebarMenuSubItem>
          )}
          {sites.data && !entries.length && (
            <SidebarMenuSubItem className="p-2">
              <InlineEmpty>暂无网站</InlineEmpty>
            </SidebarMenuSubItem>
          )}
          {sites.hasNextPage && !sites.isFetchNextPageError && (
            <SidebarMenuSubItem>
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start"
                disabled={sites.isFetching}
                onClick={() => void sites.fetchNextPage({ cancelRefetch: false })}
              >
                {sites.isFetchingNextPage ? "正在加载更多…" : sites.isFetching ? "正在刷新网站…" : "加载更多网站"}
              </Button>
            </SidebarMenuSubItem>
          )}
        </SidebarMenuSub>
      </CollapsibleContent>
    </Collapsible>
  );
}
