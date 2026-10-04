import { useState } from "react";
import { onlineManager, useMutation, useQuery } from "@tanstack/react-query";
import { api, result, ApiError, type RuntimeSettings } from "@/api/client";
import { useDirtyDraft } from "@/drafts";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import {
  FieldGroup,
  Field,
  FieldLabel,
  FieldDescription,
  FieldError,
} from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { ErrorNotice } from "@/components/request-state";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/admin-dialog";

export function AdminAccessSettings({
  settings,
  onSaved,
}: {
  settings: RuntimeSettings;
  onSaved: (settings: RuntimeSettings, message?: string) => void;
}) {
  const initial = settings.admin_access;
  const [draft, setDraft] = useState<{
    enabled: boolean;
    text: string;
    revision: number;
  } | null>(null);
  const enabled = draft?.enabled ?? initial.enabled;
  const text = draft?.text ?? initial.cidrs.join("\n");
  const dirty =
    enabled !== initial.enabled || text !== initial.cidrs.join("\n");
  useDirtyDraft(dirty);
  const [confirm, setConfirm] = useState(false);
  const source = useQuery({
    queryKey: ["admin-access-source"],
    queryFn: () => result(api.getAdminAccessSettings()),
  });
  const currentIp = source.data?.data.current_ip;
  const save = useMutation({
    networkMode: "always",
    retry: false,
    mutationFn: async () => {
      if (!onlineManager.isOnline() || !navigator.onLine)
        throw new Error("网络已断开，白名单未提交。恢复连接后请重新提交。");
      return result(
        api.updateAdminAccessSettings({
          body: {
            revision: draft?.revision ?? settings.revision,
            enabled,
            cidrs:
              text.trim() === ""
                ? []
                : text.split(/\r?\n/).map((value) => value.trim()),
          },
        }),
      );
    },
    onSuccess: (response) => {
      setDraft(null);
      onSaved(response.data, "管理员 IP 白名单已保存");
      void source.refetch();
    },
    onSettled: () => setConfirm(false),
  });
  const fieldError =
    save.error instanceof ApiError ? save.error.fields.cidrs : undefined;
  return (
    <Card>
      <CardHeader>
        <CardTitle>管理员 IP 白名单</CardTitle>
        <CardDescription>
          可选的额外访问限制，不替代密码登录，不影响收银台和商户支付接口。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <FieldGroup>
          <Field orientation="horizontal">
            <Switch
              id="admin-access-enabled"
              checked={enabled}
              disabled={save.isPending}
              onCheckedChange={(value) =>
                setDraft({
                  revision: draft?.revision ?? settings.revision,
                  enabled: value,
                  text,
                })
              }
            />
            <FieldLabel htmlFor="admin-access-enabled">
              启用 IP 白名单
            </FieldLabel>
          </Field>
          <Field data-invalid={Boolean(fieldError)}>
            <FieldLabel htmlFor="admin-access-cidrs">
              允许的 IP / 网段
            </FieldLabel>
            <Textarea
              id="admin-access-cidrs"
              value={text}
              disabled={save.isPending}
              onChange={(event) =>
                setDraft({
                  revision: draft?.revision ?? settings.revision,
                  enabled,
                  text: event.target.value,
                })
              }
              aria-invalid={Boolean(fieldError)}
              aria-describedby="admin-access-help"
              placeholder={"192.0.2.10\n2001:db8::/64"}
            />
            <FieldDescription id="admin-access-help">
              每行一个 IPv4、IPv6 或 CIDR，最多 100 条、8 KiB，不允许
              /0。启用时必须允许当前 IP；关闭后保留已保存规则。
            </FieldDescription>
            {fieldError && <FieldError>{fieldError}</FieldError>}
          </Field>
          <Field>
            <FieldDescription>
              当前识别 IP：
              {currentIp ?? (source.isPending ? "正在读取…" : "无法识别")}
            </FieldDescription>
            <Button
              type="button"
              variant="outline"
              disabled={!currentIp || save.isPending}
              onClick={() => {
                if (currentIp && !text.split(/\r?\n/).includes(currentIp))
                  setDraft({
                    revision: draft?.revision ?? settings.revision,
                    enabled,
                    text: [text.trim(), currentIp].filter(Boolean).join("\n"),
                  });
              }}
            >
              加入当前 IP
            </Button>
          </Field>
          <FieldDescription>
            IP 变化可能导致无法登录，可通过服务器恢复访问。{" "}
            <a
              href="https://github.com/Mashiro0619/PerPay/blob/main/docs/maintenance.md#管理员-ip-白名单与离线恢复"
              target="_blank"
              rel="noopener noreferrer"
            >
              查看恢复方法
            </a>
          </FieldDescription>
          <ErrorNotice
            error={source.error}
            retry={() => void source.refetch()}
          />
          <ErrorNotice error={save.error} />
        </FieldGroup>
      </CardContent>
      <CardFooter>
        <Button
          disabled={!dirty || save.isPending}
          onClick={() => setConfirm(true)}
        >
          保存白名单
        </Button>
      </CardFooter>
      <Dialog
        open={confirm}
        onOpenChange={(value) => {
          if (!save.isPending) setConfirm(value);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认保存访问规则？</DialogTitle>
            <DialogDescription>
              保存后立即生效。启用时新规则必须允许当前客户端
              IP；其他不匹配的来源即使已经登录也会被拒绝。请确认你有服务器离线恢复权限。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={save.isPending}
              onClick={() => setConfirm(false)}
            >
              取消
            </Button>
            <Button disabled={save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? "保存中…" : "确认保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
