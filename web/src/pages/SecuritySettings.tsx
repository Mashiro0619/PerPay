import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { Eye, KeyRound, LogOut, ShieldCheck } from "lucide-react";

import { api, result, type RuntimeSecretName, type RuntimeSettings } from "../api/client";
import { useSession } from "../auth";
import { Badge, Button, CopyValue, Dialog, ErrorNotice, Field, Notice, Panel } from "../components/ui";
import { MIN_ADMIN_PASSWORD_CHARACTERS, shortId, validatePassword } from "../lib/format";
import { useDirtyDraft, useDraftGuard } from "../drafts";

const secrets: Array<[RuntimeSecretName, string]> = [["api_secret", "网站 API 密钥"], ["provider_private_key", "应用私钥"], ["provider_public_key", "支付宝公钥"], ["webhook_secret", "通知签名密钥"]];

export function SecuritySettings({ settings, onSaved }: { settings: RuntimeSettings; onSaved: (settings: RuntimeSettings, message?: string) => void }) {
  const { requestDiscard } = useDraftGuard();
  const [reveal, setReveal] = useState<RuntimeSecretName | null>(null);
  const [rotate, setRotate] = useState(false);
  const [revoke, setRevoke] = useState(false);
  const session = useSession();
  const revokeAll = useMutation({ mutationFn: () => result(api.revokeAllAdministratorSessions({ body: {} })), onSuccess: session.forget });
  return <>
    <Panel title="API 访问密钥" className="content-panel">
      <p className="field-hint">客户端 ID</p><CopyValue value="default" label="复制 API 客户端 ID" />
      <Notice tone="warning">仅在业务服务端使用 API 密钥，不要嵌入网页、移动端安装包或公开仓库。轮换后旧密钥立即失效。</Notice>
      <Button onClick={() => setRotate(true)} variant={settings.completion.api ? "secondary" : "primary"}><KeyRound size={16} />{settings.completion.api ? "轮换 API 密钥" : "生成 API 密钥"}</Button>
    </Panel>
    <Panel title="密钥保管">
      <ul className="secret-list">{secrets.map(([name, title]) => <li key={name}><div><strong>{title}</strong><span className="field-hint">{settings.secrets[name].configured ? `版本 ${settings.secrets[name].version} · 指纹 ${shortId(settings.secrets[name].fingerprint)}` : "尚未配置"}</span></div><Badge value={settings.secrets[name].configured ? "CONFIRMED" : "UNPAID"} label={settings.secrets[name].configured ? "已配置" : "未配置"} /><Button disabled={!settings.secrets[name].configured} onClick={() => setReveal(name)} aria-label={`显示${title}`}><Eye size={15} />显示</Button></li>)}</ul>
    </Panel>
    <PasswordForm />
    <Panel title="管理员会话" className="content-panel"><Button variant="danger" onClick={() => requestDiscard(() => setRevoke(true))}><LogOut size={16} />注销全部会话</Button></Panel>
    {reveal && <SecretDialog name={reveal} title={secrets.find(([name]) => name === reveal)?.[1] ?? "密钥"} onClose={() => setReveal(null)} />}
    {rotate && <RotateKeyDialog settings={settings} onSaved={onSaved} onClose={() => setRotate(false)} />}
    {revoke && <Dialog title="注销全部管理员会话？" description="所有设备上的管理员都需要重新登录。网站 API 密钥不会受到影响。" onClose={() => setRevoke(false)} busy={revokeAll.isPending}><ErrorNotice error={revokeAll.error} /><div className="form-actions"><Button disabled={revokeAll.isPending} onClick={() => setRevoke(false)}>取消</Button><Button variant="danger" pending={revokeAll.isPending} onClick={() => revokeAll.mutate()}>确认注销全部会话</Button></div></Dialog>}
  </>;
}

function useSecretLifetime(active: boolean, onClose: () => void) {
  const close = useRef(onClose);
  const mounted = useRef(false);
  close.current = onClose;
  useLayoutEffect(() => {
    mounted.current = true;
    const hide = () => {
      if (document.hidden) { mounted.current = false; close.current(); }
    };
    document.addEventListener("visibilitychange", hide);
    hide();
    return () => { mounted.current = false; document.removeEventListener("visibilitychange", hide); };
  }, []);
  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(() => { mounted.current = false; close.current(); }, 60_000);
    return () => window.clearTimeout(timer);
  }, [active]);
  return () => mounted.current && !document.hidden;
}

export function SecretDialog({ name, title, onClose }: { name: RuntimeSecretName; title: string; onClose: () => void }) {
  const [value, setValue] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const canDisplay = useSecretLifetime(value !== null, onClose);
  async function reveal() {
    setPending(true); setError(null);
    const operation = new AbortController();
    controller.current = operation;
    try {
      const response = await result(api.revealRuntimeSecret({ path: { name }, body: {}, signal: operation.signal }));
      if (!operation.signal.aborted && canDisplay()) setValue(response.data.value);
    } catch (failure) { if (!operation.signal.aborted && canDisplay()) setError(failure); }
    finally { if (!operation.signal.aborted && canDisplay()) setPending(false); }
  }
  return <Dialog title={title} description="60 秒后或切换标签页时自动清除。" onClose={onClose}>
    {value !== null ? <CopyValue value={value} label={`复制${title}`} secret /> : <Button variant="primary" pending={pending} onClick={() => { void reveal(); }}><Eye size={16} />读取明文</Button>}
    <ErrorNotice error={error} /><div className="form-actions"><Button onClick={onClose}>关闭</Button></div>
  </Dialog>;
}

export function RotateKeyDialog({ settings, onSaved, onClose, onStored }: { settings: RuntimeSettings; onSaved: (settings: RuntimeSettings, message?: string) => void; onClose: () => void; onStored?: () => void }) {
  const [replacing] = useState(settings.completion.api);
  const [accepted, setAccepted] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const canDisplay = useSecretLifetime(secret !== null, onClose);
  async function rotate() {
    setPending(true); setError(null);
    try {
      const response = await result(api.rotateApiClientSecret({ body: { revision: settings.revision } }));
      if (canDisplay()) setSecret(response.data.secret);
      onSaved(response.data.settings, "API 密钥已更新，请同步更新业务服务端的签名配置。");
    } catch (failure) { if (canDisplay()) setError(failure); } finally { if (canDisplay()) setPending(false); }
  }
  return <Dialog title={secret ? "新的 API 密钥" : replacing ? "轮换 API 密钥" : "生成 API 密钥"} description={secret ? "60 秒后或切换标签页时自动清除。" : replacing ? "旧密钥将立即失效，请同步更新业务网站。" : "密钥仅用于业务网站后端。"} onClose={onClose} busy={pending}>
    {secret ? <><CopyValue value={secret} label="复制新的 API 密钥" secret /><div className="form-actions"><Button onClick={() => { onClose(); onStored?.(); }}>已妥善保存</Button></div></> : <>
      {error && <p className="field-hint">结果不确定时，先查看当前密钥，不要再次轮换。</p>}
      {replacing && <label className="checkbox-field"><input type="checkbox" checked={accepted} disabled={pending} onChange={(event) => setAccepted(event.target.checked)} /><span>确认轮换，旧密钥立即失效。</span></label>}<ErrorNotice error={error} />
      <div className="form-actions"><Button disabled={pending} onClick={onClose}>取消</Button><Button variant={replacing ? "danger" : "primary"} pending={pending} disabled={replacing && !accepted} onClick={() => { void rotate(); }}>{replacing ? "确认轮换" : "生成密钥"}</Button></div>
    </>}
  </Dialog>;
}

function PasswordForm() {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [validation, setValidation] = useState<Error | null>(null);
  const [invalidField, setInvalidField] = useState<"password" | "confirmation" | null>(null);
  useDirtyDraft(password !== "" || confirmation !== "" || accepted);
  const session = useSession();
  const change = useMutation({ mutationFn: () => result(api.changeAdministratorPassword({ body: { new_password: password } })), onSuccess: () => { setPassword(""); setConfirmation(""); session.forget(); } });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const error = validatePassword(password) ?? (password !== confirmation ? "两次输入的密码不一致。" : null);
    if (error) {
      const field = validatePassword(password) ? "password" : "confirmation";
      setInvalidField(field); setValidation(new Error(error));
      (event.currentTarget.elements.namedItem(field === "password" ? "new-password" : "confirm-password") as HTMLInputElement)?.focus();
      return;
    }
    setInvalidField(null); setValidation(null); change.mutate();
  }
  return <Panel title="修改管理员密码" description="保存后全部管理员会话立即失效，需要使用新密码重新登录。" className="content-panel">
    <form onSubmit={submit} className="form-stack"><fieldset disabled={change.isPending}><div className="form-grid"><Field label="新密码" hint={`至少 ${MIN_ADMIN_PASSWORD_CHARACTERS} 个字符。`} error={invalidField === "password" ? validation?.message : undefined}><input name="new-password" type="password" autoComplete="new-password" required value={password} onChange={(event) => setPassword(event.target.value)} /></Field><Field label="再次输入新密码" error={invalidField === "confirmation" ? validation?.message : undefined}><input name="confirm-password" type="password" autoComplete="new-password" required value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></Field></div>
      <label className="checkbox-field"><input type="checkbox" checked={accepted} required onChange={(event) => setAccepted(event.target.checked)} /><span>已保存新密码，并了解所有会话将被注销。</span></label><ErrorNotice error={change.error} /><div className="form-actions"><Button type="submit" variant="danger" pending={change.isPending} disabled={!accepted}><ShieldCheck size={16} />修改密码并重新登录</Button></div>
    </fieldset></form>
  </Panel>;
}
