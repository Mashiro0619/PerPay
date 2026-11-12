import { useId, useRef, useState, type FormEvent } from "react";
import { onlineManager, useMutation } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { api, result, type RuntimeSettings } from "@/api/client";
import { useSession } from "@/auth";
import { useDirtyDraft } from "@/drafts";
import { Link } from "@/navigation";
import { MIN_ADMIN_PASSWORD_CHARACTERS, validatePassword } from "@/lib/format";
import { useOverlayCloseGuard, useOverlayContext } from "@/lib/overlay-context";
import { AdministratorSessions } from "@/components/administrator-sessions";
import { PageHeading } from "@/components/page-heading";
import { SettingsSummary } from "@/components/settings-summary";
import { OverlayFormActions } from "@/components/overlay-actions";
import { ErrorNotice } from "@/components/request-state";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel, FieldDescription, FieldError, FieldSet, FieldGroup } from "@/components/ui/field";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";

export function SecuritySettings({ settings }: { settings: RuntimeSettings }) {
  return <div className="flex min-w-0 flex-col gap-4" data-security-summary>
    <SettingsSummary title="管理员 IP 白名单" rows={[
      ["状态", settings.admin_access.enabled ? "已启用" : "未启用"],
      ["允许的 IP / 网段", settings.admin_access.cidrs.length
        ? <ul aria-label="已保存的白名单规则" className="flex min-w-0 flex-col gap-1">{settings.admin_access.cidrs.map(cidr => <li key={cidr} className="wrap-anywhere font-mono">{cidr}</li>)}</ul>
        : "未配置规则"],
    ]} editTo="/settings/security/access" />
    <SettingsSummary title="登录密码" description="修改后所有设备都需重新登录。" rows={[["登录方式", "管理员密码"]]} editTo="/settings/security/password" editLabel="修改" />
    <Card>
      <CardHeader><CardTitle role="heading" aria-level={2}>密钥</CardTitle></CardHeader>
      <CardContent className="flex flex-col items-start gap-2">
        <Link to="/sites">业务网站密钥与客户端 ID</Link>
        <Link to="/settings/accounts">在支付宝账号中管理应用密钥</Link>
        <a data-external-link href="https://github.com/Mashiro0619/PerPay/blob/main/USAGE.md" target="_blank" rel="noopener noreferrer" className="text-sm underline underline-offset-4">接入文档</a>
      </CardContent>
    </Card>
    <AdministratorSessions />
  </div>;
}

export function PasswordEditorPage() {
  return <><PageHeading title="修改密码" /><PasswordForm /></>;
}

function PasswordForm() {
  const overlay = useOverlayContext();
  const formId = useId();
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [validation, setValidation] = useState<Error | null>(null);
  const [invalidField, setInvalidField] = useState<
    "password" | "confirmation" | null
  >(null);
  useDirtyDraft(password !== "" || confirmation !== "");
  const session = useSession();
  const submitting = useRef(false);
  const change = useMutation({
    // A password change must never be queued for a later reconnection.
    networkMode: "always",
    retry: false,
    mutationFn: (newPassword: string) => {
      if (!onlineManager.isOnline() || !navigator.onLine)
        throw new Error("网络已断开，密码未提交。恢复连接后请重新提交。");
      return result(
        api.changeAdministratorPassword({
          body: { new_password: newPassword },
        }),
      );
    },
    onSuccess: () => {
      setPassword("");
      setConfirmation("");
      session.forget();
    },
    onSettled: () => {
      submitting.current = false;
    },
  });
  useOverlayCloseGuard(() => submitting.current || change.isPending);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || change.isPending) return;
    const error =
      validatePassword(password) ??
      (password !== confirmation ? "两次输入的密码不一致。" : null);
    if (error) {
      const field = validatePassword(password) ? "password" : "confirmation";
      setInvalidField(field);
      setValidation(new Error(error));
      (
        event.currentTarget.elements.namedItem(
          field === "password" ? "new-password" : "confirm-password",
        ) as HTMLInputElement
      )?.focus();
      return;
    }
    submitting.current = true;
    setInvalidField(null);
    setValidation(null);
    change.mutate(password);
  }
  function edited() {
    setValidation(null);
    setInvalidField(null);
    change.reset();
  }

  return (
    <form id={formId} onSubmit={submit} className="min-w-0">
      <Card>
        <CardHeader>
          {!overlay && <CardTitle role="heading" aria-level={2}>
            修改密码
          </CardTitle>}
          <CardDescription>修改后所有设备都需重新登录。</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldSet disabled={change.isPending}>
            <FieldGroup>
              <FieldGroup className="settings-fields">
                <Field data-invalid={invalidField === "password"}>
                  <FieldLabel htmlFor="new-password">新密码</FieldLabel>
                  <Input
                    id="new-password"
                    name="new-password"
                    type="password"
                    autoComplete="new-password"
                    required
                    value={password}
                    onChange={(event) => {
                      setPassword(event.target.value);
                      edited();
                    }}
                    aria-invalid={invalidField === "password"}
                    aria-describedby={
                      invalidField === "password"
                        ? "password-hint new-password-error"
                        : "password-hint"
                    }
                  />
                  <FieldDescription id="password-hint">
                    至少 {MIN_ADMIN_PASSWORD_CHARACTERS} 个字符。
                  </FieldDescription>
                  {invalidField === "password" && (
                    <FieldError id="new-password-error">
                      {validation?.message}
                    </FieldError>
                  )}
                </Field>
                <Field data-invalid={invalidField === "confirmation"}>
                  <FieldLabel htmlFor="confirm-password">
                    再次输入新密码
                  </FieldLabel>
                  <Input
                    id="confirm-password"
                    name="confirm-password"
                    type="password"
                    autoComplete="new-password"
                    required
                    value={confirmation}
                    onChange={(event) => {
                      setConfirmation(event.target.value);
                      edited();
                    }}
                    aria-invalid={invalidField === "confirmation"}
                    aria-describedby={
                      invalidField === "confirmation"
                        ? "confirm-password-error"
                        : undefined
                    }
                  />
                  {invalidField === "confirmation" && (
                    <FieldError id="confirm-password-error">
                      {validation?.message}
                    </FieldError>
                  )}
                </Field>
              </FieldGroup>
              <ErrorNotice error={change.error} />
            </FieldGroup>
          </FieldSet>
        </CardContent>
        <OverlayFormActions className="justify-end">
          {overlay && <Button type="button" variant="outline" disabled={change.isPending} onClick={() => overlay.requestClose()}>取消</Button>}
          <Button
            form={formId}
            type="submit"
            disabled={!password || !confirmation || change.isPending}
          >
            {change.isPending ? (
              <Spinner aria-hidden="true" data-icon="inline-start" />
            ) : (
              <ShieldCheck data-icon="inline-start" />
            )}
            修改并重新登录
          </Button>
        </OverlayFormActions>
      </Card>
    </form>
  );
}
