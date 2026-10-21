import { useQuery } from "@tanstack/react-query";
import { CircleAlert } from "lucide-react";
import { useParams } from "react-router";
import { api, result, type AdminLedgerDetail, type AdminLedgerMatch, type AdminLedgerSource } from "@/api/client";
import { Link, useDetailBack } from "@/navigation";
import { label } from "@/lib/labels";
import { useOptionalSystemStatus } from "@/features/system-status";
import { PageHeading } from "@/components/page-heading";
import { PageHeaderActions } from "@/components/page-header-actions";
import { RefreshButton } from "@/components/refresh-button";
import { QueryView } from "@/components/request-state";
import { LedgerFreshness } from "@/components/ledger-freshness";
import { LedgerDirection, LedgerMoney, ledgerFact } from "@/components/ledger-record";
import { ListDateTime } from "@/components/list-primitives";
import { DetailCredentials, DetailFields, DetailNavigation, DetailPage } from "@/components/detail/DetailPrimitives";
import { RecordTools } from "@/components/detail/RecordTools";
import { CopyValue } from "@/components/copy-value";
import { StatusBadge } from "@/components/business-status";
import { buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Item, ItemActions, ItemContent, ItemGroup, ItemHeader } from "@/components/ui/item";

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
    <DetailNavigation back={back} global>
      <PageHeaderActions><RefreshButton busy={query.isFetching} onClick={() => { void query.refetch(); if (system) void system.status.refetch(); }} /></PageHeaderActions>
    </DetailNavigation>
    <QueryView query={query}>{({ data }) => <>
      <LedgerWarnings entry={data} />
      <Card data-ledger-summary>
        <CardHeader className="flex min-w-0 flex-col gap-2 @3xl/main:grid">
          <CardTitle role="heading" aria-level={2}>支付宝交易</CardTitle>
          <CardDescription>支付宝账单中的这笔交易</CardDescription>
          <CardAction className="flex max-w-full flex-wrap items-center gap-2">
            <Badge variant="outline">{data.environment === "SANDBOX" ? "沙箱环境" : "生产环境"}</Badge>
            <RecordTools inline data={data} identifiers={[["内部流水编号（PerPay）", data.ledger_entry_id], ["支付宝流水号", data.external_event_id]]} label="支付宝流水记录操作" />
          </CardAction>
        </CardHeader>
        <CardContent className="flex min-w-0 flex-col gap-6">
          <DetailFields density="comfortable" layout="flow" wide={["支付宝备注"]} items={[
            ["交易金额", <LedgerMoney entry={data} />],
            ["收支方向", <LedgerDirection value={data.direction} disputed={!data.content_consistent} />],
            ["交易时间", data.occurred_at ? <ListDateTime value={data.occurred_at} inline /> : data.content_consistent ? "—" : "有争议"],
            ["对方", ledgerFact(data.other_account)],
            ["支付宝备注", ledgerFact(data.memo)],
          ]} />
          <DetailCredentials title="支付宝交易编号" items={[
            ["支付宝流水号", <CopyValue value={data.external_event_id} label="复制支付宝流水号" />],
            ["支付宝订单号", <LedgerIdentifier value={data.provider_order_no} name="支付宝订单号" />],
            ["支付宝商户单号", <LedgerIdentifier value={data.merchant_order_no} name="支付宝商户单号" />],
          ]} />
          <LedgerFreshness size="default" value={system && !system.checking && !system.unavailable ? system.status.data?.data.ledger.last_success_at : undefined} />
        </CardContent>
      </Card>
      <LedgerMatches entry={data} />
      <section className="flex min-w-0 flex-col gap-4" aria-labelledby="ledger-sources-heading">
        <div className="flex min-w-0 flex-col gap-2">
          <h2 id="ledger-sources-heading" className="text-base font-semibold">查账记录（{data.sources.length}）</h2>
          <p className="text-sm text-muted-foreground">{data.content_consistent
            ? data.sources.length > 1
              ? "PerPay 保存了多份相同的交易信息，按一笔流水展示。下面保留每份记录的编号和处理入口。"
              : "PerPay 查账后保存的记录，交易信息见上方；可用下面的编号核对或处理。"
            : data.conflicts.length
              ? "账单信息存在差异，下面逐份保留查账时保存的内容；冲突中的原始内容可从对应详情核对。"
              : "账单信息存在差异，下面逐份列出保存的不同版本。"}</p>
        </div>
        {data.content_consistent
          ? <ItemGroup>{data.sources.map((source, index) => <LedgerSource key={source.ledger_entry_id} source={source} index={index} consistent />)}</ItemGroup>
          : data.sources.map((source, index) => <LedgerSource key={source.ledger_entry_id} source={source} index={index} consistent={false} />)}
      </section>
      <LedgerConflicts entry={data} />
    </>}</QueryView>
  </DetailPage>;
}

function LedgerWarnings({ entry }: { entry: AdminLedgerDetail }) {
  const pending = entry.conflicts.filter(conflict => conflict.status === "OPEN").length;
  if (entry.content_consistent && !pending && entry.active_match_count <= 1) return null;
  return <Alert variant={pending || entry.active_match_count > 1 ? "destructive" : "default"} data-ledger-warning>
    <CircleAlert />
    <AlertTitle>{entry.active_match_count > 1 ? "同一笔流水关联了多个订单" : pending ? "有查账记录需要核对" : "账单信息存在不同版本"}</AlertTitle>
    <AlertDescription className="text-foreground!">
      {entry.active_match_count > 1 && <p>有 {entry.active_match_count} 条收款关联仍生效，无法确定唯一对应的订单。下面列出全部关联，请核对后处理。</p>}
      {!entry.content_consistent && <p>保存的账单信息出现过差异，不能把其中一份当作确定结果，也不能相加金额。下方保留各份查账记录{entry.conflicts.length > 0 ? "和冲突详情。" : "。"}</p>}
      {pending > 0 && <p>还有 {pending} 条账本冲突待处理，请查看页面下方的冲突记录。</p>}
    </AlertDescription>
  </Alert>;
}

function LedgerSource({ source, index, consistent }: { source: AdminLedgerSource; index: number; consistent: boolean }) {
  const heading = <h3 className="text-sm font-medium">查账记录 {index + 1}</h3>;
  const actions = <div className="flex max-w-full flex-wrap items-center gap-2">
    <span className="flex flex-wrap items-center gap-2"><span className="text-sm text-muted-foreground">PerPay 记录状态</span><Badge variant="secondary">{label(source.state)}</Badge></span>
    <Link global to={"/reconciliation/ledger/" + source.ledger_entry_id} className={buttonVariants({ variant: "outline", size: "sm" })}>查看记录与处理</Link>
    <RecordTools inline data={source} identifiers={[["内部流水编号（PerPay）", source.ledger_entry_id], ["原始事件编号", source.raw_event_id], ["支付宝 App ID", source.app_id], ["采集来源标识", source.provider_account_key], ["语义指纹", source.semantic_fingerprint]]} label={"查账记录 " + (index + 1) + " 操作"} />
  </div>;
  if (consistent) return <Item variant="outline" role="listitem" className="min-w-0 items-start" data-ledger-source={source.ledger_entry_id}>
    <ItemContent className="min-w-0 gap-4">
      <ItemHeader className="flex-wrap items-start gap-3">{heading}<ItemActions className="max-w-full flex-wrap">{actions}</ItemActions></ItemHeader>
      <DetailFields density="comfortable" layout="flow" items={[
        ["内部流水编号（PerPay）", <CopyValue value={source.ledger_entry_id} label="复制内部流水编号（PerPay）" />],
        ["保存时间", <ListDateTime value={source.created_at} inline />],
      ]} />
    </ItemContent>
  </Item>;
  return <Card data-ledger-source={source.ledger_entry_id}>
    <CardHeader className="flex min-w-0 flex-col gap-2 @3xl/main:grid">
      <CardTitle role="heading" aria-level={3}>查账记录 {index + 1}</CardTitle>
      <CardDescription>这份记录中保存的支付宝交易信息</CardDescription>
      <CardAction>{actions}</CardAction>
    </CardHeader>
    <CardContent className="flex min-w-0 flex-col gap-6">
      <DetailFields density="comfortable" layout="flow" wide={["支付宝备注"]} items={[
        ["交易金额", <LedgerMoney entry={{ ...source, content_consistent: true }} />],
        ["收支方向", <LedgerDirection value={source.direction} />],
        ["交易时间", <ListDateTime value={source.occurred_at} inline />],
        ["对方", source.other_account],
        ["保存时间", <ListDateTime value={source.created_at} inline />],
        ["支付宝备注", source.memo],
      ]} />
      <DetailCredentials title="这份记录的编号" headingLevel={4} items={[
        ["内部流水编号（PerPay）", <CopyValue value={source.ledger_entry_id} label="复制内部流水编号（PerPay）" />],
        ["支付宝订单号", <LedgerIdentifier value={source.provider_order_no} name="来源支付宝订单号" />],
        ["支付宝商户单号", <LedgerIdentifier value={source.merchant_order_no} name="来源支付宝商户单号" />],
      ]} />
    </CardContent>
  </Card>;
}

function LedgerMatches({ entry }: { entry: AdminLedgerDetail }) {
  const current = entry.matches.filter(match => match.status === "SETTLED");
  const history = entry.matches.filter(match => match.status === "REVERSED");
  return <section className="flex min-w-0 flex-col gap-4" aria-labelledby="ledger-matches-heading">
    <h2 id="ledger-matches-heading" className="text-base font-semibold">对应订单</h2>
    {entry.active_match_count === 0 && <Card data-ledger-unmatched>
      <CardHeader>
        <CardTitle role="heading" aria-level={3}>{history.length ? "当前没有对应的收款订单" : "未关联收款订单"}</CardTitle>
        <CardDescription>{entry.direction === "DEBIT" ? "这是支付宝支出流水，不对应收款订单。" : "目前没有用这笔流水确认任何网站订单的收款。如需核对，请打开下方的查账记录。"}{history.length > 0 && " 之前的关联已撤销，历史记录仍保留在下面。"}</CardDescription>
      </CardHeader>
    </Card>}
    {current.map(match => <LedgerMatch key={match.payment_match_id} match={match} index={entry.matches.indexOf(match)} multiple={entry.active_match_count > 1} />)}
    {history.length > 0 && <>
      <h3 className="text-sm font-medium">已撤销的历史关联（{history.length}）</h3>
      {history.map(match => <LedgerMatch key={match.payment_match_id} match={match} index={entry.matches.indexOf(match)} multiple={false} />)}
    </>}
  </section>;
}

function LedgerMatch({ match, index, multiple }: { match: AdminLedgerMatch; index: number; multiple: boolean }) {
  const reversed = match.status === "REVERSED";
  return <Card data-ledger-match={match.payment_match_id}>
    <CardHeader className="flex min-w-0 flex-col gap-2 @3xl/main:grid">
      <CardTitle role="heading" aria-level={3} className="wrap-anywhere">{match.product_name}</CardTitle>
      <CardDescription>{match.evidence_type === "MANUAL" ? "管理员根据支付宝流水人工关联" : "PerPay 按金额和付款时间推断，自动关联"}{reversed ? "；这次关联已撤销，当前不再生效。" : "，用于确认这个订单的收款。"}</CardDescription>
      <CardAction className="flex max-w-full flex-wrap items-center gap-2">
        <Badge variant={reversed ? "secondary" : multiple ? "destructive" : "success"}>{reversed ? "已撤销" : multiple ? "仍生效 · 请核对" : "已关联订单"}</Badge>
        <Link global to={"/orders/" + match.order_id} className={buttonVariants({ variant: "outline", size: "sm" })} aria-label={"查看订单：" + match.merchant_order_no}>查看订单</Link>
        <RecordTools inline data={match} identifiers={[["收款关联编号", match.payment_match_id], ["内部流水编号（PerPay）", match.ledger_entry_id], ["内部订单编号（PerPay）", match.order_id], ["客户端 ID", match.api_client_id]]} label={"关联记录 " + (index + 1) + " 记录操作"} />
      </CardAction>
    </CardHeader>
    <CardContent className="flex min-w-0 flex-col gap-4">
      <DetailFields density="comfortable" layout="flow" wide={["商户订单号（业务网站）"]} items={[
        ["所属网站", match.site_name ?? "名称不可用"],
        ["关联时间", <ListDateTime value={match.created_at} inline />],
        ...(reversed ? [["撤销时间", <ListDateTime value={match.resolved_at} inline />] as const] : []),
        ["商户订单号（业务网站）", <CopyValue value={match.merchant_order_no} label="复制商户订单号（业务网站）" />],
      ]} />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Link global to={"/reconciliation/matches/" + match.payment_match_id} className={buttonVariants({ variant: "link", size: "sm" })}>查看收款关联</Link>
        <Link global to={"/reconciliation/ledger/" + match.ledger_entry_id} className={buttonVariants({ variant: "link", size: "sm" })}>核对使用的查账记录</Link>
      </div>
    </CardContent>
  </Card>;
}

function LedgerConflicts({ entry }: { entry: AdminLedgerDetail }) {
  if (!entry.conflicts.length) return null;
  return <section className="flex min-w-0 flex-col gap-4" aria-labelledby="ledger-conflicts-heading">
    <h2 id="ledger-conflicts-heading" className="text-base font-semibold">账本冲突记录（{entry.conflicts.length}）</h2>
    {entry.conflicts.map(conflict => <Card key={conflict.conflict_id} data-ledger-conflict>
      <CardHeader className="flex min-w-0 flex-col gap-2 @3xl/main:grid">
        <CardTitle role="heading" aria-level={3}>{label(conflict.conflict_type)}</CardTitle>
        <CardDescription>查账时发现的问题及其处理结果</CardDescription>
        <CardAction className="flex max-w-full flex-wrap items-center gap-2">
          <StatusBadge value={conflict.status} label={conflict.status === "OPEN" ? "待处理" : conflict.status === "IGNORED" ? "已确认隔离" : "已处理"} />
          <Link global to={"/reconciliation/conflicts/" + conflict.conflict_id} className={buttonVariants({ variant: "outline", size: "sm" })}>查看冲突记录</Link>
          <RecordTools inline data={conflict} identifiers={[["账本冲突编号", conflict.conflict_id], ["关联内部流水编号（PerPay）", conflict.existing_ledger_entry_id]]} label="账本冲突记录操作" />
        </CardAction>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-6">
        <DetailFields density="comfortable" layout="flow" items={[
          ["发现时间", <ListDateTime value={conflict.created_at} inline />],
          ["处理时间", <ListDateTime value={conflict.resolved_at} inline />],
        ]} />
        <DetailCredentials title="问题对应的记录" headingLevel={4} items={[
          ["关联内部流水编号（PerPay）", <LedgerIdentifier value={conflict.existing_ledger_entry_id} name="冲突关联内部流水编号（PerPay）" />],
        ]} />
      </CardContent>
    </Card>)}
  </section>;
}
