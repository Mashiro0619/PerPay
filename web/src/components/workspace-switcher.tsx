import { siteChoiceLabel } from "@/lib/site-choice-label";
import { useEffect, useId, useState } from "react";
import { BellOff, Check, ChevronRight, CirclePause, Globe } from "lucide-react";
import { useWorkspaceSwitcher } from "@/hooks/use-workspace-switcher";
import { Link } from "@/navigation";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { InlineEmpty } from "@/components/admin-empty";
import { ErrorNotice, Loading } from "@/components/request-state";
import { RequestNoticeBanner } from "@/components/request-notice-banner";
import { RequestNoticeProvider } from "@/lib/request-notices";
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

export function WorkspaceSwitcher({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const currentNameId = useId();
  const sidebar = useSidebar();
  const icon = !sidebar.isMobile && sidebar.state === "collapsed";
  const [popoverOpen, setPopoverOpen] = useState(false);
  const visible = sidebar.isMobile ? sidebar.openMobile : sidebar.open;
  const { clientId, site, pending, location, sites, entries, selectedName, switching, pendingName, metadataError, linkProps, retrySites } =
    useWorkspaceSwitcher(icon ? popoverOpen : open && visible);
  useEffect(() => { setPopoverOpen(false); }, [location.key, icon]);

  const menu = (
        <SidebarMenuSub className="mx-0 translate-x-0 border-0 px-0 py-1" aria-label="业务网站列表">
          <SidebarMenuSubItem>
            <SidebarMenuSubButton
              isActive={!clientId}
              aria-busy={switching && pending.selectedClientId === null}
              aria-current={!clientId ? "location" : undefined}
              className="workspace-site-choice h-8 translate-x-0"
              render={<Link {...linkProps(null)} />}
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
                  render={<Link {...linkProps(value.client_id)} />}
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
            <SidebarMenuSubItem className="py-2 empty:hidden">
              <ErrorNotice
                scope="page"
                error={sites.error}
                retry={retrySites}
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
        <div className="px-2 py-1 empty:hidden">
          <ErrorNotice
            scope="page"
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
        <RequestNoticeProvider>
          <RequestNoticeBanner showRuntimeLink={false} />
          {metadata}
          {menu}
        </RequestNoticeProvider>
      </PopoverContent>
    </Popover>
  </SidebarMenuItem>;
  const content = (
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
            aria-label={`业务网站 ${selectedName}，${open ? "收起" : "展开"}`}
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
      {sidebar.isMobile && <div className="px-2 py-1 empty:hidden">
        <RequestNoticeBanner showRuntimeLink={false} />
      </div>}
      {metadata}
      <CollapsibleContent>
        {menu}
      </CollapsibleContent>
    </Collapsible>
  );
  // Overlay recovery stays in the active focus scope, with one notice for its reads.
  return sidebar.isMobile ? <RequestNoticeProvider>{content}</RequestNoticeProvider> : content;
}
