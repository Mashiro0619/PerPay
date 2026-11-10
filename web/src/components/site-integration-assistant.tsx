import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { ApiError, queryClient, type Site } from "@/api/client";
import {
  getSiteEpay, rotateEpaySecret, saveSiteEpay, siteEpayKey, viewEpaySecret,
  type EpaySecret, type IntegrationProtocol, type SiteEpayConfiguration,
} from "@/api/integration";
import { useDirtyDraft } from "@/drafts";
import { useOverlayCloseGuard } from "@/lib/overlay-context";
import { Link } from "@/navigation";
import { CopyValue } from "@/components/copy-value";
import { SecretViewDialog } from "@/components/secret-view-dialog";
import { ErrorNotice, Loading } from "@/components/request-state";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
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
  onProtocolChange?: (protocol: IntegrationProtocol) => void;
  selectedProtocol?: IntegrationProtocol;
}

const protocols = [
  { value: "native", label: "原生 API" },
  { value: "epay_v1", label: "易支付 V1" },
  { value: "epay_v2", label: "易支付 V2" },
] as const;

const secretLabels: Record<EpaySecret, string> = {
  epay_v1: "商户密钥", epay_merchant: "商户私钥", epay_platform: "平台私钥",
};
const rotationDescriptions: Record<EpaySecret, string> = {
  epay_v1: "旧商户密钥将立即失效。请同步更新业务网站的商户密钥。",
  epay_merchant: "旧商户私钥将不能用于新请求。请同步更新业务网站的商户私钥。",
  epay_platform: "响应和通知将改用新平台私钥签名。请同步更新业务网站的平台公钥。",
};

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

function IntegrationContent({ site, siteDirty = false, disabled = false, showClientId = true, onProtocolChange, selectedProtocol,
  configuration, reading, onReload }: AssistantProps & {
    configuration: SiteEpayConfiguration; reading: boolean; onReload: () => Promise<SiteEpayConfiguration>;
  }) {
  const id = useId();
  const [localProtocol, setProtocol] = useState<IntegrationProtocol>("native");
  const protocol = selectedProtocol ?? localProtocol;
  type Switches = Pick<SiteEpayConfiguration, "revision" | "v1_enabled" | "v2_enabled">;
  const [draft, setDraft] = useState<{ base: Switches; values: Switches } | null>(null);
  const values = draft?.values ?? configuration;
  const dirty = draft !== null;
  const clearDraft = useDirtyDraft(dirty);
  const [error, setError] = useState<Error | null>(null);
  const [refreshRequired, setRefreshRequired] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [pendingRead, setPendingRead] = useState<{ purpose: EpaySecret; publicOnly: boolean } | null>(null);
  const [viewing, setViewing] = useState<{ purpose: EpaySecret; publicOnly: boolean } | null>(null);
  const [readError, setReadError] = useState<Error | null>(null);
  const [revealed, setRevealed] = useState<{ purpose: EpaySecret; secret: string; public_key?: string | null; publicOnly?: boolean } | null>(null);
  const [rotation, setRotation] = useState<EpaySecret | null>(null);
  const activeRead = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const writePending = useRef(false);
  const viewTrigger = useRef<HTMLButtonElement | null>(null);
  const rotationTrigger = useRef<HTMLButtonElement | null>(null);

  const hideSecret = useCallback(() => {
    generation.current++;
    activeRead.current?.abort();
    activeRead.current = null;
    setPendingRead(null);
    setRevealed(null);
    setViewing(null);
    setReadError(null);
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
      setFeedback(purpose ? "密钥已更新，请更新业务网站配置。" : "易支付设置已保存。");
      if (purpose) setRotation(null);
    },
    onError: reason => {
      setError(reason instanceof Error ? reason : new Error("保存失败，请重新读取并核对。"));
      if (reason instanceof ApiError && reason.status === 409) setRefreshRequired(true);
    },
  });
  const busy = disabled || reading || pendingRead !== null || persist.isPending;
  const blocked = busy || siteDirty || dirty;
  const selected = protocols.find(item => item.value === protocol)!;
  const keyReady = (purpose: EpaySecret) => !!(purpose === "epay_v1" ? configuration.v1_key_version
    : purpose === "epay_merchant" ? configuration.merchant_key_version : configuration.platform_key_version);
  const protocolEnabled = protocol === "native" || (protocol === "epay_v1" ? configuration.v1_enabled : configuration.v2_enabled);
  const keysReady = protocol === "native" || (protocol === "epay_v1"
    ? !!configuration.v1_key_version
    : !!configuration.merchant_key_version && !!configuration.platform_key_version);
  const fieldErrors = error instanceof ApiError ? error.fields : {};
  const needsRefresh = refreshRequired || error instanceof ApiError && error.status === 409;
  const sitePath = "/sites/" + encodeURIComponent(site.client_id);
  const documentation = "https://github.com/Mashiro0619/PerPay/blob/main/docs/" +
    (protocol === "native" ? "integration-quickstart.md" : "epay-integration.md");

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

  async function read(purpose: EpaySecret, publicOnly = false) {
    if (document.hidden || blocked || activeRead.current || writePending.current) return;
    const controller = new AbortController();
    activeRead.current = controller;
    const current = ++generation.current;
    setViewing({ purpose, publicOnly });
    setPendingRead({ purpose, publicOnly });
    setRevealed(null);
    setReadError(null);
    setFeedback("");
    try {
      const secret = await viewEpaySecret(site.client_id, purpose, controller.signal);
      if (current === generation.current && !controller.signal.aborted && !document.hidden) {
        if (publicOnly && !secret.public_key) throw new Error("未读取到平台公钥，请重试。");
        setRevealed({ purpose, secret: publicOnly ? "" : secret.secret, public_key: secret.public_key, publicOnly });
      }
    } catch (reason) {
      if (current === generation.current && !controller.signal.aborted) {
        setReadError(reason instanceof Error ? reason : new Error("请求失败，请重试。"));
        if (reason instanceof ApiError && reason.status === 409) setRefreshRequired(true);
      }
    } finally {
      if (activeRead.current === controller) { activeRead.current = null; setPendingRead(null); }
    }
  }

  function credential(purpose: EpaySecret, publicOnly = false) {
    const label = publicOnly ? "平台公钥" : secretLabels[purpose];
    const rotationLabel = (keyReady(purpose) ? "轮换" : "生成") + label;
    const labelId = id + "-" + purpose + (publicOnly ? "-public" : "");
    return <Field key={labelId} aria-labelledby={labelId} className="min-w-0">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <FieldLabel id={labelId}>{label}</FieldLabel>
        <div className="flex shrink-0 gap-2">
          <Button type="button" variant="outline" aria-label={"查看" + label}
            disabled={blocked} onClick={event => { viewTrigger.current = event.currentTarget; void read(purpose, publicOnly); }}>
            查看
          </Button>
          {!publicOnly && <Button type="button" variant="outline" aria-label={rotationLabel}
            disabled={blocked || needsRefresh} onClick={event => {
              rotationTrigger.current = event.currentTarget;
              persist.reset(); setError(null); setRotation(purpose);
            }}>{keyReady(purpose) ? "轮换" : "生成"}</Button>}
        </div>
      </div>
    </Field>;
  }
  return <Card data-site-integration>
    <CardHeader>
      <CardTitle>网站接入助手</CardTitle>
    </CardHeader>
    <CardContent className="@container/integration flex min-w-0 flex-col gap-5">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <ToggleGroup aria-label="接入协议" value={[protocol]} variant="outline" spacing={1} className="max-w-full flex-wrap"
          disabled={busy} onValueChange={value => { if (value[0]) {
            setProtocol(value[0] as IntegrationProtocol); onProtocolChange?.(value[0] as IntegrationProtocol); setFeedback("");
          } }}>
          {protocols.map(item => <ToggleGroupItem key={item.value} value={item.value} className="px-1.5">{item.label}</ToggleGroupItem>)}
        </ToggleGroup>
        {protocol !== "native" && <Field orientation="horizontal" className="w-auto gap-2">
          <FieldLabel htmlFor={id + "-enabled"}>允许新订单</FieldLabel>
          <Switch id={id + "-enabled"} aria-label={"允许" + selected.label + "新订单"}
            checked={protocol === "epay_v1" ? values.v1_enabled : values.v2_enabled}
            disabled={busy || siteDirty} onCheckedChange={enabled => {
              const base = draft?.base ?? configuration;
              const changed = { revision: base.revision,
                v1_enabled: protocol === "epay_v1" ? enabled : values.v1_enabled,
                v2_enabled: protocol === "epay_v2" ? enabled : values.v2_enabled };
              setDraft(changed.v1_enabled === base.v1_enabled && changed.v2_enabled === base.v2_enabled ? null : { base, values: changed });
            }} />
        </Field>}
      </div>
      <ErrorNotice error={rotation ? null : error} />
      {Object.entries(fieldErrors).map(([field, message]) =>
        <p key={field} className="text-sm text-destructive">{message}</p>)}
      {needsRefresh && <Button type="button" variant="outline" className="self-start" disabled={busy} onClick={() => {
        void reloadConfiguration();
      }}>重新读取配置</Button>}
      {siteDirty && <Alert><AlertDescription>网站配置有未保存的修改，请先保存或撤销，再管理密钥。</AlertDescription></Alert>}
      {dirty && <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={busy || siteDirty || needsRefresh} onClick={() => persist.mutate(null)}>保存易支付设置</Button>
        <Button type="button" variant="outline" disabled={busy} onClick={() => { setDraft(null); clearDraft(); }}>撤销易支付修改</Button>
      </div>}
      {!protocolEnabled && <p role="status">此协议已暂停新订单。</p>}
      {!keysReady && <Alert><AlertDescription>接入密钥尚未就绪，请生成对应密钥。</AlertDescription></Alert>}
      {feedback && <p role="status">{feedback}</p>}
      <FieldGroup className="grid min-w-0 grid-cols-1 gap-4 @lg/integration:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
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
      </FieldGroup>
      {protocol === "native"
        ? showClientId && <Link to={sitePath + "/edit?section=integration"} className={buttonVariants({ variant: "outline", className: "self-start" })}>管理 API 与通知密钥</Link>
        : <FieldGroup className="min-w-0 gap-4">
          {credential(protocol === "epay_v1" ? "epay_v1" : "epay_merchant")}
          {protocol === "epay_v2" && <>{credential("epay_platform", true)}{credential("epay_platform")}</>}
        </FieldGroup>}
    </CardContent>
    <CardFooter className="flex flex-wrap gap-2">
      <a data-external-link href={documentation} target="_blank" rel="noopener noreferrer"
        className={buttonVariants({ variant: "outline" })}><ExternalLink data-icon="inline-start" />接入文档</a>
      <Link to={sitePath + "/orders"} className={buttonVariants({ variant: "outline" })}>查看网站订单</Link>
      <Link to={sitePath + "/notifications"} className={buttonVariants({ variant: "outline" })}>查看通知记录</Link>
    </CardFooter>
    <SecretViewDialog open={viewing !== null} title={viewing?.publicOnly ? "平台公钥" : viewing ? secretLabels[viewing.purpose] : "查看密钥"}
      pending={pendingRead !== null} error={readError} onClose={hideSecret} finalFocus={() => viewTrigger.current}
      onRetry={() => { if (viewing) void read(viewing.purpose, viewing.publicOnly); }}
      values={revealed ? [
        { label: revealed.publicOnly ? "平台公钥" : secretLabels[revealed.purpose], value: revealed.publicOnly ? revealed.public_key! : revealed.secret },
        ...(!revealed.publicOnly && revealed.purpose === "epay_merchant" && revealed.public_key
          ? [{ label: "商户公钥", value: revealed.public_key }] : []),
      ] : []} />
    <AlertDialog open={rotation !== null} onOpenChange={(open, event) => {
      if (!open && persist.isPending) event.cancel();
      else if (!open) setRotation(null);
    }}>
      <AlertDialogContent finalFocus={() => rotationTrigger.current}><AlertDialogHeader>
        <AlertDialogTitle>{rotation && keyReady(rotation) ? "轮换" : "生成"}{rotation ? secretLabels[rotation] : "密钥"}？</AlertDialogTitle>
        <AlertDialogDescription>{rotation && keyReady(rotation) ? rotationDescriptions[rotation] : "生成后，请将接入密钥配置到业务网站。"}</AlertDialogDescription>
      </AlertDialogHeader>
      <ErrorNotice error={error} showDiagnostics={false} />
      {persist.isError && <p>请关闭后查看当前密钥，确认操作结果。</p>}
      <AlertDialogFooter><AlertDialogCancel disabled={persist.isPending}>{persist.isError ? "关闭" : "取消"}</AlertDialogCancel>
        <AlertDialogAction variant={rotation && keyReady(rotation) ? "destructive" : "default"}
          disabled={blocked || persist.isError} onClick={() => { if (rotation && !blocked && !persist.isError) persist.mutate(rotation); }}>
          {persist.isPending && <Spinner data-icon="inline-start" />}
          {persist.isPending ? "正在处理…" : rotation && keyReady(rotation) ? "确认轮换" : "生成密钥"}
        </AlertDialogAction>
      </AlertDialogFooter></AlertDialogContent>
    </AlertDialog>
  </Card>;
}
