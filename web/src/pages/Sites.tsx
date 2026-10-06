import { useState } from "react";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { useParams } from "react-router";
import { api, ApiError, queryClient, result, type Site, type SiteConfiguration, type SitePolicy } from "@/api/client";
import { Link, useNavigate } from "@/navigation";
import { useDirtyDraft } from "@/drafts";
import { ErrorNotice, QueryView } from "@/components/request-state";
import { SuccessMessage, useFeedback } from "@/components/Feedback";
import { SitePolicyFields, SiteTextField } from "@/components/SitePolicyFields";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldSet } from "@/components/ui/field";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/admin-dialog";

export default function Sites() {
  const [search, setSearch] = useState("");
  const query = useInfiniteQuery({ queryKey: ["sites", search], initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => result(api.listSites({ query: { q: search, limit: 50, ...(pageParam ? { after: pageParam } : {}) }, signal })),
    getNextPageParam: page => page.page.next_cursor ?? undefined,
  });
  return <div className="flex flex-col gap-6">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-2xl font-semibold">业务网站</h2><div className="flex gap-2"><Link to="/sites/defaults" className={buttonVariants({ variant: "outline" })}>网站默认模板</Link><Link to="/sites/new" className={buttonVariants()}>创建网站</Link></div></div>
    <p className="text-sm text-muted-foreground">各网站独立接入与管理订单，共用实例的经营收款码、采集和对账。</p>
    <Input aria-label="搜索网站" placeholder="搜索网站名称或客户端 ID" maxLength={128} value={search} onChange={e => setSearch(e.target.value)} />
    <QueryView query={query}>{data => <>
      {data.pages.flatMap(page => page.data).map(site => <Card key={site.client_id}><CardHeader><CardTitle><Link to={"/sites/" + site.client_id}>{site.configuration.name}</Link></CardTitle><CardDescription className="break-all">{site.client_id}</CardDescription></CardHeader><CardContent className="flex flex-wrap gap-4"><span>{site.configuration.accepting_orders ? "接单中" : "已暂停接单"}</span><span>{site.configuration.notifications_enabled ? "通知已开启" : "通知已关闭"}</span></CardContent></Card>)}
      {!data.pages.some(page => page.data.length > 0) && <p>暂无匹配的业务网站。</p>}
      {query.hasNextPage && <Button variant="outline" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>加载更多</Button>}
    </>}</QueryView>
  </div>;
}

export function SiteEditorPage() {
  const { clientId } = useParams();
  const query = useQuery({ queryKey: ["site-editor", clientId ?? "new"], staleTime: Infinity, gcTime: clientId ? 5 * 60_000 : 0, refetchOnWindowFocus: false, refetchOnReconnect: false,
    queryFn: async ({ signal }): Promise<{ site: Site | null; configuration: SiteConfiguration }> => {
      if (clientId) { const response = await result(api.getSite({ path: { clientId }, signal })); return { site: response.data, configuration: response.data.configuration }; }
      const defaults = await result(api.getSiteDefaults({ signal }));
      return { site: null, configuration: { name: "", accepting_orders: true, notifications_enabled: false, notification_origin: null, return_origin: null, policy: structuredClone(defaults.data.policy) } };
    },
  });
  return <QueryView query={query}>{data => <SiteEditor key={clientId ?? "new"} initial={data.site} configuration={data.configuration} />}</QueryView>;
}
function SiteEditor({ initial, configuration }: { initial: Site | null; configuration: SiteConfiguration }) {
  const navigate = useNavigate();
  const [saved, setSaved] = useState(initial);
  const [draft, setDraft] = useState(() => structuredClone(configuration));
  const [baseline, setBaseline] = useState(() => JSON.stringify(configuration));
  const clearDraft = useDirtyDraft(JSON.stringify(draft) !== baseline);
  const [operationId] = useState(() => crypto.randomUUID());
  const [confirmation, setConfirmation] = useState<"save" | "api" | "webhook" | "delete" | null>(null);
  const [copyError, setCopyError] = useState<Error | null>(null);
  const [revealed, setRevealed] = useState<{ label: string; value: string } | null>(null);
  const [feedback, setFeedback] = useFeedback();
  const save = useMutation({ networkMode: "always", retry: false,
    mutationFn: async () => saved ? result(api.updateSite({ path: { clientId: saved.client_id }, body: { revision: saved.revision, configuration: draft } })) : result(api.createSite({ body: { operation_id: operationId, configuration: draft } })),
    onSuccess: response => {
      setSaved(response.data); setDraft(structuredClone(response.data.configuration)); setBaseline(JSON.stringify(response.data.configuration)); clearDraft(); setFeedback("网站配置已保存");
      void queryClient.invalidateQueries({ queryKey: ["sites"] });
      if (!saved) { void queryClient.invalidateQueries({ queryKey: ["settings"] }); void navigate("/sites/" + response.data.client_id); }
    },
  });
  const action = useMutation({ networkMode: "always", retry: false,
    mutationFn: async (kind: "api" | "webhook" | "view-api" | "view-webhook" | "delete"): Promise<void> => {
      if (!saved) return;
      const path = { clientId: saved.client_id };
      if (kind === "delete") { await result(api.deleteSite({ path, body: { revision: saved.revision } })); clearDraft(); void queryClient.invalidateQueries({ queryKey: ["sites"] }); void queryClient.invalidateQueries({ queryKey: ["settings"] }); void navigate("/sites"); return; }
      if (kind === "view-api" || kind === "view-webhook") {
        const response = await result(kind === "view-api" ? api.viewSiteApiSecret({ path, body: {} }) : api.viewSiteWebhookSecret({ path, body: {} }));
        setRevealed({ label: kind === "view-api" ? "API 密钥" : "通知签名密钥", value: response.data.secret }); return;
      }
      const response = await result(kind === "api" ? api.rotateSiteApiSecret({ path, body: { revision: saved.revision } }) : api.rotateSiteWebhookSecret({ path, body: { revision: saved.revision } }));
      setSaved(response.data.site); setRevealed({ label: kind === "api" ? "API 密钥" : "通知签名密钥", value: response.data.secret }); setFeedback("密钥已生成或轮换，请更新业务网站配置。");
    },
  });
  const errors = save.error instanceof ApiError ? save.error.fields : {};
  const busy = save.isPending || action.isPending;
  const change = (edit: (next: SiteConfiguration) => void) => { const next = structuredClone(draft); edit(next); setDraft(next); setFeedback(""); save.reset(); };
  return <div className="flex flex-col gap-6">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-2xl font-semibold">{saved ? "编辑业务网站" : "创建业务网站"}</h2><Link to="/sites" className={buttonVariants({ variant: "outline" })}>返回网站列表</Link></div>
    {saved && <Link to="/settings/onboarding/check" className={buttonVariants({ variant: "outline", className: "w-fit" })}>回到配置向导</Link>}
    <ErrorNotice error={save.error || action.error || copyError} /><SuccessMessage message={feedback} />
    {saved && <Card><CardHeader><CardTitle>接入信息</CardTitle><CardDescription>客户端 ID 不可修改。PerPay API 密钥不是支付宝开放平台密钥。</CardDescription></CardHeader><CardContent><FieldGroup><Field><FieldLabel>客户端 ID<Input readOnly value={saved.client_id} /></FieldLabel></Field><Field><FieldLabel>PerPay 地址<Input readOnly value={window.location.origin} /></FieldLabel></Field></FieldGroup></CardContent><CardFooter><Button variant="outline" onClick={() => void navigator.clipboard.writeText(JSON.stringify({ client_id: saved.client_id, perpay_url: window.location.origin }, null, 2)).then(() => setFeedback("接入信息已复制"), () => setCopyError(new Error("复制失败，请手动复制。")))}>复制接入信息</Button></CardFooter></Card>}
    <form onSubmit={event => { event.preventDefault(); setConfirmation("save"); }}><FieldSet disabled={busy}><Card><CardHeader><CardTitle>网站配置</CardTitle><CardDescription>保存后独立生效，不跟随网站默认模板变化。</CardDescription></CardHeader><CardContent><FieldGroup>
      <SiteTextField label="网站名称" required maxLength={40} value={draft.name} error={errors["configuration.name"]} onChange={text => change(p => { p.name = text; })} />
      <Field orientation="horizontal"><FieldLabel htmlFor="site-accepting">允许新订单</FieldLabel><Switch id="site-accepting" checked={draft.accepting_orders} onCheckedChange={value => change(p => { p.accepting_orders = value; })} /></Field><FieldDescription>关闭只暂停新订单，不影响已有订单的付款、查询、核实及通知。</FieldDescription>
      <Field orientation="horizontal"><FieldLabel htmlFor="site-notifications">开启通知</FieldLabel><Switch id="site-notifications" disabled={!saved} checked={draft.notifications_enabled} onCheckedChange={value => change(p => { p.notifications_enabled = value; })} /></Field><FieldDescription>先创建网站并生成通知签名密钥，再开启通知。</FieldDescription>
      <SiteTextField label="通知来源" type="url" placeholder="https://notify.example.com" value={draft.notification_origin ?? ""} error={errors["configuration.notification_origin"]} onChange={text => change(p => { p.notification_origin = text || null; })} />
      <SiteTextField label="返回来源" type="url" placeholder="https://shop.example.com" value={draft.return_origin ?? ""} error={errors["configuration.return_origin"]} onChange={text => change(p => { p.return_origin = text || null; })} />
      <FieldDescription>来源只填写 HTTPS 域名，不填写回调路径。修改通知来源不会重写旧订单的目标，旧目标可能不再允许投递。</FieldDescription>
      <SitePolicyFields value={draft.policy} errors={errors} onChange={policy => change(p => { p.policy = policy; })} />
    </FieldGroup></CardContent><CardFooter><Button type="submit" disabled={busy}>{save.isPending ? "正在保存…" : "保存网站"}</Button></CardFooter></Card></FieldSet></form>
    {saved && <Card><CardHeader><CardTitle>网站密钥与删除</CardTitle><CardDescription>轮换后旧密钥失效；删除仅允许没有历史订单的网站。</CardDescription></CardHeader><CardContent className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy} onClick={() => action.mutate("view-api")}>查看 API 密钥</Button><Button variant="outline" disabled={busy} onClick={() => setConfirmation("api")}>生成／轮换 API 密钥</Button><Button variant="outline" disabled={busy} onClick={() => action.mutate("view-webhook")}>查看通知密钥</Button><Button variant="outline" disabled={busy} onClick={() => setConfirmation("webhook")}>生成／轮换通知密钥</Button><Button variant="destructive" disabled={busy} onClick={() => setConfirmation("delete")}>删除空网站</Button></CardContent></Card>}
    {revealed && <Card><CardHeader><CardTitle>{revealed.label}</CardTitle><CardDescription>仅在当前页面显示，请勿发送给其他网站。</CardDescription></CardHeader><CardContent><Input aria-label={revealed.label} readOnly value={revealed.value} autoComplete="off" /></CardContent><CardFooter><Button variant="outline" onClick={() => { setRevealed(null); action.reset(); }}>隐藏密钥</Button></CardFooter></Card>}
    <AlertDialog open={confirmation !== null} onOpenChange={open => { if (!open) setConfirmation(null); }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>确认{confirmation === "delete" ? "删除网站" : confirmation === "save" ? "保存配置" : "生成或轮换密钥"}？</AlertDialogTitle><AlertDialogDescription>{confirmation === "delete" ? "此操作不能撤销，客户端 ID 不会再次使用。有历史订单的网站只能暂停接单。" : confirmation === "save" ? "网站参数将用于后续新订单和通知；历史金额、有效期和经营码关联不会修改。" : "如果已有密钥，本次会使其退役。请同步更新对应业务网站，失败时不要盲目再次轮换，应先查看当前密钥。"}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction disabled={busy} onClick={() => { const selected = confirmation; setConfirmation(null); if (selected === "save") save.mutate(); else if (selected) action.mutate(selected); }}>确认</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </div>;
}

export function SiteDefaultsPage() {
  const query = useQuery({ queryKey: ["site-defaults"], queryFn: ({ signal }) => result(api.getSiteDefaults({ signal })), staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false });
  return <QueryView query={query}>{response => <DefaultsEditor initial={response.data} />}</QueryView>;
}
function DefaultsEditor({ initial }: { initial: { revision: number; policy: SitePolicy } }) {
  const [saved, setSaved] = useState(initial);
  const [draft, setDraft] = useState(() => structuredClone(initial.policy));
  const clearDraft = useDirtyDraft(JSON.stringify(draft) !== JSON.stringify(saved.policy));
  const [feedback, setFeedback] = useFeedback();
  const save = useMutation({ networkMode: "always", retry: false, mutationFn: () => result(api.updateSiteDefaults({ body: { revision: saved.revision, policy: draft } })), onSuccess: response => { setSaved(response.data); setDraft(structuredClone(response.data.policy)); clearDraft(); setFeedback("模板已保存，已有网站不受影响。"); queryClient.setQueryData(["site-defaults"], response); } });
  return <div className="flex flex-col gap-6"><h2 className="text-2xl font-semibold">网站默认模板</h2><p>只用于以后创建网站时预填表单，不会覆盖已有网站。</p><ErrorNotice error={save.error} /><SuccessMessage message={feedback} /><form onSubmit={event => { event.preventDefault(); save.mutate(); }}><FieldSet disabled={save.isPending}><SitePolicyFields value={draft} errors={save.error instanceof ApiError ? save.error.fields : {}} onChange={setDraft} /><Button type="submit" disabled={save.isPending}>保存默认模板</Button></FieldSet></form></div>;
}
