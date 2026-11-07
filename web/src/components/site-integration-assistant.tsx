import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { ApiError, queryClient, type Site } from "@/api/client";
import {
  exportSiteIntegration, getSiteEpay, rotateEpaySecret, saveSiteEpay, siteEpayKey, viewEpaySecret,
  type EpaySecret, type IntegrationProtocol, type SiteEpayConfiguration,
} from "@/api/integration";
import { useDirtyDraft } from "@/drafts";
import { useOverlayCloseGuard } from "@/lib/overlay-context";
import { Link } from "@/navigation";
import { CopyValue } from "@/components/copy-value";
import { ErrorNotice, Loading } from "@/components/request-state";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Spinner } from "@/components/ui/spinner";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/admin-dialog";

interface AssistantProps {
  site: Site;
  siteDirty?: boolean;
  disabled?: boolean;
  showClientId?: boolean;
  onReloadSite: () => void;
}

const protocols = [
  { value: "native", label: "原生 API", description: "自建网站使用 HMAC 签名接入，Demo 会自动处理下单、查单和付款通知。" },
  { value: "epay_v1", label: "易支付 V1", description: "兼容易支付 MD5 插件，填写网关、PID 和 V1 密钥即可接入。" },
  { value: "epay_v2", label: "易支付 V2", description: "使用 RSA-SHA256 签名，商户私钥用于请求，平台公钥用于验证响应和付款通知。" },
] as const;

const secretLabels: Record<EpaySecret, string> = {
  epay_v1: "V1 密钥", epay_merchant: "V2 商户私钥", epay_platform: "V2 平台私钥",
};

const demoExample = [
  'import { createDemoClient, readConfig } from "./server.mjs";',
  "const config = readConfig();",
  "const client = createDemoClient(config);",
  "await client.createOrder({",
  '  idempotency_key: "demo:SHOP-001",',
  '  merchant_order_no: "SHOP-001",',
  "  amount_cents: 1000,",
  '  product_name: "示例商品",',
  "  notify_url: config.notifyUrl,",
  "  ...(config.returnUrl ? { return_url: config.returnUrl } : {}),",
  "});",
].join("\n");

function urlError(value: string, origin: string | null, required: boolean): string | null {
  if (!value.trim()) return required ? "请填写完整的通知地址。" : null;
  try {
    const url = new URL(value);
    if (!origin) return "请先保存对应的地址前缀。";
    if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password || url.hash) {
      return "请使用已保存地址前缀下的 HTTPS 地址，且不含账号、密码或片段。";
    }
    return null;
  } catch { return "请填写有效的完整 HTTPS 地址。"; }
}

export function SiteIntegrationAssistant(props: AssistantProps) {
  const query = useQuery({
    queryKey: siteEpayKey(props.site.client_id),
    queryFn: ({ signal }) => getSiteEpay(props.site.client_id, signal),
    refetchOnWindowFocus: false,
  });
  return <>
    <ErrorNotice error={query.error} retainedData={!!query.data} retry={() => { void query.refetch(); }} />
    {query.isPending ? <Loading label="正在读取接入配置…" /> : query.data &&
      <IntegrationContent key={props.site.client_id} {...props} configuration={query.data}
        reading={query.isFetching} onReload={async () => {
          const refreshed = await query.refetch();
          if (refreshed.error) throw refreshed.error;
          if (!refreshed.data) throw new Error("接入配置读取不完整，请重新读取。");
          props.onReloadSite();
          return refreshed.data;
        }} />}
  </>;
}

function IntegrationContent({ site, siteDirty = false, disabled = false, showClientId = true,
  configuration, reading, onReload }: AssistantProps & {
    configuration: SiteEpayConfiguration; reading: boolean; onReload: () => Promise<SiteEpayConfiguration>;
  }) {
  const id = useId();
  const [protocol, setProtocol] = useState<IntegrationProtocol>("native");
  type Switches = Pick<SiteEpayConfiguration, "revision" | "v1_enabled" | "v2_enabled">;
  const [draft, setDraft] = useState<{ base: Switches; values: Switches } | null>(null);
  const values = draft?.values ?? configuration;
  const dirty = draft !== null;
  const clearDraft = useDirtyDraft(dirty);
  const [notifyUrl, setNotifyUrl] = useState(() => site.configuration.notification_origin ? site.configuration.notification_origin + "/webhooks/perpay" : "");
  const [returnUrl, setReturnUrl] = useState(() => site.configuration.return_origin ? site.configuration.return_origin + "/return" : "");
  const [validateUrls, setValidateUrls] = useState(false);
  const notifyInput = useRef<HTMLInputElement>(null);
  const returnInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<Error | null>(null);
  const [refreshRequired, setRefreshRequired] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [pendingRead, setPendingRead] = useState(false);
  const [revealed, setRevealed] = useState<{ purpose: EpaySecret; secret: string; public_key?: string | null } | null>(null);
  const [rotation, setRotation] = useState<EpaySecret | null>(null);
  const activeRead = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const downloadUrl = useRef<string | null>(null);
  const writePending = useRef(false);

  const hideSecret = useCallback(() => {
    generation.current++;
    activeRead.current?.abort();
    activeRead.current = null;
    if (downloadUrl.current) URL.revokeObjectURL(downloadUrl.current);
    downloadUrl.current = null;
    setPendingRead(false);
    setRevealed(null);
  }, []);

  useLayoutEffect(() => {
    hideSecret();
    const onHidden = () => { if (document.hidden) hideSecret(); };
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("pagehide", hideSecret);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", hideSecret);
      generation.current++;
      activeRead.current?.abort();
      activeRead.current = null;
      if (downloadUrl.current) URL.revokeObjectURL(downloadUrl.current);
      downloadUrl.current = null;
    };
  }, [site.client_id, site.revision, configuration.revision, protocol, hideSecret]);
  useEffect(() => {
    if (!revealed) return;
    const timer = window.setTimeout(hideSecret, 60_000);
    return () => window.clearTimeout(timer);
  }, [revealed, hideSecret]);
  useOverlayCloseGuard(() => writePending.current);

  const persist = useMutation({
    networkMode: "always",
    mutationFn: async (purpose: EpaySecret | null) => {
      writePending.current = true;
      try {
        return purpose
          ? await rotateEpaySecret(site.client_id, purpose, configuration.revision)
          : await saveSiteEpay(site.client_id, values);
      } finally { writePending.current = false; }
    },
    onSuccess: async (saved, purpose) => {
      await queryClient.cancelQueries({ queryKey: siteEpayKey(site.client_id), exact: true });
      queryClient.setQueryData(siteEpayKey(site.client_id), saved);
      setDraft(null);
      clearDraft();
      setError(null);
      setRefreshRequired(false);
      setFeedback(purpose ? "密钥已更新，请下载最新配置并更新业务网站。" : "易支付设置已保存。");
    },
    onError: reason => {
      setError(reason instanceof Error ? reason : new Error("保存失败，请重新读取并核对。"));
      if (reason instanceof ApiError && reason.status === 409) setRefreshRequired(true);
    },
  });
  const busy = disabled || reading || pendingRead || persist.isPending;
  const blocked = busy || siteDirty || dirty;
  const selected = protocols.find(item => item.value === protocol)!;
  const protocolEnabled = protocol === "native" || (protocol === "epay_v1" ? configuration.v1_enabled : configuration.v2_enabled);
  const keysReady = protocol === "native" || (protocol === "epay_v1"
    ? !!configuration.v1_key_version
    : !!configuration.merchant_key_version && !!configuration.platform_key_version);
  const notifyError = urlError(notifyUrl, site.configuration.notification_origin, true);
  const returnError = urlError(returnUrl, site.configuration.return_origin, false);
  const fieldErrors = error instanceof ApiError ? error.fields : {};
  const notifyMessage = fieldErrors.notify_url ?? (validateUrls ? notifyError : null);
  const returnMessage = fieldErrors.return_url ?? (validateUrls ? returnError : null);
  const needsRefresh = refreshRequired || error instanceof ApiError && error.status === 409;
  const sitePath = "/sites/" + encodeURIComponent(site.client_id);
  const endpoint = protocol === "native" ? "/api/v1/orders" : protocol === "epay_v1" ? "/submit.php" : "/api/pay/submit";

  async function reloadConfiguration() {
    setRefreshRequired(true);
    try {
      const remote = await onReload();
      if (draft) {
        // With boolean fields, concurrent edits either agree or affect different
        // switches. Preserve only our edits and take untouched fields remotely.
        const merged: Switches = {
          revision: remote.revision,
          v1_enabled: draft.values.v1_enabled === draft.base.v1_enabled ? remote.v1_enabled : draft.values.v1_enabled,
          v2_enabled: draft.values.v2_enabled === draft.base.v2_enabled ? remote.v2_enabled : draft.values.v2_enabled,
        };
        if (merged.v1_enabled === remote.v1_enabled && merged.v2_enabled === remote.v2_enabled) {
          setDraft(null);
          clearDraft();
          setFeedback("配置已重新读取，当前修改已与服务器一致。");
        } else {
          setDraft({ base: remote, values: merged });
          setFeedback("配置已重新读取，已保留你的修改，请核对后保存。");
        }
      }
      setError(null);
      setRefreshRequired(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason : new Error("读取失败，请重试。"));
    }
  }

  async function read(purpose?: EpaySecret) {
    if (document.hidden || blocked || activeRead.current || writePending.current) return;
    if (!purpose) {
      setValidateUrls(true);
      setError(null);
      setFeedback("");
      if (notifyError || returnError) {
        (notifyError ? notifyInput : returnInput).current?.focus();
        return;
      }
    }
    const controller = new AbortController();
    activeRead.current = controller;
    const current = ++generation.current;
    setPendingRead(true);
    setRevealed(null);
    setError(null);
    setFeedback("");
    try {
      if (purpose) {
        const secret = await viewEpaySecret(site.client_id, purpose, controller.signal);
        if (current === generation.current && !controller.signal.aborted && !document.hidden) setRevealed({ purpose, ...secret });
      } else {
        const blob = await exportSiteIntegration(site.client_id, {
          protocol, site_revision: site.revision, epay_revision: configuration.revision,
          notify_url: notifyUrl.trim(), ...(returnUrl.trim() ? { return_url: returnUrl.trim() } : {}),
        }, controller.signal);
        if (current !== generation.current || controller.signal.aborted || document.hidden) return;
        const url = URL.createObjectURL(blob);
        downloadUrl.current = url;
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = "perpay-" + site.client_id + "-" + protocol + ".env";
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        setFeedback("配置已下载，放入 Demo 目录并命名为 .env 后启动。");
        window.setTimeout(() => {
          URL.revokeObjectURL(url);
          if (downloadUrl.current === url) downloadUrl.current = null;
        }, 1000);
      }
    } catch (reason) {
      if (current === generation.current && !controller.signal.aborted) {
        setError(reason instanceof Error ? reason : new Error("请求失败，请重试。"));
        if (reason instanceof ApiError && reason.status === 409) setRefreshRequired(true);
      }
    } finally {
      if (activeRead.current === controller) { activeRead.current = null; setPendingRead(false); }
    }
  }

  const purposes: EpaySecret[] = protocol === "epay_v1" ? ["epay_v1"] : ["epay_merchant", "epay_platform"];
  return <Card>
    <CardHeader>
      <CardTitle>网站接入助手</CardTitle>
      <CardDescription>选择接入协议，下载配置后用 Demo 完成下单和通知联调。</CardDescription>
    </CardHeader>
    <CardContent className="flex min-w-0 flex-col gap-5">
      <ToggleGroup aria-label="接入协议" value={[protocol]} variant="outline" className="max-w-full flex-wrap"
        disabled={busy} onValueChange={value => { if (value[0]) {
          setProtocol(value[0] as IntegrationProtocol); setFeedback("");
          if (fieldErrors.notify_url || fieldErrors.return_url) setError(null);
        } }}>
        {protocols.map(item => <ToggleGroupItem key={item.value} value={item.value}>{item.label}</ToggleGroupItem>)}
      </ToggleGroup>
      <p className="text-sm text-muted-foreground">{selected.description}</p>
      <ErrorNotice error={error} />
      {Object.entries(fieldErrors).filter(([field]) => field !== "notify_url" && field !== "return_url").map(([field, message]) =>
        <p key={field} className="text-sm text-destructive">{message}</p>)}
      {needsRefresh && <Button type="button" variant="outline" className="self-start" disabled={busy} onClick={() => {
        void reloadConfiguration();
      }}>重新读取配置</Button>}
      {siteDirty && <Alert><AlertDescription>网站配置有未保存的修改，请先保存或撤销，再管理密钥或下载配置。</AlertDescription></Alert>}
      <FieldGroup>
        <Field>
          <FieldLabel>{protocol === "native" ? "PerPay 服务地址" : "易支付网关"}</FieldLabel>
          {configuration.public_origin
            ? <CopyValue value={configuration.public_origin.replace(/\/$/, "") + (protocol === "native" ? "" : "/")} label="复制接入地址" />
            : <FieldDescription>请先配置服务端公开地址。</FieldDescription>}
        </Field>
        {(showClientId || protocol !== "native") && <Field>
          <FieldLabel>{protocol === "native" ? "客户端 ID" : "商户 PID"}</FieldLabel>
          <CopyValue value={protocol === "native" ? site.api_client_id ?? site.client_id : configuration.pid} label="复制接入身份" />
        </Field>}
        {protocol !== "native" && <Field orientation="horizontal">
          <FieldLabel htmlFor={id + "-enabled"}>允许{selected.label}新订单</FieldLabel>
          <Switch id={id + "-enabled"} checked={protocol === "epay_v1" ? values.v1_enabled : values.v2_enabled}
            disabled={busy || siteDirty} onCheckedChange={enabled => {
              const base = draft?.base ?? configuration;
              const changed = { revision: base.revision,
                v1_enabled: protocol === "epay_v1" ? enabled : values.v1_enabled,
                v2_enabled: protocol === "epay_v2" ? enabled : values.v2_enabled };
              setDraft(changed.v1_enabled === base.v1_enabled && changed.v2_enabled === base.v2_enabled ? null : { base, values: changed });
            }} />
        </Field>}
      </FieldGroup>
      {dirty && <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={busy || siteDirty || needsRefresh} onClick={() => persist.mutate(null)}>保存易支付设置</Button>
        <Button type="button" variant="outline" disabled={busy} onClick={() => { setDraft(null); clearDraft(); }}>撤销易支付修改</Button>
      </div>}
      {protocol !== "native" && <div className="flex flex-wrap gap-2">
        {purposes.map(purpose => <div key={purpose} className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" disabled={blocked} onClick={() => { void read(purpose); }}>查看{secretLabels[purpose]}</Button>
          <Button type="button" variant="outline" disabled={blocked} onClick={() => setRotation(purpose)}>生成／轮换{secretLabels[purpose]}</Button>
        </div>)}
      </div>}
      {revealed && <FieldGroup>
        <Field><FieldLabel>{secretLabels[revealed.purpose]}</FieldLabel><CopyValue value={revealed.secret} secret /></Field>
        {revealed.public_key && <Field><FieldLabel>对应公钥</FieldLabel><CopyValue value={revealed.public_key} /></Field>}
        <Button type="button" variant="outline" className="self-start" onClick={hideSecret}>隐藏密钥</Button>
      </FieldGroup>}
      <FieldGroup>
        <FieldDescription>以下地址临时填写，随下载写入 Demo 配置文件。</FieldDescription>
        <Field data-invalid={!!notifyMessage}>
          <FieldLabel htmlFor={id + "-notify"}>Demo 通知地址</FieldLabel>
          <Input ref={notifyInput} id={id + "-notify"} type="url" value={notifyUrl} disabled={busy} placeholder="https://demo.example.com/webhooks/perpay"
            aria-invalid={!!notifyMessage} aria-describedby={id + "-notify-description"} onChange={event => {
              setNotifyUrl(event.target.value);
              if (fieldErrors.notify_url || fieldErrors.return_url) setError(null);
            }} />
          <FieldDescription id={id + "-notify-description"}>{notifyMessage ?? "接收付款通知的完整 HTTPS 地址。"}</FieldDescription>
        </Field>
        <Field data-invalid={!!returnMessage}>
          <FieldLabel htmlFor={id + "-return"}>Demo 返回地址（可选）</FieldLabel>
          <Input ref={returnInput} id={id + "-return"} type="url" value={returnUrl} disabled={busy} placeholder="https://demo.example.com/return"
            aria-invalid={!!returnMessage} aria-describedby={id + "-return-description"} onChange={event => {
              setReturnUrl(event.target.value);
              if (fieldErrors.notify_url || fieldErrors.return_url) setError(null);
            }} />
          <FieldDescription id={id + "-return-description"}>{returnMessage ?? "付款后返回 Demo 的完整 HTTPS 地址。"}</FieldDescription>
        </Field>
      </FieldGroup>
      {!protocolEnabled && <p className="text-sm text-muted-foreground">此协议已暂停新订单。</p>}
      {!keysReady && <p className="text-sm text-muted-foreground">接入密钥尚未就绪，请重新读取配置或生成所需密钥。</p>}
      {!site.configuration.notifications_enabled && <p className="text-sm text-muted-foreground">当前通知已暂停，联调前请在网站设置中开启。</p>}
      {(!site.configuration.notification_origin || !site.configuration.notifications_enabled) &&
        <Link to={sitePath + "/edit?section=integration"} className="self-start">完善网站通知设置</Link>}
      <div className="flex flex-col gap-2">
        <Button type="button" className="self-start" disabled={blocked || needsRefresh || !keysReady || !configuration.public_origin}
          onClick={() => { void read(); }}>{pendingRead ? <Spinner data-icon="inline-start" /> : <Download data-icon="inline-start" />}下载完整配置</Button>
        <p className="text-sm text-muted-foreground">文件包含当前网站密钥，请存放在服务端并避免提交到公开仓库。</p>
      </div>
      {feedback && <p role="status">{feedback}</p>}
      <FieldGroup>
        <Field><FieldLabel>Demo 客户端调用</FieldLabel>
          <FieldDescription>{protocol === "native" ? "原生下单 POST " : "页面下单 GET/POST "}{endpoint}。下载配置后运行 npm start，可在 Demo 网页创建订单。</FieldDescription>
          <CopyValue value={demoExample} />
        </Field>
      </FieldGroup>
    </CardContent>
    <CardFooter className="flex flex-wrap gap-2">
      <Link to={sitePath + "/orders"} className={buttonVariants({ variant: "outline" })}>查看网站订单</Link>
      <Link to={sitePath + "/notifications"} className={buttonVariants({ variant: "outline" })}>查看通知记录</Link>
      <a data-external-link href="https://github.com/Mashiro0619/PerPay/tree/main/examples/node-client" target="_blank" rel="noopener noreferrer"
        className={buttonVariants({ variant: "outline" })}>获取 Demo</a>
    </CardFooter>
    <AlertDialog open={rotation !== null} onOpenChange={open => { if (!open) setRotation(null); }}>
      <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>生成或轮换{rotation ? secretLabels[rotation] : "密钥"}？</AlertDialogTitle>
        <AlertDialogDescription>新密钥立即用于后续请求或通知。请同步更新业务网站的配置，已有插件需替换对应密钥。</AlertDialogDescription>
      </AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel>
        <AlertDialogAction disabled={blocked} onClick={() => { if (rotation && !blocked) { persist.mutate(rotation); setRotation(null); } }}>确认更新</AlertDialogAction>
      </AlertDialogFooter></AlertDialogContent>
    </AlertDialog>
  </Card>;
}
