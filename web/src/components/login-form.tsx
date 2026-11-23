import { useSystemName } from "@/branding";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useLocation, useNavigate } from "react-router";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  ExternalLink,
  Eye,
  EyeOff,
  HelpCircle,
  Lock,
} from "lucide-react";
import { api, ApiError, result } from "@/api/client";
import { previewInstanceChanged } from "@/demo-mode";
import { MIN_ADMIN_PASSWORD_CHARACTERS, validatePassword } from "@/lib/format";
import { cn } from "@/lib/utils";
import { AuthShell } from "@/components/auth-shell";
import { ErrorNotice } from "@/components/request-state";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Checkbox } from "@/components/ui/checkbox";
import { Spinner } from "@/components/ui/spinner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

export function LoginForm({ onLogin }: { onLogin: () => void }) {
  const systemName = useSystemName();
  const location = useLocation();
  const navigate = useNavigate();
  const [initialized, setInitialized] = useState<boolean | null>(() => {
    const value = document
      .querySelector('meta[name="perpay-initialized"]')
      ?.getAttribute("content");
    return value === "true" ? true : value === "false" ? false : null;
  });
  const setup = initialized === false;
  const [setupTokenRequired] = useState(
    () =>
      document
        .querySelector('meta[name="perpay-setup-token-required"]')
        ?.getAttribute("content") !== "false",
  );
  const title =
    initialized === null
      ? "无法确认系统状态"
      : setup
        ? `初始化 ${systemName}`
        : "登录管理后台";
  const description = setup ? "先创建管理员，再登录配置收款。" : null;

  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const tokenInput = useRef<HTMLInputElement | null>(null);
  const recoveryRef = useRef<HTMLDivElement | null>(null);
  const recoveryTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [remember, setRemember] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);
  const [error, setError] = useState<unknown>(null);
  const [invalidField, setInvalidField] = useState<
    "token" | "password" | "confirmation" | null
  >(null);
  const [configured, setConfigured] = useState(false);
  const [alreadyInitialized, setAlreadyInitialized] = useState(false);

  const passwordError =
    !setup && error instanceof ApiError && error.code === "invalid_credentials"
      ? "管理员密码不正确，请检查后重试。"
      : null;
  const passwordInvalid = invalidField === "password" || passwordError !== null;
  const tokenError =
    setup &&
    setupTokenRequired &&
    error instanceof ApiError &&
    error.code === "setup_token_invalid"
      ? "初始化令牌无效或已失效，请从服务器最新启动日志重新获取。"
      : null;
  const tokenInvalid = invalidField === "token" || tokenError !== null;
  const setupLengthReady =
    setup && Array.from(password).length >= MIN_ADMIN_PASSWORD_CHARACTERS;
  const setupConfirmationReady =
    setup && confirmation.length > 0 && confirmation === password;

  useEffect(() => {
    if (tokenError && !pending) tokenInput.current?.focus();
  }, [tokenError, pending]);

  useEffect(() => {
    document.title = `${title} · ${systemName}`;
    setError(null);
    setInvalidField(null);
    setPassword("");
    setConfirmation("");
    setSetupToken("");
    setRemember(false);
    setCapsLock(false);
    setRecoveryOpen(false);
  }, [title, systemName]);

  useEffect(() => {
    if (!recoveryOpen) return;
    function onPointerDown(event: PointerEvent) {
      if (
        recoveryRef.current &&
        event.target instanceof Node &&
        !recoveryRef.current.contains(event.target)
      ) {
        setRecoveryOpen(false);
      }
    }
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        setRecoveryOpen(false);
        recoveryTriggerRef.current?.focus();
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [recoveryOpen]);

  useEffect(() => {
    if (initialized === true && location.pathname === "/setup")
      navigate("/login", { replace: true });
  }, [initialized, location.pathname, navigate]);

  function handleModifierKeys(event: KeyboardEvent<HTMLInputElement>) {
    if (typeof event.getModifierState === "function") {
      setCapsLock(event.getModifierState("CapsLock"));
    }
  }

  function markInitialized() {
    document
      .querySelector('meta[name="perpay-initialized"]')
      ?.setAttribute("content", "true");
    setInitialized(true);
    setPassword("");
    setConfirmation("");
    setSetupToken("");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || initialized === null) return;
    if (visible) setVisible(false);
    setError(null);
    setInvalidField(null);
    if (setup) {
      if (setupTokenRequired && !setupToken.trim()) {
        setInvalidField("token");
        setError(new Error("请输入服务器启动日志中的初始化令牌。"));
        tokenInput.current?.focus();
        return;
      }
      const validation = validatePassword(password);
      if (validation || confirmation !== password) {
        const field = validation ? "password" : "confirmation";
        setInvalidField(field);
        setError(new Error(validation ?? "两次输入的密码不一致。"));
        (
          event.currentTarget.elements.namedItem(
            field === "password" ? "password" : "password-confirmation",
          ) as HTMLInputElement
        )?.focus();
        return;
      }
    }
    submitting.current = true;
    setPending(true);
    try {
      if (setup) {
        await result(
          api.setupAdministrator({
            body: setupTokenRequired
              ? { password, setup_token: setupToken.trim() }
              : { password },
          }),
        );
        markInitialized();
        setConfigured(true);
        navigate("/login", { replace: true });
      } else {
        let loginResponse: Response | undefined;
        await result(
          api
            .loginAdministrator({
              body: remember ? { password, remember_me: true } : { password },
            })
            .then((reply) => {
              loginResponse = reply.response;
              return reply;
            }),
        );
        setPassword("");
        if (
          previewInstanceChanged(loginResponse) ||
          ["/login", "/setup"].includes(location.pathname)
        ) {
          await navigate("/", {
            replace: true,
            state: null,
            viewTransition: false,
          });
        }
        onLogin();
      }
    } catch (failure) {
      if (
        setup &&
        failure instanceof ApiError &&
        failure.code === "identity_already_initialized"
      ) {
        markInitialized();
        setAlreadyInitialized(true);
        navigate("/login", { replace: true });
      } else {
        setError(failure);
      }
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  return (
    <AuthShell adminAuth>
      <Card className="auth-card min-w-0">
        <CardHeader className="auth-card-header">
          <CardTitle className="auth-card-title">
            <h1 className="w-full">{title}</h1>
          </CardTitle>
          {description && (
            <CardDescription className="auth-card-description">
              {description}
            </CardDescription>
          )}
        </CardHeader>
        <CardContent className="flex min-w-0 flex-col gap-4">
          {initialized === null ? (
            <ErrorNotice
              error={new Error("无法读取初始化状态，请检查服务后重试。")}
              retry={() => window.location.reload()}
            />
          ) : (
            <form
              className="min-w-0"
              noValidate={setup}
              onSubmit={(event) => {
                void submit(event);
              }}
            >
              <FieldGroup className="gap-4 sm:gap-5">
                {(configured || alreadyInitialized) && !setup && (
                  <Alert className="auth-status-alert">
                    <CheckCircle2 aria-hidden="true" />
                    <AlertDescription>
                      {configured
                        ? "管理员已创建"
                        : "系统已初始化，请用现有管理员密码登录。"}
                    </AlertDescription>
                  </Alert>
                )}
                {setup && setupTokenRequired && (
                  <Field data-invalid={tokenInvalid} data-disabled={pending}>
                    <FieldLabel htmlFor="setup-token">
                      一次性初始化令牌
                    </FieldLabel>
                    <Input
                      ref={tokenInput}
                      id="setup-token"
                      name="setup-token"
                      className="auth-input"
                      type="password"
                      autoComplete="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      maxLength={256}
                      required
                      value={setupToken}
                      disabled={pending}
                      aria-invalid={tokenInvalid}
                      aria-describedby={
                        tokenInvalid ? "setup-token-error" : "setup-token-hint"
                      }
                      onChange={(event) => {
                        setSetupToken(event.target.value);
                        setError(null);
                        setInvalidField(null);
                      }}
                    />
                    <FieldDescription
                      id="setup-token-hint"
                      className="wrap-anywhere"
                    >
                      从服务器启动日志获取；Docker 部署执行{" "}
                      <code>docker compose logs app</code>，复制最新的{" "}
                      <code>setup_token</code>。未初始化时重启服务会更换令牌。
                    </FieldDescription>
                    {tokenInvalid && (
                      <FieldError id="setup-token-error">
                        {tokenError ??
                          (error instanceof Error ? error.message : null)}
                      </FieldError>
                    )}
                  </Field>
                )}
                <Field data-invalid={passwordInvalid} data-disabled={pending}>
                  <div className="auth-label-row">
                    <FieldLabel htmlFor="password">
                      {setup ? "设置管理员密码" : "管理员密码"}
                    </FieldLabel>
                    {setupLengthReady && (
                      <span className="auth-ready-indicator" aria-hidden="true">
                        <Check className="size-3.5" />
                        <span>已满足长度</span>
                      </span>
                    )}
                  </div>
                  <InputGroup className="auth-input-group">
                    <InputGroupAddon align="inline-start" className="pl-3">
                      <Lock aria-hidden="true" />
                    </InputGroupAddon>
                    <InputGroupInput
                      id="password"
                      name="password"
                      className="h-full"
                      type={visible ? "text" : "password"}
                      autoComplete={setup ? "new-password" : "current-password"}
                      required
                      value={password}
                      disabled={pending}
                      aria-invalid={passwordInvalid}
                      aria-describedby={
                        passwordInvalid
                          ? "password-error"
                          : setup
                            ? "password-hint"
                            : undefined
                      }
                      onKeyDown={handleModifierKeys}
                      onKeyUp={handleModifierKeys}
                      onBlur={() => setCapsLock(false)}
                      onChange={(event) => {
                        setPassword(event.target.value);
                        setError(null);
                        setInvalidField(null);
                      }}
                    />
                    <InputGroupAddon align="inline-end" className="pr-1.5">
                      <InputGroupButton
                        size="icon-xs"
                        aria-label={visible ? "隐藏密码" : "显示密码"}
                        type="button"
                        disabled={pending}
                        onClick={() => setVisible(!visible)}
                      >
                        {visible ? <EyeOff /> : <Eye />}
                      </InputGroupButton>
                    </InputGroupAddon>
                  </InputGroup>
                  {capsLock && !passwordInvalid && (
                    <p className="auth-capslock-hint" role="status">
                      <AlertTriangle aria-hidden="true" className="size-3.5 shrink-0" />
                      <span>大写锁定已开启</span>
                    </p>
                  )}
                  {setup && (
                    <FieldDescription id="password-hint">
                      至少 {MIN_ADMIN_PASSWORD_CHARACTERS} 个字符。
                    </FieldDescription>
                  )}
                  {passwordInvalid && (
                    <FieldError id="password-error">
                      {passwordError ??
                        (error instanceof Error ? error.message : null)}
                    </FieldError>
                  )}
                </Field>
                {setup && (
                  <Field
                    data-invalid={invalidField === "confirmation"}
                    data-disabled={pending}
                  >
                    <div className="auth-label-row">
                      <FieldLabel htmlFor="password-confirmation">
                        再次输入密码
                      </FieldLabel>
                      {setupConfirmationReady && (
                        <span className="auth-ready-indicator" aria-hidden="true">
                          <Check className="size-3.5" />
                          <span>两次输入一致</span>
                        </span>
                      )}
                    </div>
                    <Input
                      id="password-confirmation"
                      name="password-confirmation"
                      className="auth-input"
                      type={visible ? "text" : "password"}
                      autoComplete="new-password"
                      required
                      value={confirmation}
                      disabled={pending}
                      aria-invalid={invalidField === "confirmation"}
                      aria-describedby={
                        invalidField === "confirmation"
                          ? "confirmation-error"
                          : undefined
                      }
                      onKeyDown={handleModifierKeys}
                      onKeyUp={handleModifierKeys}
                      onBlur={() => setCapsLock(false)}
                      onChange={(event) => {
                        setConfirmation(event.target.value);
                        setError(null);
                        setInvalidField(null);
                      }}
                    />
                    {invalidField === "confirmation" && (
                      <FieldError id="confirmation-error">
                        {error instanceof Error ? error.message : null}
                      </FieldError>
                    )}
                  </Field>
                )}
                {!setup && (
                  <Field
                    orientation="horizontal"
                    className="auth-remember-field min-w-0 items-center"
                    data-disabled={pending}
                  >
                    <Checkbox
                      id="remember-me"
                      name="remember-me"
                      checked={remember}
                      disabled={pending}
                      onCheckedChange={setRemember}
                    />
                    <FieldLabel
                      htmlFor="remember-me"
                      className={cn(
                        "min-w-0 cursor-pointer font-normal transition-colors",
                        remember ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      在此设备保持登录 30 天
                    </FieldLabel>
                  </Field>
                )}
                <ErrorNotice
                  error={
                    invalidField || passwordError || tokenError ? null : error
                  }
                  showDiagnostics={
                    !(
                      error instanceof ApiError &&
                      ["auth_rate_limited", "password_work_busy"].includes(
                        error.code,
                      )
                    )
                  }
                />
                <Field>
                  <Button
                    type="submit"
                    size="lg"
                    className="auth-submit h-auto min-h-10 w-full whitespace-normal py-2"
                    disabled={pending}
                    aria-busy={pending}
                  >
                    {pending && (
                      <Spinner aria-hidden="true" data-icon="inline-start" />
                    )}
                    <span>
                      {pending
                        ? setup
                          ? "正在创建管理员…"
                          : "正在登录…"
                        : setup
                          ? "创建管理员"
                          : "登录"}
                    </span>
                    {!pending && (
                      <ArrowRight
                        aria-hidden="true"
                        data-icon="inline-end"
                        className="auth-submit-arrow"
                      />
                    )}
                  </Button>
                </Field>
              </FieldGroup>
            </form>
          )}
        </CardContent>
      </Card>
      {initialized === true && (
        <div ref={recoveryRef} className="auth-recovery-anchor">
          <Collapsible
            open={recoveryOpen}
            onOpenChange={setRecoveryOpen}
            className="flex w-full min-w-0 flex-col items-center"
          >
            <CollapsibleTrigger
              render={
                <Button
                  ref={recoveryTriggerRef}
                  variant="ghost"
                  size="sm"
                  className="auth-recovery-trigger h-auto min-h-8 max-w-full whitespace-normal px-3 py-1.5"
                />
              }
            >
              <HelpCircle aria-hidden="true" data-icon="inline-start" />
              <span>忘记密码？</span>
              <ChevronDown
                aria-hidden="true"
                data-icon="inline-end"
                className="auth-recovery-chevron"
              />
            </CollapsibleTrigger>
            <CollapsibleContent className="auth-recovery-popover">
              <div className="auth-recovery-panel">
                <FieldDescription className="wrap-anywhere leading-relaxed">
                  请联系服务器管理员停服重设，无需删除数据。
                </FieldDescription>
                <a
                  data-external-link
                  className="auth-recovery-link"
                  href="https://github.com/Mashiro0619/PerPay/blob/main/docs/maintenance.md#忘记管理员密码"
                  target="_blank"
                  rel="noreferrer"
                >
                  查看恢复步骤
                  <ExternalLink
                    aria-hidden="true"
                    className="auth-recovery-link-icon"
                  />
                </a>
              </div>
            </CollapsibleContent>
          </Collapsible>
        </div>
      )}
    </AuthShell>
  );
}
