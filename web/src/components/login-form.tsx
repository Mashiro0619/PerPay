import { useSystemName } from "@/branding";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useLocation, useNavigate, Link } from "react-router";
import { Eye, EyeOff, WalletCards, CheckCircle2, ChevronDown } from "lucide-react";
import { api, ApiError, result } from "@/api/client";
import { MIN_ADMIN_PASSWORD_CHARACTERS, validatePassword } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ThemeControl } from "@/theme";
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
  InputGroupInput,
  InputGroupAddon,
  InputGroupButton,
} from "@/components/ui/input-group";
import { Checkbox } from "@/components/ui/checkbox";
import { Spinner } from "@/components/ui/spinner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
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
  const [setupTokenRequired] = useState(() =>
    document.querySelector('meta[name="perpay-setup-token-required"]')?.getAttribute("content") !== "false",
  );
  const title =
    initialized === null
      ? "无法确认系统状态"
      : setup
        ? `初始化 ${systemName}`
        : "登录管理后台";
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const tokenInput = useRef<HTMLInputElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [remember, setRemember] = useState(false);
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
  const tokenError = setup && setupTokenRequired && error instanceof ApiError && error.code === "setup_token_invalid"
    ? "初始化令牌无效或已失效，请从服务器最新启动日志重新获取。"
    : null;
  const tokenInvalid = invalidField === "token" || tokenError !== null;

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
  }, [title, systemName]);

  useEffect(() => {
    if (initialized === true && location.pathname === "/setup")
      navigate("/login", { replace: true });
  }, [initialized, location.pathname, navigate]);

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
        await result(api.setupAdministrator({ body: setupTokenRequired ? { password, setup_token: setupToken.trim() } : { password } }));
        markInitialized();
        setConfigured(true);
        navigate("/login", { replace: true });
      } else {
        await result(
          api.loginAdministrator({
            body: remember ? { password, remember_me: true } : { password },
          }),
        );
        setPassword("");
        onLogin();
        if (["/login", "/setup"].includes(location.pathname))
          navigate("/", { replace: true });
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
    <main className="flex min-h-svh flex-col p-4 sm:p-6" data-admin-auth>
      <ThemeControl className="shrink-0 self-end" />
      <div className="mx-auto my-auto flex w-full min-w-0 max-w-sm flex-col gap-6 py-6 sm:py-10">
        <Link
          to="/"
          className="flex min-w-0 max-w-full items-center justify-center gap-2 self-center px-1 py-1 font-medium"
        >
          <WalletCards aria-hidden="true" className="shrink-0" />
          <span className="min-w-0 break-all">{systemName}</span>
        </Link>
        <Card className="min-w-0 [--card-spacing:--spacing(5)] sm:[--card-spacing:--spacing(6)]">
          <CardHeader>
            <CardTitle>
              <h1>{title}</h1>
            </CardTitle>
            {setup && (
              <CardDescription>
                先创建管理员，再登录配置收款。
              </CardDescription>
            )}
          </CardHeader>
          <CardContent className="flex min-w-0 flex-col gap-3">
            {initialized === null ? (
              <ErrorNotice
                error={
                  new Error(
                    "无法读取初始化状态，请检查服务后重试。",
                  )
                }
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
                <FieldGroup className={cn(!setup && "gap-2 sm:gap-5")}>
                  {(configured || alreadyInitialized) && !setup && (
                    <Alert>
                      <CheckCircle2 />
                      <AlertDescription>
                        {configured
                          ? "管理员已创建"
                          : "系统已初始化，请用现有管理员密码登录。"}
                      </AlertDescription>
                    </Alert>
                  )}
                  {setup && setupTokenRequired && (
                    <Field data-invalid={tokenInvalid} data-disabled={pending}>
                      <FieldLabel htmlFor="setup-token">一次性初始化令牌</FieldLabel>
                      <Input
                        ref={tokenInput}
                        id="setup-token"
                        name="setup-token"
                        type="password"
                        autoComplete="off"
                        autoCapitalize="none"
                        spellCheck={false}
                        maxLength={256}
                        required
                        value={setupToken}
                        disabled={pending}
                        aria-invalid={tokenInvalid}
                        aria-describedby={tokenInvalid ? "setup-token-error" : "setup-token-hint"}
                        onChange={(event) => {
                          setSetupToken(event.target.value);
                          setError(null);
                          setInvalidField(null);
                        }}
                      />
                      <FieldDescription id="setup-token-hint" className="wrap-anywhere">
                        从服务器启动日志获取；Docker 部署执行 <code>docker compose logs app</code>，复制最新的 <code>setup_token</code>。未初始化时重启服务会更换令牌。
                      </FieldDescription>
                      {tokenInvalid && (
                        <FieldError id="setup-token-error">
                          {tokenError ?? (error instanceof Error ? error.message : null)}
                        </FieldError>
                      )}
                    </Field>
                  )}
                  <Field data-invalid={passwordInvalid} data-disabled={pending}>
                    <FieldLabel htmlFor="password">
                      {setup ? "设置管理员密码" : "管理员密码"}
                    </FieldLabel>
                    <InputGroup>
                      <InputGroupInput
                        id="password"
                        name="password"
                        type={visible ? "text" : "password"}
                        autoComplete={
                          setup ? "new-password" : "current-password"
                        }
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
                        onChange={(event) => {
                          setPassword(event.target.value);
                          setError(null);
                          setInvalidField(null);
                        }}
                      />
                      <InputGroupAddon align="inline-end">
                        <InputGroupButton
                          aria-label={visible ? "隐藏密码" : "显示密码"}
                          type="button"
                          disabled={pending}
                          onClick={() => setVisible(!visible)}
                        >
                          {visible ? <EyeOff /> : <Eye />}
                        </InputGroupButton>
                      </InputGroupAddon>
                    </InputGroup>
                    {setup && (
                      <FieldDescription id="password-hint">
                        至少 {MIN_ADMIN_PASSWORD_CHARACTERS} 个字符。
                      </FieldDescription>
                    )}
                    {passwordInvalid && (
                      <FieldError id="password-error">
                        {passwordError ?? (error instanceof Error ? error.message : null)}
                      </FieldError>
                    )}
                  </Field>
                  {setup && (
                    <Field data-invalid={invalidField === "confirmation"} data-disabled={pending}>
                      <FieldLabel htmlFor="password-confirmation">
                        再次输入密码
                      </FieldLabel>
                      <Input
                        id="password-confirmation"
                        name="password-confirmation"
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
                    <Field orientation="horizontal" className="min-w-0" data-disabled={pending}>
                      <Checkbox
                        id="remember-me"
                        name="remember-me"
                        checked={remember}
                        disabled={pending}
                        onCheckedChange={setRemember}
                      />
                      <FieldLabel htmlFor="remember-me" className="min-w-0">
                        在此设备保持登录 30 天
                      </FieldLabel>
                    </Field>
                  )}
                  <ErrorNotice
                    error={invalidField || passwordError || tokenError ? null : error}
                    showDiagnostics={
                      !(error instanceof ApiError &&
                        ["auth_rate_limited", "password_work_busy"].includes(error.code))
                    }
                  />
                  <Field>
                    <Button
                      type="submit"
                      size="lg"
                      className="h-auto min-h-9 whitespace-normal py-1.5"
                      disabled={pending}
                      aria-busy={pending}
                    >
                      {pending && (
                        <Spinner aria-hidden="true" data-icon="inline-start" />
                      )}
                      {setup ? "创建管理员" : "登录"}
                    </Button>
                  </Field>
                </FieldGroup>
              </form>
            )}
            {initialized === true && (
              <Collapsible className="flex w-full min-w-0 flex-col items-end gap-2">
                <CollapsibleTrigger render={<Button variant="ghost" size="sm" className="h-auto min-h-7 max-w-full whitespace-normal py-1" />}>
                  忘记密码？
                  <ChevronDown aria-hidden="true" data-icon="inline-end" className="transition-transform group-data-panel-open/button:rotate-180 motion-reduce:transition-none" />
                </CollapsibleTrigger>
                <CollapsibleContent className="w-full min-w-0 pb-1">
                  <FieldDescription className="wrap-anywhere">
                    请联系服务器管理员停服重设，无需删除数据。
                    <a
                      data-external-link
                      href="https://github.com/Mashiro0619/PerPay/blob/main/docs/maintenance.md#忘记管理员密码"
                      target="_blank"
                      rel="noreferrer"
                    >
                      查看恢复步骤
                    </a>
                  </FieldDescription>
                </CollapsibleContent>
              </Collapsible>
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
