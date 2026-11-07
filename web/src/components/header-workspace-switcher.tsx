import { useEffect, useId, useState } from "react";
import { BellOff, Check, ChevronDown, CirclePause } from "lucide-react";
import { useWorkspaceSwitcher } from "@/hooks/use-workspace-switcher";
import { siteChoiceLabel } from "@/lib/site-choice-label";
import { cn } from "@/lib/utils";
import { Link } from "@/navigation";
import { RequestNoticeProvider, type RequestRetryRenderer } from "@/lib/request-notices";
import { RequestNoticeBanner } from "@/components/request-notice-banner";
import { ErrorNotice, Loading } from "@/components/request-state";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const renderMenuRetry: RequestRetryRenderer = (props) => <DropdownMenuGroup>
  <DropdownMenuItem closeOnClick={false} {...props} />
</DropdownMenuGroup>;

export function HeaderWorkspaceSwitcher({ name }: { name: string }) {
  const [open, setOpen] = useState(false);
  const statusId = useId();
  const { clientId, pending, location, sites, entries, switching, pendingName, linkProps, retrySites } = useWorkspaceSwitcher(open);
  useEffect(() => { setOpen(false); }, [location.key]);

  return <DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
    <DropdownMenuTrigger render={<Button variant="ghost" className="min-w-0 max-w-full px-1.5" aria-label={`切换网站，当前${name}`} title={name} />}>
      <span className="truncate">{name}</span>
      <ChevronDown data-icon="inline-end" aria-hidden="true" />
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" aria-label="切换网站" className="w-72 max-w-[calc(100vw-2rem)]">
      <RequestNoticeProvider>
        <RequestNoticeBanner showRuntimeLink={false} renderRetry={renderMenuRetry} />
        <span role="status" className="sr-only">{switching ? `正在切换到${pendingName}…` : ""}</span>
        <DropdownMenuGroup>
          <DropdownMenuLabel>切换网站</DropdownMenuLabel>
          <DropdownMenuItem closeOnClick={false} render={<Link {...linkProps(null)} />} aria-busy={switching && pending.selectedClientId === null}>
            {switching && pending.selectedClientId === null ? <Spinner aria-hidden="true" /> : <Check aria-hidden="true" className="invisible" />}
            <span className="min-w-0 flex-1 truncate">全部网站</span>
          </DropdownMenuItem>
          {entries.map(value => {
            const label = siteChoiceLabel(value, entries);
            const selected = value.client_id === clientId;
            const loading = switching && value.client_id === pending.selectedClientId;
            const paused = value.configuration.accepting_orders === false;
            const notificationsOff = value.configuration.notifications_enabled === false;
            const status = [paused && "暂停接单", notificationsOff && "通知关闭"].filter(Boolean).join(" · ");
            const descriptionId = status ? `${statusId}-${encodeURIComponent(value.client_id)}` : undefined;
            return <DropdownMenuItem key={value.client_id} closeOnClick={false}
              render={<Link {...linkProps(value.client_id)} />}
              label={label} aria-label={label} title={label}
              aria-current={selected ? "location" : undefined} aria-busy={loading} aria-describedby={descriptionId}>
              {loading ? <Spinner aria-hidden="true" /> : <Check aria-hidden="true" className={cn(!selected && "invisible")} />}
              <span className="min-w-0 flex-1 truncate">{label}</span>
              {paused && <CirclePause aria-hidden="true" />}
              {notificationsOff && <BellOff aria-hidden="true" />}
              {status && <span id={descriptionId} className="sr-only">{status}</span>}
            </DropdownMenuItem>;
          })}
          {sites.hasNextPage && !sites.isFetchNextPageError && <DropdownMenuItem
            closeOnClick={false} disabled={sites.isFetching}
            onClick={() => void sites.fetchNextPage({ cancelRefetch: false })}>
            {sites.isFetchingNextPage ? "正在加载更多…" : sites.isFetching ? "正在刷新网站…" : "加载更多网站"}
          </DropdownMenuItem>}
        </DropdownMenuGroup>
        {sites.isPending && <div className="p-2"><Loading label="正在加载网站…" /></div>}
        <ErrorNotice scope="page" error={sites.error} retry={retrySites} showDiagnostics={false} renderRetry={renderMenuRetry} />
      </RequestNoticeProvider>
    </DropdownMenuContent>
  </DropdownMenu>;
}
