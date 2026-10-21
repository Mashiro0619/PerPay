import { useQuery } from "@tanstack/react-query";
import { CircleAlert } from "lucide-react";
import { useParams } from "react-router";
import { api, result, type AdminLedgerDetail, type AdminLedgerSource } from "@/api/client";
import { Link, useDetailBack } from "@/navigation";
import { label } from "@/lib/labels";
import { useOptionalSystemStatus } from "@/features/system-status";
import { PageHeading } from "@/components/page-heading";
import { PageHeaderActions } from "@/components/page-header-actions";
import { RefreshButton } from "@/components/refresh-button";
import { QueryView } from "@/components/request-state";
import { LedgerFreshness } from "@/components/ledger-freshness";
import { LedgerActiveOrder, LedgerDirection, LedgerMoney, LedgerOrderLink, LedgerStates, ledgerFact, ledgerHasAnomaly } from "@/components/ledger-record";
import { ListDateTime } from "@/components/list-primitives";
import { DetailFields, DetailNavigation, DetailPage } from "@/components/detail/DetailPrimitives";
import { RecordTools } from "@/components/detail/RecordTools";
import { CopyValue } from "@/components/copy-value";
import { StatusBadge } from "@/components/business-status";
import { buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

function LedgerIdentifier({ value, name }: { value: string | null; name: string }) {
  return value ? <CopyValue value={value} label={"复制" + name} /> : <>—</>;
}

export default function LedgerDetail() {
  const { ledgerEntryId = "" } = useParams();
  const back = useDetailBack("/ledger", "返回支付宝流水");
  const system = useOptionalSystemStatus();
  const query = useQuery({ queryKey: ["administrator-ledger-detail", ledgerEntryId], queryFn: ({ signal }) => result(api.getAdministratorLedgerEntry({ signal, path: { ledgerEntryId } })) });
  return <DetailPage>
    <PageHeading title="支付宝流水详情" />
    <DetailNavigation back={back} global identifier={ledgerEntryId} identifierLabel="归组流水编号">
      <PageHeaderActions><RefreshButton busy={query.isFetching} onClick={() => { void query.refetch(); if (system) void system.status.refetch(); }} /></PageHeaderActions>
    </DetailNavigation>
    <QueryView query={query}>{({ data }) => <>
      {ledgerHasAnomaly(data) && <Alert variant="destructive"><CircleAlert /><AlertTitle>流水需要核查</AlertTitle><AlertDescription className="text-foreground!">
        {!data.content_consistent && <p>采集来源的交易信息有差异，有争议的字段不合并显示。请核对下方全部采集来源。</p>}
        {data.conflicts.length > 0 && <p>这笔流水存在账本冲突，请从冲突记录查看处理情况。</p>}
        {data.active_match_count > 1 && <p>存在 {data.active_match_count} 条生效关联，无法确定唯一的实际关联订单。</p>}
      </AlertDescription></Alert>}
      <Card size="sm" data-ledger-summary>
        <CardHeader className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="min-w-0 flex-1 basis-full @sm/card-header:basis-0">
            <CardTitle role="heading" aria-level={2} className="wrap-anywhere">{data.external_event_id}</CardTitle>
            <CardDescription>支付宝流水号 · {data.environment === "SANDBOX" ? "沙箱环境" : "生产环境"}</CardDescription>
          </div>
          <div className="flex max-w-full flex-wrap items-center gap-x-3 gap-y-2">
            <LedgerStates entry={data} />
            <RecordTools inline data={data} identifiers={[["归组流水编号", data.ledger_entry_id], ["支付宝流水号", data.external_event_id]]} label="支付宝流水记录操作" />
          </div>
        </CardHeader>
        <CardContent className="flex min-w-0 flex-col gap-3">
          <DetailFields density="dense" wide={["备注", "支付宝订单号", "流水商户订单号", "实际关联订单"]} items={[
            ["交易金额", <LedgerMoney entry={data} />],
            ["收支方向", <LedgerDirection value={data.direction} disputed={!data.content_consistent} />],
            ["交易时间", data.occurred_at ? <ListDateTime value={data.occurred_at} inline /> : data.content_consistent ? "—" : "有争议"],
            ["对方", ledgerFact(data.other_account)],
            ["备注", ledgerFact(data.memo)],
            ["支付宝订单号", <LedgerIdentifier value={data.provider_order_no} name="支付宝订单号" />],
            ["流水商户订单号", <LedgerIdentifier value={data.merchant_order_no} name="流水商户订单号" />],
            ["实际关联订单", <LedgerActiveOrder entry={data} />],
          ]} />
          <LedgerFreshness value={system && !system.checking && !system.unavailable ? system.status.data?.data.ledger.last_success_at : undefined} />
        </CardContent>
      </Card>
      <section className="flex min-w-0 flex-col gap-3" aria-labelledby="ledger-sources-heading">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id="ledger-sources-heading" className="text-base font-semibold">采集来源（{data.sources.length}）</h2>
          <p className="text-sm text-muted-foreground">每条采集记录保留独立凭据。需要处理时，进入对应的原始凭据。</p>
        </div>
        {data.sources.map((source, index) => <LedgerSource key={source.ledger_entry_id} source={source} index={index} />)}
      </section>
      <LedgerMatches entry={data} />
      <section className="flex min-w-0 flex-col gap-3" aria-labelledby="ledger-conflicts-heading">
        <h2 id="ledger-conflicts-heading" className="text-base font-semibold">账本冲突（{data.conflicts.length}）</h2>
        {data.conflicts.length ? data.conflicts.map(conflict => <Card size="sm" key={conflict.conflict_id} data-ledger-conflict>
          <CardHeader className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
              <CardTitle role="heading" aria-level={3}>{label(conflict.conflict_type)}</CardTitle>
              <StatusBadge value={conflict.status} label={conflict.status === "OPEN" ? "待处理" : undefined} />
            </div>
            <Link global to={"/reconciliation/conflicts/" + conflict.conflict_id} className={buttonVariants({ variant: "outline", size: "sm" })}>查看冲突记录</Link>
          </CardHeader>
          <CardContent><DetailFields density="dense" wide={["关联原始流水编号"]} items={[
            ["发现时间", <ListDateTime value={conflict.created_at} inline />],
            ["处理时间", <ListDateTime value={conflict.resolved_at} inline />],
            ["关联原始流水编号", <LedgerIdentifier value={conflict.existing_ledger_entry_id} name="冲突关联原始流水编号" />],
          ]} /></CardContent>
        </Card>) : <p className="text-sm text-muted-foreground">暂无账本冲突。</p>}
      </section>
    </>}</QueryView>
  </DetailPage>;
}

function LedgerSource({ source, index }: { source: AdminLedgerSource; index: number }) {
  return <Card size="sm" data-ledger-source={source.ledger_entry_id}>
    <CardHeader className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <CardTitle role="heading" aria-level={3}>采集来源 {index + 1}</CardTitle>
        <Badge variant="secondary">{label(source.state)}</Badge>
      </div>
      <div className="flex max-w-full flex-wrap items-center gap-2">
        <Link global to={"/reconciliation/ledger/" + source.ledger_entry_id} className={buttonVariants({ variant: "outline", size: "sm" })}>查看原始凭据与处理</Link>
        <RecordTools inline data={source} identifiers={[["原始流水编号", source.ledger_entry_id], ["原始事件编号", source.raw_event_id], ["采集来源标识", source.provider_account_key], ["语义指纹", source.semantic_fingerprint]]} label={"采集来源 " + (index + 1) + " 记录操作"} />
      </div>
    </CardHeader>
    <CardContent><DetailFields density="dense" wide={["原始流水编号", "备注", "支付宝订单号", "流水商户订单号", "支付宝 App ID"]} items={[
      ["交易金额", <LedgerMoney entry={{ ...source, content_consistent: true }} />],
      ["收支方向", <LedgerDirection value={source.direction} />],
      ["交易时间", <ListDateTime value={source.occurred_at} inline />],
      ["对方", source.other_account],
      ["接入环境", source.environment === "SANDBOX" ? "沙箱环境" : "生产环境"],
      ["采集时间", <ListDateTime value={source.created_at} inline />],
      ["原始流水编号", <CopyValue value={source.ledger_entry_id} label="复制原始流水编号" />],
      ["备注", source.memo],
      ["支付宝订单号", <LedgerIdentifier value={source.provider_order_no} name="来源支付宝订单号" />],
      ["流水商户订单号", <LedgerIdentifier value={source.merchant_order_no} name="来源流水商户订单号" />],
      ["支付宝 App ID", <CopyValue value={source.app_id} label="复制支付宝 App ID" />],
    ]} /></CardContent>
  </Card>;
}

function LedgerMatches({ entry }: { entry: AdminLedgerDetail }) {
  return <section className="flex min-w-0 flex-col gap-3" aria-labelledby="ledger-matches-heading">
    <h2 id="ledger-matches-heading" className="text-base font-semibold">关联记录（{entry.matches.length}）</h2>
    {entry.matches.length ? entry.matches.map(match => <Card size="sm" key={match.payment_match_id} data-ledger-match={match.payment_match_id}>
      <CardHeader className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-1 basis-full flex-col gap-1 @sm/card-header:basis-0">
          <CardTitle role="heading" aria-level={3} className="wrap-anywhere">{match.product_name}</CardTitle>
          <CardDescription className="flex flex-wrap items-center gap-2"><StatusBadge value={match.status} /><StatusBadge value={match.evidence_type} />{match.status === "SETTLED" && entry.active_match?.payment_match_id === match.payment_match_id && <Badge variant="success">当前实际关联</Badge>}</CardDescription>
        </div>
        <div className="flex max-w-full flex-wrap items-center gap-2">
          <Link global to={"/reconciliation/matches/" + match.payment_match_id} className={buttonVariants({ variant: "outline", size: "sm" })}>查看关联记录</Link>
          <Link global to={"/reconciliation/ledger/" + match.ledger_entry_id} className={buttonVariants({ variant: "ghost", size: "sm" })}>查看关联凭据</Link>
        </div>
      </CardHeader>
      <CardContent><DetailFields density="dense" wide={["关联订单", "原始流水编号"]} items={[
        ["业务网站", match.site_name ?? match.api_client_id],
        ["关联时间", <ListDateTime value={match.created_at} inline />],
        ["撤销时间", match.status === "REVERSED" ? <ListDateTime value={match.resolved_at} inline /> : "—"],
        ["关联订单", <LedgerOrderLink match={match} />],
        ["原始流水编号", <CopyValue value={match.ledger_entry_id} label="复制关联原始流水编号" />],
      ]} /></CardContent>
    </Card>) : <p className="text-sm text-muted-foreground">暂无关联记录。</p>}
  </section>;
}
