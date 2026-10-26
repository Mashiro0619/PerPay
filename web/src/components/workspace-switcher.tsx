import { siteChoiceLabel } from "@/lib/site-choice-label";
import { useEffect, useId, useMemo, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { parsePath, useLocation } from "react-router";
import { BellOff, Check, ChevronRight, CirclePause, Globe } from "lucide-react";
import { api, result } from "@/api/client";
import { useNavigationWorkspace, useWorkspaceNavigation } from "@/workspace";
import { Link } from "@/navigation";
import {
  actualPageAddress,
  isGlobalNavigationPage,
  switchWorkspaceHref,
} from "@/lib/navigation-selection";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
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
  const pending = useWorkspaceNavigation();
  const { clientId, site } = selection;
  const location = useLocation();
  const { pathname } = location;
  const currentNameId = useId();
  const sidebar = useSidebar();
  const icon = !sidebar.isMobile && sidebar.state === "collapsed";
  const [popoverOpen, setPopoverOpen] = useState(false);
  useEffect(() => { setPopoverOpen(false); }, [location.key, icon]);
  const visible = sidebar.isMobile ? sidebar.openMobile : sidebar.open;
  const sites = useInfiniteQuery({
    queryKey: ["sites", "switcher"],
    enabled: icon ? popoverOpen : open && visible,
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
  const switching = pending.switching && pending.selectedClientId !== clientId;
  const pendingEntry = entries.find(value => value.client_id === pending.selectedClientId);
  const pendingName = pendingEntry ? siteChoiceLabel(pendingEntry, entries) : pending.selectedClientId ?? "全部网站";
  const currentHref = location.pathname + location.search + location.hash;
  const allSitesHref = switchWorkspaceHref(location, null);
  const metadataError = clientId && isGlobalNavigationPage(pathname) ? site?.error : null;

  const menu = (
        <SidebarMenuSub className="mx-0 translate-x-0 border-0 px-0 py-1" aria-label="业务网站列表">
          <SidebarMenuSubItem>
            <SidebarMenuSubButton
              isActive={!clientId}
              aria-busy={switching && pending.selectedClientId === null}
              aria-current={!clientId ? "location" : undefined}
              className="workspace-site-choice h-8 translate-x-0"
              render={
                <Link
                  global
                  preserveSelectedSite={false}
                  state={workspaceSwitchState(location, allSitesHref)}
                  to={allSitesHref ?? currentHref}
                  onClick={event => {
                    if (allSitesHref === null && !pending.switching) event.preventDefault();
                  }}
                />
              }
            >
              {switching && pending.selectedClientId === null
                ? <Spinner aria-hidden="true" />
                : <Check aria-hidden="true" className={cn(clientId && "invisible")} />}
              <span className="min-w-0 flex-1 truncate">全部网站</span>
            </SidebarMenuSubButton>
          </SidebarMenuSubItem>
          {entries.map(value => {
            const label = siteChoiceLabel(value, entries);
            const selected = value.client_id === clientId;
            const loading = switching && value.client_id === pending.selectedClientId;
            const href = switchWorkspaceHref(location, value.client_id);
            const paused = value.configuration.accepting_orders === false;
            const notificationsOff = value.configuration.notifications_enabled === false;
            const status = [paused && "暂停接单", notificationsOff && "通知关闭"].filter(Boolean).join(" · ");
            const hasStatus = Boolean(status);
            const statusId = hasStatus
              ? `${currentNameId}-${encodeURIComponent(value.client_id)}-status`
              : undefined;
            const choice = (
                <SidebarMenuSubButton
                  isActive={selected}
                  aria-busy={loading}
                  aria-label={label}
                  aria-describedby={statusId}
                  aria-current={selected ? "location" : undefined}
                  className="workspace-site-choice h-8 translate-x-0"
                  render={
                    <Link
                      global
                      preserveSelectedSite={false}
                      state={workspaceSwitchState(location, href)}
                      to={href ?? currentHref}
                      onClick={event => {
                        if (href === null && !pending.switching) event.preventDefault();
                      }}
                    />
                  }
                >
                  {loading
                    ? <Spinner aria-hidden="true" />
                    : <Check aria-hidden="true" className={cn(!selected && "invisible")} />}
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                  {hasStatus && (
                    <span aria-hidden="true" className="flex shrink-0 items-center gap-1.5 text-muted-foreground [&>svg]:size-3.5">
                      {paused && <CirclePause />}
                      {notificationsOff && <BellOff />}
                    </span>
                  )}
                </SidebarMenuSubButton>
            );
            return (
              <SidebarMenuSubItem key={value.client_id}>
                {hasStatus ? (
                  <Tooltip>
                    <TooltipTrigger render={choice} />
                    <TooltipContent role="tooltip" side="right" align="start">
                      <span className="flex min-w-0 flex-col gap-1">
                        <span className="break-words">{label}</span>
                        <span>{status}</span>
                      </span>
                    </TooltipContent>
                  </Tooltip>
                ) : choice}
                {hasStatus && <span id={statusId} className="sr-only">{status}</span>}
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
  );
  const metadata = <>
      <span role="status" className="sr-only">{switching ? `正在切换到${pendingName}…` : ""}</span>
{metadataError && (
        <div className="px-2 py-1">
          <ErrorNotice
            error={metadataError}
            retry={() => void site?.refetch({ cancelRefetch: false })}
          />
        </div>
      )}
  </>;
  if (icon) return <SidebarMenuItem>
    <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
      <PopoverTrigger render={<SidebarMenuButton tooltip={`业务网站 · ${selectedName}`} aria-label={`切换业务网站，当前${selectedName}`} />}>
        <Globe />
        <span className="sr-only">业务网站</span>
      </PopoverTrigger>
      <PopoverContent side="right" align="start" className="max-h-[min(32rem,calc(100dvh-2rem))] overflow-y-auto">
        <PopoverTitle>业务网站</PopoverTitle>
        <p className="text-xs text-muted-foreground">当前：{selectedName}</p>
        {metadata}
        {menu}
      </PopoverContent>
    </Popover>
  </SidebarMenuItem>;
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
            tooltip="业务网站"
            className="pointer-coarse:min-h-10"
            aria-label={open ? "收起业务网站" : "展开业务网站"}
            aria-describedby={currentNameId}
          />
        }
      >
        <Globe />
        <span className="shrink-0">业务网站</span>
        <span
          id={currentNameId}
          data-current-workspace
          className="min-w-0 flex-1 truncate text-right text-xs text-muted-foreground"
          title={selectedName}
        >
          {selectedName}
        </span>
        <ChevronRight aria-hidden="true" className="transition-transform group-data-open/collapsible:rotate-90" />
      </CollapsibleTrigger>
      {metadata}
      <CollapsibleContent>
        {menu}
      </CollapsibleContent>
    </Collapsible>
  );
}
