import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { Eye, KeyRound, ShieldCheck } from "lucide-react";

import { api, result, type RuntimeSecretName, type RuntimeSettings } from "../api/client";
import { useSession } from "../auth";
import { Badge, Button, CopyValue, Dialog, ErrorNotice, Field, Loading, Panel } from "../components/ui";
import { MoreActions } from "../components/MoreActions";
import { MIN_ADMIN_PASSWORD_CHARACTERS, dateTime, validatePassword } from "../lib/format";
import { useDirtyDraft, useDraftGuard } from "../drafts";

const secrets: Array<[RuntimeSecretName, string, string]> = [
  ["api_secret", "网站 API 密钥", "业务服务端请求签名"],
  ["webhook_secret", "通知签名密钥", "业务网站验证付款通知"],
  ["provider_private_key", "应用私钥", "PerPay 请求支付宝"],
  ["provider_public_key", "支付宝公钥", "验证支付宝返回的数据"],
];

export function SecuritySettings({ settings, onSaved }: { settings: RuntimeSettings; onSaved: (settings: RuntimeSettings, message?: string) => void }) {
  const { requestDiscard } = useDraftGuard();
  const [reveal, setReveal] = useState<RuntimeSecretName | null>(null);
  const [rotate, setRotate] = useState(false);
  const [revoke, setRevoke] = useState(false);
  const session = useSession();
  const revokeAll = useMutation({ mutationFn: () => result(api.revokeAllAdministratorSessions({ body: {} })), onSuccess: session.forget });
  return <>
    <Panel title="密钥" description="仅在服务端使用，不要放入网页或公开仓库。" className="content-panel security-keys">
      <div className="client-id"><span>API 客户端 ID</span><CopyValue value="default" label="复制 API 客户端 ID" /></div>
      <ul className="secret-list">{secrets.map(([name, title, purpose]) => {
        const metadata = settings.secrets[name];
        return <li key={name}><div className="secret-summary"><strong>{title}</strong><span className="field-hint">{purpose}</span>
          {metadata.configured && metadata.updatedAt !== null && <time className="field-hint" dateTime={new Date(metadata.updatedAt).toISOString()}>更新于 {dateTime(metadata.updatedAt)}</time>}</div>
          <div className="secret-actions"><Badge value={metadata.configured ? "CONFIRMED" : "UNPAID"} label={metadata.configured ? "已配置" : "未配置"} />
            <Button disabled={!metadata.configured} onClick={() => setReveal(name)} aria-label={"查看" + title}><Eye size={16} />查看</Button>
            {name === "api_secret" && (settings.completion.api
              ? <MoreActions label="API 密钥操作" actions={[{ label: "轮换 API 密钥", danger: true, onSelect: () => setRotate(true) }]} />
              : <Button variant="primary" onClick={() => setRotate(true)}><KeyRound size={16} />生成 API 密钥</Button>)}
          </div></li>;
      })}</ul>
    </Panel>
    <PasswordForm />
    <Panel title="登录会话" description="让所有设备重新登录，不影响网站 API。" className="content-panel"
      action={<MoreActions label="会话操作" actions={[{ label: "注销全部会话", danger: true, onSelect: () => requestDiscard(() => setRevoke(true)) }]} />}>
      <p className="field-hint">怀疑账号在其他设备上被使用时，可注销全部会话。</p>
    </Panel>
    {reveal && <SecretDialog name={reveal} title={secrets.find(([name]) => name === reveal)?.[1] ?? "密钥"} onClose={() => setReveal(null)} />}
    {rotate && <RotateKeyDialog settings={settings} onSaved={onSaved} onClose={() => setRotate(false)} />}
    {revoke && <Dialog title="注销全部会话？" description="包括当前设备，所有管理员都需要重新登录。" onClose={() => setRevoke(false)} busy={revokeAll.isPending}><ErrorNotice error={revokeAll.error} /><div className="form-actions"><Button disabled={revokeAll.isPending} onClick={() => setRevoke(false)}>取消</Button><Button variant="danger" pending={revokeAll.isPending} onClick={() => { if (!revokeAll.isPending) revokeAll.mutate(); }}>注销全部会话</Button></div></Dialog>}
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
  return useCallback(() => mounted.current && !document.hidden, []);
}

export function SecretDialog({ name, title, onClose }: { name: RuntimeSecretName; title: string; onClose: () => void }) {
  const [value, setValue] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(true);
  const controller = useRef<AbortController | null>(null);
  const canDisplay = useSecretLifetime(value !== null, onClose);
  const reveal = useCallback(async () => {
    if (controller.current && !controller.current.signal.aborted) return;
    setPending(true); setError(null);
    const operation = new AbortController();
    controller.current = operation;
    try {
      const response = await result(api.revealRuntimeSecret({ path: { name }, body: {}, signal: operation.signal }));
      if (!operation.signal.aborted && canDisplay()) setValue(response.data.value);
    } catch (failure) { if (!operation.signal.aborted && canDisplay()) setError(failure); }
    finally {
      if (controller.current === operation) controller.current = null;
      if (!operation.signal.aborted && canDisplay()) setPending(false);
    }
  }, [name, canDisplay]);
  // This component mounts only after an explicit View click. No secret enters the query cache.
  useEffect(() => { void reveal(); return () => { controller.current?.abort(); }; }, [reveal]);
  return <Dialog title={title} description="60 秒后或切换标签页时自动清除。" onClose={onClose}>
    {pending && <Loading label="正在读取密钥…" />}
    {value !== null && <CopyValue value={value} label={"复制" + title} secret />}
    <ErrorNotice error={error} retry={pending ? undefined : () => { void reveal(); }} /><div className="form-actions"><Button onClick={onClose}>关闭</Button></div>
  </Dialog>;
}

export function RotateKeyDialog({ settings, onSaved, onClose, onStored }: { settings: RuntimeSettings; onSaved: (settings: RuntimeSettings, message?: string) => void; onClose: () => void; onStored?: () => void }) {
  const [replacing] = useState(settings.completion.api);
  const [revision] = useState(settings.revision);
  const [secret, setSecret] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const attempted = useRef(false);
  const canDisplay = useSecretLifetime(secret !== null, onClose);
  async function rotate() {
    if (attempted.current) return;
    attempted.current = true;
    setPending(true); setError(null);
    try {
      const response = await result(api.rotateApiClientSecret({ body: { revision } }));
      if (canDisplay()) setSecret(response.data.secret);
      onSaved(response.data.settings, "API 密钥已更新，请同步业务服务端。");
    } catch (failure) { if (canDisplay()) setError(failure); } finally { if (canDisplay()) setPending(false); }
  }
  return <Dialog title={secret ? "新的 API 密钥" : replacing ? "轮换 API 密钥？" : "生成 API 密钥"} description={secret ? "60 秒后或切换标签页时自动清除。" : replacing ? "旧密钥立即失效。轮换后需更新业务服务端，否则无法创建订单。" : "密钥仅用于业务网站后端。"} onClose={onClose} busy={pending}>
    {secret ? <><CopyValue value={secret} label="复制新的 API 密钥" secret /><div className="form-actions"><Button onClick={() => { onClose(); onStored?.(); }}>完成</Button></div></> : <>
      <ErrorNotice error={error} />
      {error !== null && <p className="field-hint">结果未确认，请关闭后刷新配置并查看当前密钥。本次不再重试。</p>}
      <div className="form-actions"><Button disabled={pending} onClick={onClose}>{error ? "关闭" : "取消"}</Button><Button variant={replacing ? "danger" : "primary"} pending={pending} disabled={attempted.current} onClick={() => { void rotate(); }}>{replacing ? "确认轮换" : "生成密钥"}</Button></div>
    </>}
  </Dialog>;
}

function PasswordForm() {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [validation, setValidation] = useState<Error | null>(null);
  const [invalidField, setInvalidField] = useState<"password" | "confirmation" | null>(null);
  useDirtyDraft(password !== "" || confirmation !== "");
  const session = useSession();
  const submitting = useRef(false);
  const change = useMutation({ mutationFn: () => result(api.changeAdministratorPassword({ body: { new_password: password } })), onSuccess: () => { setPassword(""); setConfirmation(""); session.forget(); }, onSettled: () => { submitting.current = false; } });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || change.isPending) return;
    const error = validatePassword(password) ?? (password !== confirmation ? "两次输入的密码不一致。" : null);
    if (error) {
      const field = validatePassword(password) ? "password" : "confirmation";
      setInvalidField(field); setValidation(new Error(error));
      (event.currentTarget.elements.namedItem(field === "password" ? "new-password" : "confirm-password") as HTMLInputElement)?.focus();
      return;
    }
    submitting.current = true;
    setInvalidField(null); setValidation(null); change.mutate();
  }
  function edited() { setValidation(null); setInvalidField(null); change.reset(); }
  return <Panel title="修改密码" description="修改后所有设备都需重新登录。" className="content-panel">
    <form onSubmit={submit} className="form-stack"><fieldset disabled={change.isPending}><div className="form-grid"><Field label="新密码" hint={"至少 " + MIN_ADMIN_PASSWORD_CHARACTERS + " 个字符。"} error={invalidField === "password" ? validation?.message : undefined}><input name="new-password" type="password" autoComplete="new-password" required value={password} onChange={(event) => { setPassword(event.target.value); edited(); }} /></Field><Field label="再次输入新密码" error={invalidField === "confirmation" ? validation?.message : undefined}><input name="confirm-password" type="password" autoComplete="new-password" required value={confirmation} onChange={(event) => { setConfirmation(event.target.value); edited(); }} /></Field></div>
      <ErrorNotice error={change.error} /><div className="form-actions"><Button type="submit" variant="primary" pending={change.isPending} disabled={!password || !confirmation}><ShieldCheck size={16} />修改并重新登录</Button></div>
    </fieldset></form>
  </Panel>;
}
