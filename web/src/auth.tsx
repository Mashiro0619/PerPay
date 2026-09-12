import { createContext, useContext, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Eye, EyeOff, LockKeyhole } from "lucide-react";
import { Link, useLocation, useNavigate } from "react-router";

import { api, ApiError, invalidateSessionRequests, queryClient, result, sessionKey, type AdminSessionEnvelope } from "./api/client";
import { Button, ErrorNotice, Field, Loading, Notice } from "./components/ui";
import { MIN_ADMIN_PASSWORD_CHARACTERS, validatePassword } from "./lib/format";
import { ThemeControl } from "./theme";
import { clearOnboardingDeferrals } from "./lib/onboarding";

const SessionContext = createContext<{ username: string; forget: () => void; error: Error | null; retry: () => void }>({ username: "admin", forget: () => undefined, error: null, retry: () => undefined });
export const useSession = () => useContext(SessionContext);

export function AuthBoundary({ children }: { children: ReactNode }) {
  const session = useQuery<AdminSessionEnvelope | null>({
    queryKey: sessionKey,
    queryFn: ({ signal }) => result(api.getAdministratorSession({ signal })),
    retry: false,
    staleTime: 60_000,
  });
  const forget = () => {
    clearOnboardingDeferrals();
    invalidateSessionRequests();
    void queryClient.cancelQueries();
    queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== "session" });
    queryClient.getMutationCache().clear();
    queryClient.setQueryData(sessionKey, null);
  };
  useEffect(() => {
    window.addEventListener("perpay:session-expired", forget);
    return () => window.removeEventListener("perpay:session-expired", forget);
  }, []);
  const rejected = session.error instanceof ApiError && [401, 403].includes(session.error.status);
  useEffect(() => { if (rejected) forget(); }, [session.error]);

  if (session.isPending) return <div className="auth-loading"><Loading label="正在验证管理员会话…" /></div>;
  if (session.isError && !session.data && !rejected) {
    return <div className="auth-loading"><ErrorNotice error={session.error} retry={() => { void session.refetch(); }} /></div>;
  }
  if (!session.data || rejected) return <AuthPage onLogin={() => { void session.refetch(); }} />;
  return <SessionContext value={{ username: session.data.data.username, forget, error: session.error, retry: () => { void session.refetch(); } }}>{children}</SessionContext>;
}

export function AuthPage({ onLogin }: { onLogin: () => void }) {
  const location = useLocation();
  const navigate = useNavigate();
  const initialized = document.querySelector('meta[name="perpay-initialized"]')?.getAttribute("content");
  const setup = initialized !== "true" && (location.pathname === "/setup" || (initialized === "false" && location.pathname !== "/login"));
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [visible, setVisible] = useState(false);
  const [remember, setRemember] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [invalidField, setInvalidField] = useState<"password" | "confirmation" | null>(null);
  const [configured, setConfigured] = useState(false);

  useEffect(() => { document.title = `${setup ? "初始化" : "登录"} · PerPay`; setError(null); setInvalidField(null); setPassword(""); setConfirmation(""); setRemember(false); }, [setup]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (visible) setVisible(false);
    setError(null);
    setInvalidField(null);
    if (setup) {
      const validation = validatePassword(password);
      if (validation || confirmation !== password) {
        const field = validation ? "password" : "confirmation";
        setInvalidField(field); setError(new Error(validation ?? "两次输入的密码不一致。"));
        (event.currentTarget.elements.namedItem(field === "password" ? "password" : "password-confirmation") as HTMLInputElement)?.focus();
        return;
      }
    }
    setPending(true);
    try {
      if (setup) {
        await result(api.setupAdministrator({ body: { password } }));
        document.querySelector('meta[name="perpay-initialized"]')?.setAttribute("content", "true");
        setPassword(""); setConfirmation(""); setConfigured(true);
        navigate("/login", { replace: true });
      } else {
        await result(api.loginAdministrator({ body: remember ? { password, remember_me: true } : { password } }));
        setPassword("");
        onLogin();
        if (["/login", "/setup"].includes(location.pathname)) navigate("/", { replace: true });
      }
    } catch (failure) { setError(failure); } finally { setPending(false); }
  }

  return <main className="auth-layout">
    <ThemeControl className="auth-theme" />
    <section className="auth-story">
      <Link className="brand" to="/"><span>PerPay</span></Link>
      <div className="auth-statement"><h2>每一笔收款，<br />都有据可查。</h2></div>
    </section>
    <section className="auth-form-area"><div className="auth-form-wrap">
      <div className="auth-form-title"><LockKeyhole size={23} aria-hidden="true" /><h1>{setup ? "开始使用 PerPay" : "登录管理后台"}</h1>
        {setup && <p>为这个实例设置管理员密码。初始化完成后，此入口会永久关闭。</p>}</div>
      {configured && !setup && <Notice tone="success">管理员已创建，请使用刚设置的密码登录。</Notice>}
      <form onSubmit={(event) => { void submit(event); }} className="form-stack">
        <Field label={setup ? "设置管理员密码" : "管理员密码"} hint={setup ? `至少 ${MIN_ADMIN_PASSWORD_CHARACTERS} 个字符，建议使用密码管理器生成并保存。` : undefined} error={invalidField === "password" && error instanceof Error ? error.message : undefined}>
          <span className="password-field"><input name="password" type={visible ? "text" : "password"} autoComplete={setup ? "new-password" : "current-password"} required value={password} disabled={pending} onChange={(event) => setPassword(event.target.value)} />
            <button type="button" className="password-toggle" aria-label={visible ? "隐藏密码" : "显示密码"} onClick={() => setVisible(!visible)}>{visible ? <EyeOff size={18} /> : <Eye size={18} />}</button></span>
        </Field>
        {setup && <Field label="再次输入密码" error={invalidField === "confirmation" && error instanceof Error ? error.message : undefined}><input name="password-confirmation" type={visible ? "text" : "password"} autoComplete="new-password" required value={confirmation} disabled={pending} onChange={(event) => setConfirmation(event.target.value)} /></Field>}
        <ErrorNotice error={invalidField ? null : error} />
        {!setup && <label className="checkbox-field auth-remember"><input name="remember-me" type="checkbox" checked={remember} disabled={pending} onChange={(event) => setRemember(event.target.checked)} /><span>在此设备保持登录 30 天</span></label>}
        <Button type="submit" variant="primary" pending={pending} className="auth-submit">{setup ? "创建管理员" : "登录"}<ArrowRight size={17} /></Button>
      </form>
      {!setup && <details className="form-disclosure"><summary>忘记密码？</summary><p>请联系服务器管理员停服重设，无需删除数据。<a href="https://github.com/Mashiro0619/PerPay/blob/main/docs/maintenance.md#忘记管理员密码" target="_blank" rel="noreferrer">查看恢复步骤</a></p></details>}
      <div className="auth-switch">{setup ? <Link to="/login">已有管理员？前往登录</Link> : initialized !== "true" && <Link to="/setup">首次使用？初始化实例</Link>}</div>
    </div></section>
  </main>;
}
