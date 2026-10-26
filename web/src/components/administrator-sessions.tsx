import { Fragment, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Laptop, LogOut, Monitor, MoreHorizontal, Smartphone, Tablet } from "lucide-react";
import { api, result, type AdminLoginSession } from "@/api/client";
import { useSession } from "@/auth";
import { useDraftGuard } from "@/drafts";
import { dateTime } from "@/lib/format";
import { sessionActivity, sessionDevice } from "@/lib/session-device";
import { useSuccessToast } from "@/components/Feedback";
import { ListDateTime } from "@/components/list-primitives";
import { RefreshButton } from "@/components/refresh-button";
import { ErrorNotice, Loading } from "@/components/request-state";
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
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemSeparator, ItemTitle } from "@/components/ui/item";
import { Spinner } from "@/components/ui/spinner";

export const administratorSessionsKey = ["administrator-sessions"] as const;

type SessionAction =
  | { kind: "logout" | "others" | "all" }
  | { kind: "single"; session: AdminLoginSession };

function confirmation(action: SessionAction) {
  switch (action.kind) {
    case "logout": return { title: "退出当前会话？", description: "当前设备需要重新登录。", label: "退出登录" };
    case "others": return { title: "退出其他会话？", description: "其他登录会话将立即失效，当前会话保持登录。", label: "退出其他会话" };
    case "all": return { title: "注销全部会话？", description: "包括当前设备，所有登录会话都需要重新登录。", label: "注销全部会话" };
    case "single": return {
      title: "撤销此会话？",
      description: `${sessionDevice(action.session.user_agent).label}，登录 IP：${action.session.ip_address ?? "未知"}。此会话将立即失效，需要重新登录。`,
      label: "撤销",
    };
  }
}

export function AdministratorSessions() {
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
    mutationFn: async (nextAction: SessionAction) => {
      switch (nextAction.kind) {
        case "logout": await result(api.logoutAdministratorSession({ body: {} })); return null;
        case "all": await result(api.revokeAllAdministratorSessions({ body: {} })); return null;
        case "single": await result(api.revokeAdministratorSession({ path: { session_id: nextAction.session.session_id }, body: {} })); return null;
        case "others": return (await result(api.revokeOtherAdministratorSessions({ body: {} }))).data.revoked_sessions;
      }
    },
    onSuccess: async (count, completed) => {
      if (completed.kind === "logout" || completed.kind === "all") {
        session.forget();
        return;
      }
      await queryClient.invalidateQueries({ queryKey: administratorSessionsKey });
      setAction(null);
      success(completed.kind === "single" ? "已撤销该登录会话" : count ? `已退出 ${count} 个其他会话` : "没有其他登录会话");
    },
    onSettled: () => { sending.current = false; },
  });
  const rows = [...(sessions.data?.data ?? [])].sort((left, right) =>
    Number(right.is_current) - Number(left.is_current) ||
    new Date(right.last_seen_at).getTime() - new Date(left.last_seen_at).getTime() ||
    left.session_id.localeCompare(right.session_id),
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
  return (
    <>
      <Card className="administrator-sessions-card" data-login-sessions>
        <CardHeader className="administrator-sessions-header">
          <CardTitle ref={heading} tabIndex={-1} role="heading" aria-level={2}>登录会话</CardTitle>
          <CardDescription>查看并退出当前正在使用此账号的登录会话。</CardDescription>
          <CardAction className="administrator-sessions-actions flex items-center gap-1">
            <RefreshButton size="icon-sm" disabled={operation.isPending} busy={sessions.isFetching} onClick={() => { void sessions.refetch(); }} />
            <Button variant="outline" size="sm" disabled={!hasOthers || operation.isPending} onClick={event => open({ kind: "others" }, event.currentTarget)}>
              <LogOut data-icon="inline-start" />退出其他会话
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button ref={menuTrigger} variant="ghost" size="icon-sm" aria-label="会话操作" disabled={operation.isPending} />}>
                <MoreHorizontal />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuGroup>
                  <DropdownMenuItem variant="destructive" onClick={() => open({ kind: "all" }, menuTrigger.current)}>注销全部会话</DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </CardAction>
        </CardHeader>
        <CardContent className="flex min-w-0 flex-col gap-3">
          <ErrorNotice error={sessions.error} retry={() => { void sessions.refetch(); }} />
          {sessions.isPending ? <Loading label="正在读取登录会话…" /> : sessions.data && (
            rows.length ? (
              <ItemGroup className="record-list" aria-label="登录会话列表">
                {rows.map((row, index) => {
                  const device = sessionDevice(row.user_agent);
                  const DeviceIcon = device.kind === "phone" ? Smartphone : device.kind === "tablet" ? Tablet : device.kind === "computer" ? Laptop : Monitor;
                  return (
                    <Fragment key={row.session_id}>
                      {index > 0 && <ItemSeparator />}
                      <Item className="administrator-session-row record-list-row" role="listitem" size="sm" data-session-id={row.session_id}>
                        <ItemMedia variant="icon" className="administrator-session-icon" aria-hidden="true"><DeviceIcon /></ItemMedia>
                        <ItemContent className="administrator-session-content min-w-0">
                          <div className="flex min-w-0 flex-wrap items-center gap-2">
                            <ItemTitle>{device.label}</ItemTitle>
                            {row.is_current && <Badge variant="secondary">当前</Badge>}
                          </div>
                          <ItemDescription className="administrator-session-meta record-list-meta">
                            <span>登录 IP：{row.ip_address ?? "未知"}</span>
                          </ItemDescription>
                          <ItemDescription className="administrator-session-meta record-list-meta">
                            <span>最近活跃于 <time dateTime={row.last_seen_at} title={dateTime(row.last_seen_at) + "（北京时间）"}>{sessionActivity(row.last_seen_at)}</time></span>
                            <span>到期时间 <ListDateTime value={row.expires_at} inline /></span>
                          </ItemDescription>
                        </ItemContent>
                        <ItemActions className="administrator-session-action ml-auto">
                          <Button variant={row.is_current ? "outline" : "ghost"} size="sm" disabled={operation.isPending}
                            aria-label={row.is_current ? "退出登录" : `撤销 ${device.label} 会话`}
                            onClick={event => open(row.is_current ? { kind: "logout" } : { kind: "single", session: row }, event.currentTarget)}>
                            {row.is_current ? "退出登录" : "撤销"}
                          </Button>
                        </ItemActions>
                      </Item>
                    </Fragment>
                  );
                })}
              </ItemGroup>
            ) : (
              <Empty><EmptyHeader><EmptyTitle>没有可显示的登录会话</EmptyTitle><EmptyDescription>刷新后查看当前有效的登录会话。</EmptyDescription></EmptyHeader></Empty>
            )
          )}
        </CardContent>
      </Card>
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
