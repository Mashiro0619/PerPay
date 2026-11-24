import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { onlineManager, useMutation } from "@tanstack/react-query";
import { BookOpen, ChevronRight, ExternalLink, Eye, EyeOff, Globe, KeyRound, ShieldCheck } from "lucide-react";
import { api, ApiError, result, type RuntimeSettings } from "@/api/client";
import { useSession } from "@/auth";
import { useDirtyDraft } from "@/drafts";
import { isOperationResultUnknown, useOperationWait } from "@/hooks/use-operation-wait";
import { Link } from "@/navigation";
import { MIN_ADMIN_PASSWORD_CHARACTERS, validatePassword } from "@/lib/format";
import { useOverlayCloseGuard, useOverlayContext } from "@/lib/overlay-context";
import { AdministratorSessions } from "@/components/administrator-sessions";
import { PageHeading } from "@/components/page-heading";
import { SettingsSummary } from "@/components/settings-summary";
import { OverlayFormActions } from "@/components/overlay-actions";
import { ErrorNotice } from "@/components/request-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Field, FieldLabel, FieldLegend, FieldDescription, FieldError, FieldSet, FieldGroup } from "@/components/ui/field";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";

export function SecuritySettings({ settings }: { settings: RuntimeSettings }) {
  const linkId = useId();
  return <div className="flex min-w-0 flex-col gap-4" data-security-summary>
    <SettingsSummary
      title="管理员 IP 白名单"
      description="启用后仅允许列表中的 IP 或网段访问管理后台。"
      rows={[
        ["状态", <Badge variant={settings.admin_access.enabled ? "success" : "outline"}>{settings.admin_access.enabled ? "已启用" : "未启用"}</Badge>],
        ["允许的 IP / 网段", settings.admin_access.cidrs.length
          ? <ul aria-label="已保存的白名单规则" className="flex min-w-0 flex-col gap-1">{settings.admin_access.cidrs.map(cidr => <li key={cidr} className="wrap-anywhere font-mono text-xs">{cidr}</li>)}</ul>
          : <span className="text-muted-foreground">未配置规则</span>],
      ]}
      editTo="/settings/security/access"
    />
    <SettingsSummary
      title="登录密码"
      description="修改后所有设备都需重新登录。"
      rows={[["登录方式", "管理员密码"]]}
      editTo="/settings/security/password"
      editLabel="修改"
    />
    <Card size="sm">
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>密钥</CardTitle>
        <CardDescription>接口密钥按业务网站独立管理，支付宝应用密钥在对应收款账号中维护。</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="settings-link-list">
          <Link to="/sites" data-settings-link-row className="settings-link-row" aria-labelledby={linkId + "-sites-title"} aria-describedby={linkId + "-sites-desc"}>
            <span className="settings-link-icon" aria-hidden="true"><Globe className="size-4" /></span>
            <span className="settings-link-copy">
              <span id={linkId + "-sites-title"} className="settings-link-title">业务网站密钥与网站 ID</span>
              <span id={linkId + "-sites-desc"} className="settings-link-desc">查看或轮换各网站的原生 API、通知与易支付密钥</span>
            </span>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          </Link>
          <Link to="/settings/accounts" data-settings-link-row className="settings-link-row" aria-labelledby={linkId + "-accounts-title"} aria-describedby={linkId + "-accounts-desc"}>
            <span className="settings-link-icon" aria-hidden="true"><KeyRound className="size-4" /></span>
            <span className="settings-link-copy">
              <span id={linkId + "-accounts-title"} className="settings-link-title">在支付宝账号中管理应用密钥</span>
              <span id={linkId + "-accounts-desc"} className="settings-link-desc">生成、更换或核对开放平台应用公钥与支付宝公钥</span>
            </span>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          </Link>
          <a
            data-external-link
            data-settings-link-row
            href="https://github.com/Mashiro0619/PerPay/blob/main/USAGE.md"
            target="_blank"
            rel="noopener noreferrer"
            className="settings-link-row"
            aria-labelledby={linkId + "-docs-title"}
            aria-describedby={linkId + "-docs-desc"}
          >
            <span className="settings-link-icon" aria-hidden="true"><BookOpen className="size-4" /></span>
            <span className="settings-link-copy">
              <span id={linkId + "-docs-title"} className="settings-link-title">接入文档</span>
              <span id={linkId + "-docs-desc"} className="settings-link-desc">阅读原生 API 签名规范、回调验证与易支付接入指南</span>
            </span>
            <ExternalLink className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          </a>
        </div>
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
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [visible, setVisible] = useState(false);
  const [validation, setValidation] = useState<Error | null>(null);
  const [invalidField, setInvalidField] = useState<
    "current" | "password" | "confirmation" | null
  >(null);
  const currentField = useRef<HTMLInputElement>(null);
  const clearDraft = useDirtyDraft(current !== "" || password !== "" || confirmation !== "");
  const session = useSession();
  const wait = useOperationWait();
  const submitting = useRef(false);
  const change = useMutation({
    // A password change must never be queued for a later reconnection.
    networkMode: "always",
    retry: false,
    mutationFn: (input: { current: string; next: string }) => {
      if (!onlineManager.isOnline() || !navigator.onLine)
        throw new Error("网络已断开，密码未提交。恢复连接后请重新提交。");
      return wait(signal => result(
        api.changeAdministratorPassword({
          signal,
          body: { current_password: input.current, new_password: input.next },
        }),
      ));
    },
    onSuccess: () => {
      setCurrent("");
      setPassword("");
      setConfirmation("");
      setVisible(false);
      session.forget();
    },
    onSettled: () => {
      submitting.current = false;
    },
  });
  const resultUnknown = isOperationResultUnknown(change.error);
  // The server refused the current password; the session is still signed in.
  const wrongCurrent = change.error instanceof ApiError && change.error.code === "current_password_incorrect";
  const currentInvalid = wrongCurrent || invalidField === "current";
  const currentErrorMessage = wrongCurrent
    ? change.error?.message
    : invalidField === "current"
      ? validation?.message
      : null;
  useEffect(() => {
    if (wrongCurrent) currentField.current?.focus();
  }, [wrongCurrent]);
  useOverlayCloseGuard(() => submitting.current || change.isPending);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || change.isPending || resultUnknown) return;
    if (!current) {
      setInvalidField("current");
      setValidation(new Error("请输入当前密码。"));
      currentField.current?.focus();
      return;
    }
    const passwordCheck = validatePassword(password);
    const error =
      passwordCheck ??
      (password !== confirmation ? "两次输入的密码不一致。" : null);
    if (error) {
      const field = passwordCheck ? "password" : "confirmation";
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
    setVisible(false);
    change.mutate({ current, next: password });
  }
  function edited() {
    setValidation(null);
    setInvalidField(null);
    change.reset();
  }

  return (
    <form id={formId} noValidate onSubmit={submit} className="min-w-0">
      <Card>
        <CardHeader>
          {!overlay && <CardTitle role="heading" aria-level={2}>
            修改密码
          </CardTitle>}
          <CardDescription>修改后所有设备都需重新登录。</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldSet disabled={change.isPending || resultUnknown}>
            <FieldLegend className="sr-only">修改管理员密码</FieldLegend>
            <FieldGroup>
              <FieldGroup className="settings-fields">
                <Field data-invalid={currentInvalid}>
                  <FieldLabel htmlFor="current-password">当前密码</FieldLabel>
                  <InputGroup>
                    <InputGroupInput
                      ref={currentField}
                      id="current-password"
                      name="current-password"
                      type={visible ? "text" : "password"}
                      autoComplete="current-password"
                      autoCorrect="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      enterKeyHint="next"
                      required
                      value={current}
                      onChange={(event) => {
                        setCurrent(event.target.value);
                        edited();
                      }}
                      aria-invalid={currentInvalid}
                      aria-describedby={currentInvalid ? "current-password-error" : undefined}
                    />
                    <InputGroupAddon align="inline-end" className="pr-1.5">
                      <InputGroupButton
                        size="icon-xs"
                        type="button"
                        aria-label="显示密码"
                        aria-pressed={visible}
                        disabled={change.isPending || resultUnknown}
                        onClick={() => setVisible((value) => !value)}
                      >
                        {visible ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
                      </InputGroupButton>
                    </InputGroupAddon>
                  </InputGroup>
                  {currentErrorMessage && (
                    <FieldError id="current-password-error">
                      {currentErrorMessage}
                    </FieldError>
                  )}
                </Field>
                <Field data-invalid={invalidField === "password"}>
                  <FieldLabel htmlFor="new-password">新密码</FieldLabel>
                  <Input
                    id="new-password"
                    name="new-password"
                    type={visible ? "text" : "password"}
                    autoComplete="new-password"
                    autoCorrect="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    enterKeyHint="next"
                    required
                    value={password}
                    onBlur={() => {
                      if (!password) return;
                      const err = validatePassword(password);
                      if (err) {
                        setInvalidField("password");
                        setValidation(new Error(err));
                      }
                    }}
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
                    type={visible ? "text" : "password"}
                    autoComplete="new-password"
                    autoCorrect="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    enterKeyHint="done"
                    required
                    value={confirmation}
                    onBlur={() => {
                      if (!confirmation) return;
                      if (password && confirmation !== password) {
                        setInvalidField("confirmation");
                        setValidation(new Error("两次输入的密码不一致。"));
                      }
                    }}
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
              <ErrorNotice error={wrongCurrent ? null : change.error} />
            </FieldGroup>
          </FieldSet>
        </CardContent>
        <OverlayFormActions className="justify-end">
          {overlay && <Button type="button" variant="outline" disabled={change.isPending} onClick={() => overlay.requestClose()}>取消</Button>}
          {resultUnknown && <Button type="button" variant="outline" onClick={() => {
            setCurrent("");
            setPassword("");
            setConfirmation("");
            clearDraft();
            session.forget();
          }}>重新登录核对密码</Button>}
          <Button
            form={formId}
            type="submit"
            disabled={change.isPending || resultUnknown}
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
