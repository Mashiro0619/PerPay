import { useIsFetching, useQuery } from "@tanstack/react-query";
import { useLayoutEffect, useRef } from "react";
import { CircleAlert } from "lucide-react";
import { useLocation, useParams } from "react-router";
import { api, refreshOperationalData, result, type AdminLedgerDetail, type AdminLedgerMatch, type AdminLedgerSource } from "@/api/client";
import { Link, useDetailBack } from "@/navigation";
import { label } from "@/lib/labels";
import { actualPageAddress } from "@/lib/navigation-selection";
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
import { CandidateCard, MatchCard } from "@/components/detail/PaymentEvidence";
import { AssociateIncomeAction } from "@/components/detail/FinancialActions";
import { dateTime, money } from "@/lib/format";
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
  const back = useDetailBack("/reconciliation", "返回对账");
  const location = useLocation();
  const fetching = useIsFetching();
  const positioned = useRef<string | null>(null);
  const address = actualPageAddress(location) + location.hash;
  const system = useOptionalSystemStatus();
  const query = useQuery({ queryKey: ["administrator-ledger-detail", ledgerEntryId], queryFn: ({ signal }) => result(api.getAdministratorLedgerEntry({ signal, path: { ledgerEntryId } })) });
  useLayoutEffect(() => {
    if (!location.hash) { positioned.current = null; return; }
    if (!query.data || fetching || positioned.current === address) return;
    let id: string;
    try { id = decodeURIComponent(location.hash.slice(1)); } catch { return; }
    const target = document.getElementById(id);
    if (!target) return;
    positioned.current = address;
    target.scrollIntoView?.({ block: "start" });
    target.focus({ preventScroll: true });
  }, [query.data, fetching, location.hash, address]);
  return <DetailPage>
    <PageHeading title="流水与对账详情" />
    <DetailNavigation back={back} global>
      <PageHeaderActions><RefreshButton busy={fetching > 0} onClick={() => { void refreshOperationalData(); }} /></PageHeaderActions>
    </DetailNavigation>
    <QueryView query={query}>{({ data }) => <>
      <LedgerWarnings entry={data} />
      <Card data-ledger-summary>
        <CardHeader className="flex min-w-0 flex-col gap-2 @3xl/main:grid">
          <CardTitle role="heading" aria-level={2}>支付宝交易</CardTitle>
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
          {data.sources.length > 1 && <p className="text-sm text-muted-foreground">{data.content_consistent ? "多份采集记录对应同一笔交易。" : "各份采集记录存在差异，请逐份核对。"}</p>}
        </div>
        {data.content_consistent
          ? <ItemGroup>{data.sources.map((source, index) => <LedgerSource key={source.ledger_entry_id} source={source} index={index} consistent hasMatch={data.matches.some(match => match.ledger_entry_id === source.ledger_entry_id)} />)}</ItemGroup>
          : data.sources.map((source, index) => <LedgerSource key={source.ledger_entry_id} source={source} index={index} consistent={false} hasMatch={data.matches.some(match => match.ledger_entry_id === source.ledger_entry_id)} />)}
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
      {entry.active_match_count > 1 && <p>有 {entry.active_match_count} 条有效关联，无法确定唯一订单，请核对下方记录。</p>}
      {!entry.content_consistent && <p>账单记录有差异，请核对下方各版本；金额不可相加。</p>}
      {pending > 0 && <p>有 {pending} 条账本冲突待处理。</p>}
    </AlertDescription>
  </Alert>;
}

function LedgerSource({ source, index, consistent, hasMatch }: { source: AdminLedgerSource; index: number; consistent: boolean; hasMatch: boolean }) {
  const heading = <h3 className="text-sm font-medium">查账记录 {index + 1}</h3>;
  const actions = <div className="flex max-w-full flex-wrap items-center gap-2">
    <span className="flex flex-wrap items-center gap-2"><span className="text-sm text-muted-foreground">PerPay 记录状态</span><Badge variant="secondary">{label(source.state)}</Badge></span>
    {source.direction === "CREDIT" && ["UNALLOCATED", "CANDIDATE", "CONFLICT"].includes(source.state) && <AssociateIncomeAction ledgerId={source.ledger_entry_id} ledgerLabel={money(source.amount_cents) + " · " + dateTime(source.occurred_at)} />}
    <RecordTools inline data={source} identifiers={[["内部流水编号（PerPay）", source.ledger_entry_id], ["原始事件编号", source.raw_event_id], ["支付宝 App ID", source.app_id], ["采集来源标识", source.provider_account_key], ["语义指纹", source.semantic_fingerprint]]} label={"查账记录 " + (index + 1) + " 操作"} />
  </div>;
  if (consistent) return <Item id={"source-" + source.ledger_entry_id} tabIndex={-1} variant="outline" role="listitem" className="min-w-0 scroll-mt-16 items-start" data-ledger-source={source.ledger_entry_id}>
    <ItemContent className="min-w-0 gap-4">
      <ItemHeader className="flex-wrap items-start gap-3">{heading}<ItemActions className="max-w-full flex-wrap">{actions}</ItemActions></ItemHeader>
      <DetailFields density="comfortable" layout="flow" items={[
        ["内部流水编号（PerPay）", <CopyValue value={source.ledger_entry_id} label="复制内部流水编号（PerPay）" />],
        ["保存时间", <ListDateTime value={source.created_at} inline />],
      ]} />
      <LedgerSourceCandidates source={source} hasMatch={hasMatch} />
    </ItemContent>
  </Item>;
  return <Card id={"source-" + source.ledger_entry_id} tabIndex={-1} className="scroll-mt-16" data-ledger-source={source.ledger_entry_id}>
    <CardHeader className="flex min-w-0 flex-col gap-2 @3xl/main:grid">
      <CardTitle role="heading" aria-level={3}>查账记录 {index + 1}</CardTitle>
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
      <LedgerSourceCandidates source={source} hasMatch={hasMatch} />
    </CardContent>
  </Card>;
}

function LedgerSourceCandidates({ source, hasMatch }: { source: AdminLedgerSource; hasMatch: boolean }) {
  const query = useQuery({
    queryKey: ["ledger-candidates", source.ledger_entry_id],
    enabled: source.direction === "CREDIT",
    queryFn: ({ signal }) => result(api.listLedgerEntryCandidates({ signal, path: { ledgerEntryId: source.ledger_entry_id } })),
  });
  if (source.direction !== "CREDIT") return null;
  return <QueryView query={query}>{({ data }) => <>
    {data.filter(candidate => candidate.status !== "SELECTED" || !hasMatch).map(candidate => <div key={candidate.candidate_id} id={"candidate-" + candidate.candidate_id} tabIndex={-1} className="scroll-mt-16">
      <CandidateCard candidate={candidate} ledger={source} embedded transactionContext />
    </div>)}
  </>}</QueryView>;
}

function LedgerMatches({ entry }: { entry: AdminLedgerDetail }) {
  const current = entry.matches.filter(match => match.status === "SETTLED");
  const history = entry.matches.filter(match => match.status === "REVERSED");
  return <section className="flex min-w-0 flex-col gap-4" aria-labelledby="ledger-matches-heading">
    <h2 id="ledger-matches-heading" className="text-base font-semibold">对应订单</h2>
    {entry.active_match_count === 0 && <Card data-ledger-unmatched>
      <CardHeader>
        <CardTitle role="heading" aria-level={3}>{history.length ? "当前没有对应的收款订单" : "未关联收款订单"}</CardTitle>
        <CardDescription>{entry.direction === "DEBIT" ? "支出流水不关联收款订单。" : "可在对应查账记录中人工关联。"}</CardDescription>
      </CardHeader>
    </Card>}
    {current.map(match => <LedgerMatch key={match.payment_match_id} match={match} index={entry.matches.indexOf(match)} multiple={entry.active_match_count > 1} />)}
    {history.length > 0 && <>
      <h3 className="text-sm font-medium">已撤销的历史关联（{history.length}）</h3>
      {history.map(match => <LedgerMatch key={match.payment_match_id} match={match} index={entry.matches.indexOf(match)} multiple={false} />)}
    </>}
  </section>;
}

function LedgerMatch({ match, multiple }: { match: AdminLedgerMatch; index: number; multiple: boolean }) {
  const query = useQuery({
    queryKey: ["match", match.payment_match_id],
    queryFn: ({ signal }) => result(api.getPaymentMatch({ signal, path: { paymentMatchId: match.payment_match_id } })),
  });
  return <div id={"match-" + match.payment_match_id} tabIndex={-1} className="flex min-w-0 scroll-mt-16 flex-col gap-4" data-ledger-match={match.payment_match_id}>
    {multiple && <Badge variant="destructive" className="self-start">仍生效 · 存在多条关联</Badge>}
    <QueryView query={query}>{({ data }) => <MatchCard match={data} transactionContext />}</QueryView>
  </div>;
}

function LedgerConflicts({ entry }: { entry: AdminLedgerDetail }) {
  if (!entry.conflicts.length) return null;
  return <section className="flex min-w-0 flex-col gap-4" aria-labelledby="ledger-conflicts-heading">
    <h2 id="ledger-conflicts-heading" className="text-base font-semibold">账本冲突记录（{entry.conflicts.length}）</h2>
    {entry.conflicts.map(conflict => <Card key={conflict.conflict_id} data-ledger-conflict>
      <CardHeader className="flex min-w-0 flex-col gap-2 @3xl/main:grid">
        <CardTitle role="heading" aria-level={3}>{label(conflict.conflict_type)}</CardTitle>
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
