import { useEffect, useRef, useState, type FormEvent } from "react";
import { useLocation, useNavigate, Link } from "react-router";
import { Eye, EyeOff, WalletCards, CheckCircle2 } from "lucide-react";
import { api, result } from "@/api/client";
import { MIN_ADMIN_PASSWORD_CHARACTERS, validatePassword } from "@/lib/format";
import { ThemeControl } from "@/theme";
import { ErrorNotice } from "@/components/request-state";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  const location = useLocation();
  const navigate = useNavigate();
  const initialized = document
    .querySelector('meta[name="perpay-initialized"]')
    ?.getAttribute("content");
  const setup =
    initialized !== "true" &&
    (location.pathname === "/setup" ||
      (initialized === "false" && location.pathname !== "/login"));
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [visible, setVisible] = useState(false);
  const [remember, setRemember] = useState(false);
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);
  const [error, setError] = useState<unknown>(null);
  const [invalidField, setInvalidField] = useState<
    "password" | "confirmation" | null
  >(null);
  const [configured, setConfigured] = useState(false);

  useEffect(() => {
    document.title = `${setup ? "初始化" : "登录"} · PerPay`;
    setError(null);
    setInvalidField(null);
    setPassword("");
    setConfirmation("");
    setRemember(false);
  }, [setup]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    if (visible) setVisible(false);
    setError(null);
    setInvalidField(null);
    if (setup) {
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
        await result(api.setupAdministrator({ body: { password } }));
        document
          .querySelector('meta[name="perpay-initialized"]')
          ?.setAttribute("content", "true");
        setPassword("");
        setConfirmation("");
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
      setError(failure);
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  return (
    <main className="flex min-h-svh items-center justify-center p-6 md:p-10">
      <ThemeControl className="absolute right-4 top-4" />
      <div className="flex w-full max-w-sm flex-col gap-6">
        <Link
          to="/"
          className="flex items-center justify-center gap-2 font-medium"
        >
          <WalletCards />
          PerPay
        </Link>
        <Card>
          <CardHeader>
            <CardTitle>
              <h1>{setup ? "创建管理员" : "登录管理后台"}</h1>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form
              onSubmit={(event) => {
                void submit(event);
              }}
            >
              <FieldGroup>
                {configured && !setup && (
                  <Alert>
                    <CheckCircle2 />
                    <AlertDescription>管理员已创建</AlertDescription>
                  </Alert>
                )}
                <Field data-invalid={invalidField === "password"}>
                  <FieldLabel htmlFor="password">
                    {setup ? "设置管理员密码" : "管理员密码"}
                  </FieldLabel>
                  <InputGroup>
                    <InputGroupInput
                      id="password"
                      name="password"
                      type={visible ? "text" : "password"}
                      autoComplete={setup ? "new-password" : "current-password"}
                      required
                      value={password}
                      disabled={pending}
                      aria-invalid={invalidField === "password"}
                      aria-describedby={
                        invalidField === "password"
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
                  {invalidField === "password" && (
                    <FieldError id="password-error">
                      {error instanceof Error ? error.message : null}
                    </FieldError>
                  )}
                </Field>
                {setup && (
                  <Field data-invalid={invalidField === "confirmation"}>
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
                  <Field orientation="horizontal">
                    <Checkbox
                      id="remember-me"
                      name="remember-me"
                      checked={remember}
                      disabled={pending}
                      onCheckedChange={setRemember}
                    />
                    <FieldLabel htmlFor="remember-me">
                      在此设备保持登录 30 天
                    </FieldLabel>
                  </Field>
                )}
                <ErrorNotice error={invalidField ? null : error} />
                <Field>
                  <Button type="submit" disabled={pending} aria-busy={pending}>
                    {pending && (
                      <Spinner aria-hidden="true" data-icon="inline-start" />
                    )}
                    {setup ? "创建管理员" : "登录"}
                  </Button>
                  {setup ? (
                    <FieldDescription className="text-center">
                      <Link to="/login">已有管理员？前往登录</Link>
                    </FieldDescription>
                  ) : (
                    initialized !== "true" && (
                      <FieldDescription className="text-center">
                        <Link to="/setup">首次使用？初始化实例</Link>
                      </FieldDescription>
                    )
                  )}
                </Field>
              </FieldGroup>
            </form>
          </CardContent>
        </Card>
        {!setup && (
          <Collapsible>
            <CollapsibleTrigger render={<Button variant="link" size="sm" />}>
              忘记密码？
            </CollapsibleTrigger>
            <CollapsibleContent>
              <FieldDescription>
                请联系服务器管理员停服重设，无需删除数据。
                <a
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
      </div>
    </main>
  );
}
