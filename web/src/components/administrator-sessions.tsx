import { useRef, useState } from "react";
import { useParams } from "react-router";
import { onlineManager, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LogOut, MoreHorizontal } from "lucide-react";
import { Link } from "@/navigation";
import { BusinessTable, type BusinessColumn } from "@/components/business-table";
import { OverlaySummary } from "@/components/overlay-actions";
import { OverlayRecordList } from "@/components/overlay-record-list";
import { useOverlayCloseGuard } from "@/lib/overlay-context";
import { api, result, type AdminLoginSession } from "@/api/client";
import { useSession } from "@/auth";
import { useDraftGuard } from "@/drafts";
import { dateTime, naturalCollator } from "@/lib/format";
import { sessionActivity, sessionDevice } from "@/lib/session-device";
import { useSuccessToast } from "@/components/Feedback";
import { RefreshButton } from "@/components/refresh-button";
import { ErrorNotice, Loading } from "@/components/request-state";
import { PageHeading } from "@/components/page-heading";
import { PageHeaderActions } from "@/components/page-header-actions";
import { DetailPage } from "@/components/detail/DetailPrimitives";
import { ActionBar } from "@/components/record/ActionBar";
import { Disclosure } from "@/components/record/Disclosure";
import { FieldList } from "@/components/record/FieldList";
import { RecordSummary } from "@/components/record/RecordSummary";
import { RecordTime } from "@/components/record/Timeline";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  DialogBody,
} from "@/components/admin-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";

export const administratorSessionsKey = ["administrator-sessions"] as const;

export function AdministratorSessionDetailOverlay() {
  const { sessionId } = useParams();
  return <AdministratorSessions detailSessionId={sessionId} />;
}

type SessionAction =
  | { kind: "logout" | "others" | "all" }
  | { kind: "single"; session: AdminLoginSession };

function confirmation(action: SessionAction) {
  switch (action.kind) {
    case "logout": return { title: "退出当前登录？", description: "当前设备需要重新登录。", label: "退出当前登录" };
    case "others": return { title: "退出其他设备？", description: "其他设备将立即下线，当前设备保持登录。", label: "退出其他设备" };
    case "all": return { title: "退出全部设备？", description: "包括当前设备，所有已登录设备都需要重新登录。", label: "退出全部设备" };
    case "single": return {
      title: "强制下线此设备？",
      description: `${sessionDevice(action.session.user_agent).label}，登录 IP：${action.session.ip_address ?? "未记录"}。此设备将立即下线，需要重新登录。`,
      label: "强制下线",
    };
  }
}

/** When the session was last used: what tells active sessions apart at a glance. */
function conclusion(session: AdminLoginSession) {
  return <>最近活跃：<RecordTime value={session.last_seen_at} /></>;
}

export function AdministratorSessions({ detailSessionId }: { detailSessionId?: string } = {}) {
  const queryClient = useQueryClient();
  const session = useSession();
  const { requestDiscard } = useDraftGuard();
  const success = useSuccessToast();
  const [action, setAction] = useState<SessionAction | null>(null);
  const origin = useRef<HTMLButtonElement | null>(null);
  const heading = useRef<HTMLDivElement | null>(null);
  const menuTrigger = useRef<HTMLButtonElement | null>(null);
  const sending = useRef(false);
  const sessions = useQuery({
    queryKey: administratorSessionsKey,
    queryFn: ({ signal }) => result(api.listAdministratorSessions({ signal })),
    staleTime: 15_000,
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
  });
  const operation = useMutation({
    networkMode: "always",
    retry: false,
    mutationFn: async (nextAction: SessionAction) => {
      if (!onlineManager.isOnline() || !navigator.onLine)
        throw new Error("网络已断开，会话操作未提交。恢复连接后请重新确认。");
      switch (nextAction.kind) {
        case "logout": await result(api.logoutAdministratorSession({ body: {} })); return null;
        case "all": await result(api.revokeAllAdministratorSessions({ body: {} })); return null;
        case "single": await result(api.revokeAdministratorSession({ path: { session_id: nextAction.session.session_id }, body: {} })); return null;
        case "others": return (await result(api.revokeOtherAdministratorSessions({ body: {} }))).data.revoked_sessions;
      }
    },
    onSuccess: (count, completed) => {
      if (completed.kind === "logout" || completed.kind === "all") {
        session.forget();
        return;
      }
      void queryClient.invalidateQueries({ queryKey: administratorSessionsKey });
      setAction(null);
      success(completed.kind === "single" ? "已强制下线该设备" : count ? `已退出 ${count} 台其他设备` : "没有其他已登录设备");
    },
    onSettled: () => { sending.current = false; },
  });
  useOverlayCloseGuard(() => sending.current || operation.isPending);
  const rows = (sessions.data?.data ?? []).toSorted((left, right) =>
    Number(right.is_current) - Number(left.is_current) ||
    new Date(right.last_seen_at).getTime() - new Date(left.last_seen_at).getTime() ||
    naturalCollator.compare(left.session_id, right.session_id),
  );
  const hasOthers = rows.some(row => !row.is_current);
  const details = action ? confirmation(action) : null;
  function open(nextAction: SessionAction, trigger: HTMLButtonElement | null) {
    origin.current = trigger;
    const show = () => {
      operation.reset();
      setAction(nextAction);
    };
    if (nextAction.kind === "logout" || nextAction.kind === "all") requestDiscard(show);
    else show();
  }
  function restoreFocus() {
    return origin.current?.isConnected && !origin.current.disabled ? origin.current : heading.current;
  }
  const selected = rows.find(row => row.session_id === detailSessionId);
  const columns: BusinessColumn<AdminLoginSession>[] = [
    { id: "device", label: "设备", layout: "identity", hideable: false, cell: row => <div className="flex min-w-0 flex-wrap items-center gap-2">
      <Link data-row-link to={"/settings/security/sessions/" + encodeURIComponent(row.session_id)}>{sessionDevice(row.user_agent).label}</Link>
      {row.is_current && <Badge variant="secondary">当前</Badge>}
    </div> },
    { id: "ip", label: "登录 IP", summaryDefault: true, cell: row => row.ip_address ?? "未记录" },
    { id: "activity", label: "最近活跃", layout: "datetime", summaryDefault: true, cell: row => <time dateTime={row.last_seen_at} title={dateTime(row.last_seen_at) + "（北京时间）"}>{sessionActivity(row.last_seen_at)}</time> },
    { id: "actions", label: "操作", layout: "actions", hideable: false, cell: row => <Button variant={row.is_current ? "outline" : "ghost"} size="sm" disabled={operation.isPending}
      aria-label={row.is_current ? "退出当前登录" : `强制下线 ${sessionDevice(row.user_agent).label}`}
      onClick={event => open(row.is_current ? { kind: "logout" } : { kind: "single", session: row }, event.currentTarget)}>{row.is_current ? "退出当前登录" : "强制下线"}</Button> },
  ];
  return (
    <>
      {detailSessionId ? <DetailPage>
        {/* Until a session is found, the overlay shows its route title as the heading. */}
        {selected && <PageHeading title={sessionDevice(selected.user_agent).label} />}
        <PageHeaderActions><RefreshButton disabled={operation.isPending || sessions.isFetching} busy={sessions.isFetching} onClick={() => { void sessions.refetch(); }} /></PageHeaderActions>
        <ErrorNotice error={sessions.error} retry={() => { void sessions.refetch(); }} />
        {sessions.isPending ? <Loading label="正在读取登录会话…" /> : selected ? <>
          <OverlaySummary>
            <RecordSummary label="会话概况" status={<Badge variant={selected.is_current ? "secondary" : "outline"}>{selected.is_current ? "当前设备" : "其他设备"}</Badge>} meta={[conclusion(selected)]} />
          </OverlaySummary>
          <div className="flex min-w-0 flex-col gap-3">
            <FieldList items={[
              { label: "登录 IP", value: selected.ip_address ?? "未记录", kind: selected.ip_address ? "id" : undefined, copy: selected.ip_address ?? undefined },
              { label: "登录方式", value: "密码" },
              { label: "到期时间", value: <RecordTime value={selected.expires_at} />, kind: "time" },
              !selected.user_agent && { label: "设备信息", value: "未记录" },
            ]} />
            {/* The title already names the browser and system; the raw User-Agent is kept for checking. */}
            {selected.user_agent && <Disclosure label="设备信息">
              <p className="font-mono text-xs leading-5 text-muted-foreground wrap-anywhere">{selected.user_agent}</p>
            </Disclosure>}
          </div>
        </> : !sessions.error && <Empty><EmptyHeader><EmptyTitle>此会话已结束</EmptyTitle><EmptyDescription>已失效的会话不再出现在有效会话列表中。</EmptyDescription></EmptyHeader></Empty>}
        {selected && <ActionBar menuLabel="更多操作，会话操作" primary={{
          label: selected.is_current ? "退出当前登录" : "强制下线",
          danger: true,
          disabled: operation.isPending,
          onSelect: trigger => open(selected.is_current ? { kind: "logout" } : { kind: "single", session: selected }, trigger),
        }} />}
      </DetailPage> : <Card className="administrator-sessions-card" data-login-sessions>
        <CardHeader className="administrator-sessions-header">
          <CardTitle ref={heading} tabIndex={-1} role="heading" aria-level={2}>登录会话</CardTitle>
          <CardDescription>查看并退出当前正在使用此账号的登录会话。</CardDescription>
          <CardAction className="administrator-sessions-actions flex items-center gap-1">
            <RefreshButton size="icon-sm" disabled={operation.isPending} busy={sessions.isFetching} onClick={() => { void sessions.refetch(); }} />
            <Button variant="outline" size="sm" disabled={!hasOthers || operation.isPending} onClick={event => open({ kind: "others" }, event.currentTarget)}>
              <LogOut data-icon="inline-start" />退出其他设备
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button ref={menuTrigger} variant="ghost" size="icon-sm" aria-label="会话操作" disabled={operation.isPending} />}>
                <MoreHorizontal />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuGroup>
                  <DropdownMenuItem variant="destructive" onClick={() => open({ kind: "all" }, menuTrigger.current)}>退出全部设备</DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </CardAction>
        </CardHeader>
        <CardContent className="flex min-w-0 flex-col gap-3">
          <ErrorNotice scope="page" error={sessions.error} retry={() => { void sessions.refetch(); }} />
          {sessions.isPending ? <Loading label="正在读取登录会话…" /> : sessions.data && (
            rows.length ? (
              <OverlayRecordList items={rows.map(row => "/settings/security/sessions/" + encodeURIComponent(row.session_id))}>
                <BusinessTable id="administrator-sessions" items={rows} columns={columns} rowId={row => row.session_id} density="compact" columnsMenu={false} aria-label="登录会话列表" />
              </OverlayRecordList>
            ) : (
              <Empty><EmptyHeader><EmptyTitle>没有可显示的登录会话</EmptyTitle><EmptyDescription>刷新后查看当前有效的登录会话。</EmptyDescription></EmptyHeader></Empty>
            )
          )}
        </CardContent>
      </Card>}
      <AlertDialog open={action !== null} onOpenChange={(open, event) => {
        if (!open && sending.current) event.cancel();
        else if (!open) setAction(null);
      }}>
        <AlertDialogContent finalFocus={restoreFocus}>
          <AlertDialogHeader><AlertDialogTitle>{details?.title}</AlertDialogTitle></AlertDialogHeader>
          <DialogBody>
            <AlertDialogDescription>{details?.description}</AlertDialogDescription>
            <ErrorNotice error={operation.error} />
          </DialogBody>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={operation.isPending}>取消</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={operation.isPending} onClick={() => {
              if (!action || sending.current) return;
              sending.current = true;
              operation.mutate(action);
            }}>
              {operation.isPending && <Spinner aria-hidden="true" data-icon="inline-start" />}
              {details?.label}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
