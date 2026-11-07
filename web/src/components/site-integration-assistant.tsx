import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ChevronDown, ExternalLink } from "lucide-react";
import { ApiError, queryClient, type Site } from "@/api/client";
import {
  getSiteEpay, rotateEpaySecret, saveSiteEpay, siteEpayKey, viewEpaySecret,
  type EpaySecret, type IntegrationProtocol, type SiteEpayConfiguration,
} from "@/api/integration";
import { useDirtyDraft } from "@/drafts";
import { useOverlayCloseGuard } from "@/lib/overlay-context";
import { Link } from "@/navigation";
import { CopyValue } from "@/components/copy-value";
import { ErrorNotice, Loading } from "@/components/request-state";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
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
}

const protocols = [
  { value: "native", label: "原生 API" },
  { value: "epay_v1", label: "易支付 V1" },
  { value: "epay_v2", label: "易支付 V2" },
] as const;

const secretLabels: Record<EpaySecret, string> = {
  epay_v1: "V1 密钥", epay_merchant: "V2 商户私钥", epay_platform: "V2 平台私钥",
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
  const [error, setError] = useState<Error | null>(null);
  const [refreshRequired, setRefreshRequired] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [pendingRead, setPendingRead] = useState(false);
  const [revealed, setRevealed] = useState<{ purpose: EpaySecret; secret: string; public_key?: string | null; publicOnly?: boolean } | null>(null);
  const [rotation, setRotation] = useState<EpaySecret | null>(null);
  const activeRead = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const writePending = useRef(false);

  const hideSecret = useCallback(() => {
    generation.current++;
    activeRead.current?.abort();
    activeRead.current = null;
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
    setPendingRead(true);
    setRevealed(null);
    setError(null);
    setFeedback("");
    try {
      const secret = await viewEpaySecret(site.client_id, purpose, controller.signal);
      if (current === generation.current && !controller.signal.aborted && !document.hidden) {
        if (publicOnly && !secret.public_key) throw new Error("未读取到平台公钥，请重试。");
        setRevealed({ purpose, secret: publicOnly ? "" : secret.secret, public_key: secret.public_key, publicOnly });
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
  const revealedKey = revealed && <FieldGroup className="min-w-0 gap-3">
    <Field>
      <FieldLabel>{revealed.publicOnly ? "平台公钥" : secretLabels[revealed.purpose]}</FieldLabel>
      <CopyValue value={revealed.publicOnly ? revealed.public_key! : revealed.secret} secret={!revealed.publicOnly} />
    </Field>
    {!revealed.publicOnly && revealed.public_key && <Field><FieldLabel>对应公钥</FieldLabel><CopyValue value={revealed.public_key} /></Field>}
    <Button type="button" variant="outline" className="self-start" onClick={hideSecret}>隐藏密钥</Button>
  </FieldGroup>;
  const maintenanceSecret = revealed?.purpose === "epay_platform" && !revealed.publicOnly;
  return <Card data-site-integration>
    <CardHeader>
      <CardTitle>网站接入助手</CardTitle>
    </CardHeader>
    <CardContent className="@container/integration flex min-w-0 flex-col gap-5">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <ToggleGroup aria-label="接入协议" value={[protocol]} variant="outline" spacing={0} className="max-w-full flex-wrap"
          disabled={busy} onValueChange={value => { if (value[0]) {
            setProtocol(value[0] as IntegrationProtocol); setFeedback("");
          } }}>
          {protocols.map(item => <ToggleGroupItem key={item.value} value={item.value}>{item.label}</ToggleGroupItem>)}
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
      <ErrorNotice error={error} />
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
      {!keysReady && <Alert><AlertDescription>接入密钥尚未就绪，请重新读取配置或在密钥管理中生成。</AlertDescription></Alert>}
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
        : <FieldGroup className="gap-3">
          <Field orientation="horizontal">
            <FieldLabel>{protocol === "epay_v1" ? "商户密钥" : "商户私钥"}</FieldLabel>
            <Button type="button" variant="outline" aria-label={"查看" + secretLabels[protocol === "epay_v1" ? "epay_v1" : "epay_merchant"]}
              disabled={blocked} onClick={() => { void read(protocol === "epay_v1" ? "epay_v1" : "epay_merchant"); }}>查看</Button>
          </Field>
          {protocol === "epay_v2" && <Field orientation="horizontal">
            <FieldLabel>平台公钥</FieldLabel>
            <Button type="button" variant="outline" aria-label="查看V2 平台公钥" disabled={blocked}
              onClick={() => { void read("epay_platform", true); }}>查看</Button>
          </Field>}
        </FieldGroup>}
      {!maintenanceSecret && revealedKey}
      {protocol !== "native" && <div className="flex min-w-0 flex-col">
          <Separator />
          <Collapsible key={protocol} onOpenChange={open => { if (!open) hideSecret(); }}>
            <CollapsibleTrigger render={<Button variant="ghost" className="w-full justify-between aria-expanded:[&_svg]:rotate-180" />}>
              密钥管理<ChevronDown data-icon="inline-end" />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <FieldGroup className="gap-3 pt-3 pb-4">
                {purposes.map(purpose => <Field key={purpose} orientation="horizontal">
                  <FieldLabel>{secretLabels[purpose]}</FieldLabel>
                  <div className="flex shrink-0 gap-2">
                    {purpose === "epay_platform" && <Button type="button" variant="outline" aria-label="查看V2 平台私钥" disabled={blocked}
                      onClick={() => { void read(purpose); }}>查看</Button>}
                    <Button type="button" variant="outline" aria-label={"更新" + secretLabels[purpose]} disabled={blocked}
                      onClick={() => setRotation(purpose)}>更新</Button>
                  </div>
                </Field>)}
                {maintenanceSecret && revealedKey}
              </FieldGroup>
            </CollapsibleContent>
          </Collapsible>
      </div>}
    </CardContent>
    <CardFooter className="flex flex-wrap gap-2">
      <a data-external-link href={documentation} target="_blank" rel="noopener noreferrer"
        className={buttonVariants({ variant: "outline" })}><ExternalLink data-icon="inline-start" />接入文档</a>
      <Link to={sitePath + "/orders"} className={buttonVariants({ variant: "outline" })}>查看网站订单</Link>
      <Link to={sitePath + "/notifications"} className={buttonVariants({ variant: "outline" })}>查看通知记录</Link>
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
