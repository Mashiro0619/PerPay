import { useIsFetching, useQueries, useQuery, type UseQueryResult } from "@tanstack/react-query";
import { useLocation, useParams } from "react-router";
import { api, result, type AdminLedgerDetail, type AdminLedgerMatch, type AdminLedgerSource, type AdminOrderDetail, type MatchCandidate, type PaymentMatchEnvelope, type ReconciliationOrder } from "@/api/client";
import { candidateFacts, candidateFactsBeyondLedger, candidateGuidance } from "@/lib/detail-summary";
import { dateTime, money } from "@/lib/format";
import { label } from "@/lib/labels";
import { isReconciliationDetailQuery, refreshReconciliationDetails } from "@/lib/record-refresh";
import { Link, useDetailBack } from "@/navigation";
import { AlipayAccountIdentity } from "@/components/alipay-account-identity";
import { OrderStatusBadge, StatusBadge } from "@/components/business-status";
import { DetailNavigation, DetailPage, useRelatedOrder } from "@/components/detail/DetailPrimitives";
import { useAssociateIncome, useReverseMatch } from "@/components/detail/FinancialActions";
import { AccountLedgerFreshness } from "@/components/ledger-freshness";
import { LedgerState } from "@/components/ledger-record";
import { OverlaySummary } from "@/components/overlay-actions";
import { PageHeaderActions } from "@/components/page-header-actions";
import { PageHeading } from "@/components/page-heading";
import { ActionBar, technicalEntries } from "@/components/record/ActionBar";
import { Disclosure } from "@/components/record/Disclosure";
import { FieldList, type Field } from "@/components/record/FieldList";
import { RecordNotice, RecordSummary } from "@/components/record/RecordSummary";
import { Section, Sections } from "@/components/record/Sections";
import { SubRecord } from "@/components/record/SubRecord";
import { RecordTime } from "@/components/record/Timeline";
import { RefreshButton } from "@/components/refresh-button";
import { ErrorNotice, Loading, QueryView, ReadPausedNotice } from "@/components/request-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

type TextFact = "other_account" | "memo" | "provider_order_no" | "merchant_order_no";

const note = "text-[0.8125rem] leading-5 text-muted-foreground";
const disputed = <span className="text-destructive">有争议</span>;

/** "支付宝收款 · 对方"; the kind stays general while the sources dispute the direction. */
function ledgerTitle(entry: AdminLedgerDetail) {
  const kind = entry.direction === "CREDIT" ? "支付宝收款" : entry.direction === "DEBIT" ? "支付宝支出" : "支付宝交易";
  return entry.other_account ? kind + " · " + entry.other_account : kind;
}

/** The sources hold different values of a text the transaction as a whole cannot state. */
function disputes(entry: AdminLedgerDetail, fact: TextFact) {
  return entry[fact] === null && entry.sources.some(source => source[fact] !== null);
}

function isAssociable(source: AdminLedgerSource) {
  return source.direction === "CREDIT" && ["UNALLOCATED", "CANDIDATE", "CONFLICT"].includes(source.state);
}

function ledgerLabel(source: AdminLedgerSource) {
  return money(source.amount_cents) + " · " + dateTime(source.occurred_at);
}

function sourceIdentifiers(source: AdminLedgerSource): Array<readonly [string, string | null]> {
  return [["原始事件编号", source.raw_event_id], ["支付宝 App ID", source.app_id], ["采集来源标识", source.provider_account_key], ["语义指纹", source.semantic_fingerprint]];
}

/** What stands in for a part of the record while its own read is under way. */
function Pending({ query, label }: { query: { isPending: boolean; isPaused: boolean }; label: string }) {
  if (!query.isPending) return null;
  return query.isPaused ? <ReadPausedNotice /> : <Loading label={label} />;
}

export default function LedgerDetail() {
  const { ledgerEntryId = "" } = useParams();
  const back = useDetailBack("/reconciliation", "返回对账");
  const query = useQuery({ queryKey: ["administrator-ledger-detail", ledgerEntryId], queryFn: ({ signal }) => result(api.getAdministratorLedgerEntry({ signal, path: { ledgerEntryId } })) });
  const fetching = useIsFetching({ predicate: isReconciliationDetailQuery });
  return <DetailPage>
    <PageHeading title={query.data ? ledgerTitle(query.data.data) : "流水与对账详情"} />
    <DetailNavigation back={back} global>
      <PageHeaderActions><RefreshButton busy={fetching > 0} onClick={() => {
        void refreshReconciliationDetails();
      }} /></PageHeaderActions>
    </DetailNavigation>
    <QueryView query={query}>{({ data }) => <LedgerRecord key={data.ledger_entry_id} entry={data} />}</QueryView>
  </DetailPage>;
}

/** What Alipay reports about the transaction, apart from the amount, time and account in the summary. */
function transactionFields(entry: AdminLedgerDetail): Array<Field | false> {
  // While the versions differ, a text none of the sources states is left open: a version not listed here may hold it.
  const absent = (fact: TextFact) => disputes(entry, fact) ? disputed : entry.content_consistent ? "未提供" : "—";
  return [
    { label: "对方", value: entry.other_account ?? absent("other_account") },
    entry.memo ? { label: "支付宝备注", value: entry.memo } : disputes(entry, "memo") && { label: "支付宝备注", value: disputed },
    { label: "支付宝流水号", kind: "id", value: entry.external_event_id, copy: entry.external_event_id },
    entry.provider_order_no
      ? { label: "支付宝订单号", kind: "id", value: entry.provider_order_no, copy: entry.provider_order_no }
      : { label: "支付宝订单号", value: absent("provider_order_no") },
    entry.merchant_order_no
      ? { label: "支付宝商户单号", kind: "id", value: entry.merchant_order_no, copy: entry.merchant_order_no }
      : disputes(entry, "merchant_order_no") && { label: "支付宝商户单号", value: disputed },
  ];
}

/** PerPay's own record of one source, led by whatever the transaction as a whole could not state. */
function sourceFields(source: AdminLedgerSource, entry: AdminLedgerDetail, state: boolean): Array<Field | false> {
  return [
    state && { label: "PerPay 记录状态", value: <LedgerState value={source.state} /> },
    entry.amount_cents === null && { label: "交易金额", kind: "money", value: money(source.amount_cents) },
    entry.direction === null && { label: "收支方向", value: <StatusBadge value={source.direction} /> },
    entry.occurred_at === null && { label: "交易时间", kind: "time", value: <RecordTime value={source.occurred_at} /> },
    entry.other_account === null && !!source.other_account && { label: "对方", value: source.other_account },
    entry.memo === null && !!source.memo && { label: "支付宝备注", value: source.memo },
    entry.provider_order_no === null && !!source.provider_order_no && { label: "支付宝订单号", kind: "id", value: source.provider_order_no, copy: source.provider_order_no },
    entry.merchant_order_no === null && !!source.merchant_order_no && { label: "支付宝商户单号", kind: "id", value: source.merchant_order_no, copy: source.merchant_order_no },
    { label: "PerPay 流水编号", kind: "id", value: source.ledger_entry_id, copy: source.ledger_entry_id },
    { label: "保存时间", kind: "time", value: <RecordTime value={source.created_at} /> },
  ];
}

function orderPayment(order: ReconciliationOrder | AdminOrderDetail) {
  return "payment" in order ? order.payment.status : order.payment_status;
}

/** What an order says about itself, beside the amount of the entry it is paired with. */
function orderFields(order: ReconciliationOrder | AdminOrderDetail, amount: number): Array<Field | false> {
  const payment = orderPayment(order);
  const checkout = "checkout" in order ? order.checkout.status : order.checkout_status;
  const difference = amount - order.payable_amount_cents;
  return [
    { label: "应付金额", kind: "money", value: <>
      {money(order.payable_amount_cents)}
      {difference !== 0 && <span className="ml-1 font-normal text-destructive" data-amount-difference>（流水{difference > 0 ? "多" : "少"} {money(Math.abs(difference))}）</span>}
    </> },
    order.received_amount_cents !== null && { label: "实收金额", kind: "money", value: money(order.received_amount_cents) },
    { label: "订单收款状态", value: <span className="inline-flex flex-wrap items-center gap-1.5">
      <OrderStatusBadge payment={payment} checkout={checkout} refundMarked={"refund_mark" in order && order.refund_mark.marked} />
    </span> },
  ];
}

function siteField(clientId: string, name: string | null): Field {
  return { label: "业务网站", value: <Link global className="underline underline-offset-4" to={"/sites/" + encodeURIComponent(clientId) + "/summary"}>{name ?? "业务网站名称暂不可用"}</Link> };
}

/** A jump to one of the transaction's sources, named by its number. */
function SourceLink({ id, number }: { id: string; number: number }) {
  const anchor = "#source-" + id;
  const repeated = useLocation().hash === anchor;
  // The record locates a source when the address changes; a second use of the same link changes nothing, so it does the same itself.
  return <Link to={anchor} className="underline underline-offset-4" onClick={() => {
    const target = repeated ? document.getElementById(anchor.slice(1)) : null;
    target?.scrollIntoView?.({ block: "start", behavior: "instant" });
    target?.focus({ preventScroll: true });
  }}>采集记录 {number}</Link>;
}

function LedgerRecord({ entry }: { entry: AdminLedgerDetail }) {
  const current = entry.matches.filter(match => match.status === "SETTLED");
  const reversed = entry.matches.filter(match => match.status === "REVERSED");
  const multiple = entry.active_match_count > 1;
  const pending = entry.conflicts.filter(conflict => conflict.status === "OPEN").length;
  const several = entry.sources.length > 1;
  const numbers = new Map(entry.sources.map((source, index) => [source.ledger_entry_id, index + 1]));
  // Sources are only told apart where the transaction has more than one.
  const numberOf = (id: string | null) => several && id ? numbers.get(id) : undefined;
  // A payment is settled once, whichever of its copies holds the association: while one is in effect no copy takes another.
  const settled = entry.active_match_count > 0;
  const associable = settled ? [] : entry.sources.filter(isAssociable);
  // Copies that agree stand for one another, so the record as a whole offers the association, through the first of them.
  // Copies that differ have no such default: the administrator has to choose the one to rely on.
  const chosen = !several || entry.content_consistent ? associable[0] : undefined;
  // Each copy can still be used by name. Copies kept from accounts that no longer exist may be open to different orders.
  const perCopy = associable.length > 1 || !chosen;
  const associate = useAssociateIncome({ ledgerId: chosen?.ledger_entry_id ?? "", ledgerLabel: chosen ? ledgerLabel(chosen) : undefined });

  const matchQueries = useQueries({ queries: entry.matches.map(match => ({
    queryKey: ["match", match.payment_match_id],
    queryFn: ({ signal }: { signal: AbortSignal }) => result(api.getPaymentMatch({ signal, path: { paymentMatchId: match.payment_match_id } })),
  })) });
  const credit = entry.sources.filter(source => source.direction === "CREDIT");
  const candidateQueries = useQueries({ queries: credit.map(source => ({
    queryKey: ["ledger-candidates", source.ledger_entry_id],
    queryFn: ({ signal }: { signal: AbortSignal }) => result(api.listLedgerEntryCandidates({ signal, path: { ledgerEntryId: source.ledger_entry_id } })),
  })) });
  const offered = credit.flatMap((source, index) => (candidateQueries[index]?.data?.data ?? [])
    // An association already shows the candidate it selected.
    .filter(candidate => candidate.status !== "SELECTED" || !entry.matches.some(match => match.ledger_entry_id === source.ledger_entry_id))
    .map(candidate => ({ candidate, source })));
  const suggestions = offered.filter(item => item.candidate.status !== "SUPERSEDED");
  const superseded = offered.filter(item => item.candidate.status === "SUPERSEDED");
  const unassociated = !entry.matches.length && !offered.length && candidateQueries.every(query => query.data !== undefined && !query.error);

  const matchRecord = (match: AdminLedgerMatch) => <MatchRecord key={match.payment_match_id} match={match} query={matchQueries[entry.matches.indexOf(match)]!}
    source={numberOf(match.ledger_entry_id)} multiple={multiple && match.status === "SETTLED"} />;
  const candidateRecord = ({ candidate, source }: (typeof offered)[number]) => <CandidateRecord key={candidate.candidate_id} candidate={candidate} source={source} number={numberOf(source.ledger_entry_id)} settled={settled} />;

  return <>
    <OverlaySummary>
      <RecordSummary label="流水概况"
        value={entry.amount_cents === null ? entry.content_consistent ? "—" : "金额有争议"
          : (entry.direction === "CREDIT" ? "+" : entry.direction === "DEBIT" ? "−" : "") + money(entry.amount_cents)}
        size={entry.amount_cents === null ? "phrase" : "amount"} tone={entry.amount_cents === null && !entry.content_consistent ? "danger" : "default"}
        status={<>
          {entry.direction ? <StatusBadge value={entry.direction} /> : !entry.content_consistent && <Badge variant="destructive">收支方向有争议</Badge>}
          {/* An expense is never matched to an order, so it is not called unassociated. */}
          {(entry.direction !== "DEBIT" || entry.active_match_count > 0) && <Badge variant={multiple ? "destructive" : entry.active_match_count === 1 ? "success" : "secondary"}>
            {multiple ? "多笔关联" : entry.active_match_count === 1 ? "已关联" : "未关联"}
          </Badge>}
          {(!entry.content_consistent || pending > 0) && <Badge variant="destructive">需要核查</Badge>}
          {entry.environment === "SANDBOX" && <Badge variant="outline">沙箱环境</Badge>}
        </>}
        meta={[<>
          {entry.occurred_at ? <RecordTime value={entry.occurred_at} /> : entry.content_consistent ? "交易时间未知" : "交易时间有争议"}
          {" · "}<AlipayAccountIdentity id={entry.alipay_account_id} name={entry.alipay_account_name} />
        </>]}
        nav={[
          { id: "transaction", label: "交易信息" },
          { id: "payments", label: "对应订单", ...(current.length ? { count: current.length } : {}) },
          { id: "sources", label: "采集记录", count: entry.sources.length },
          ...(entry.conflicts.length ? [{ id: "conflicts", label: "账本冲突", count: entry.conflicts.length }] : []),
        ]} />
    </OverlaySummary>
    {(multiple || !entry.content_consistent || pending > 0) && <RecordNotice tone={multiple || pending > 0 ? "danger" : "warning"}
      jump={multiple ? { section: "payments", label: "核对各条关联" } : pending > 0 ? { section: "conflicts", label: "查看账本冲突" } : { section: "sources", label: "核对采集记录" }}>
      <p className="font-medium">{multiple ? "同一笔流水关联了多个订单" : !entry.content_consistent ? "账单信息存在不同版本" : `有 ${pending} 条账本冲突待处理`}</p>
      {multiple && <p>有 {entry.active_match_count} 条有效关联，无法确定唯一订单。</p>}
      {!entry.content_consistent && <p>各版本的账单内容不一致，请逐份核对；金额不可相加。</p>}
      {pending > 0 && (multiple || !entry.content_consistent) && <p>有 {pending} 条账本冲突待处理。</p>}
    </RecordNotice>}
    <Sections label="流水详情内容">
      <Section id="transaction" title="交易信息">
        <FieldList items={transactionFields(entry)} />
      </Section>
      <Section id="payments" title="对应订单" anchorPrefixes={["match-", "candidate-"]} {...(current.length ? { count: current.length } : {})}
        empty={unassociated ? entry.direction === "DEBIT" ? "支出流水不关联收款订单。"
          : associable.length && !chosen ? "尚未关联收款订单，可在要采用的采集记录上人工关联。" : "尚未关联收款订单。" : undefined}>
        {!current.length && <p className={note}>{reversed.length ? "原关联已撤销，当前没有对应的收款订单。" : "尚未关联收款订单。"}</p>}
        {current.map(matchRecord)}
        {candidateQueries.some(query => query.isPending) && <Pending query={{ isPending: true, isPaused: candidateQueries.some(query => query.isPending && query.isPaused) }} label="正在读取可能匹配的订单…" />}
        {candidateQueries.map((query, index) => <ErrorNotice key={credit[index]!.ledger_entry_id} scope="page" error={query.error} retainedData={query.data !== undefined}
          retry={() => { void query.refetch(); }} placeholder="可能匹配的订单读取失败，请刷新重试。" />)}
        {suggestions.map(candidateRecord)}
        {/* With nothing in effect, what was reversed is what the reader came for. */}
        {reversed.length > 0 && <Disclosure label="已撤销的关联" count={reversed.length} defaultOpen={!current.length}>{reversed.map(matchRecord)}</Disclosure>}
        {superseded.length > 0 && <Disclosure label="已替代的匹配建议" count={superseded.length}>{superseded.map(candidateRecord)}</Disclosure>}
      </Section>
      <Section id="sources" title="采集记录" count={entry.sources.length} {...(several ? { anchorPrefixes: ["source-"] } : {})}>
        {several
          ? <p className={note}>{entry.content_consistent ? "多份采集记录对应同一笔交易。" : "各份采集记录存在差异，请逐份核对。"}</p>
          : !entry.content_consistent && <p className={note}>这是 PerPay 保存的版本，与它不一致的版本见账本冲突。</p>}
        {entry.sources.map((source, index) => several
          ? <SourceRecord key={source.ledger_entry_id} source={source} entry={entry} number={index + 1} associable={perCopy && associable.includes(source)} />
          : <FieldList key={source.ledger_entry_id} items={sourceFields(source, entry, true)} />)}
        <AccountLedgerFreshness accountId={entry.alipay_account_id ?? null} />
      </Section>
      {entry.conflicts.length > 0 && <Section id="conflicts" title="账本冲突" count={entry.conflicts.length} anchorPrefixes={["conflict-"]}>
        {entry.conflicts.map(conflict => {
          const existing = conflict.existing_ledger_entry_id;
          const number = numberOf(existing);
          return <SubRecord key={conflict.conflict_id} id={"conflict-" + conflict.conflict_id} title={label(conflict.conflict_type)}
            status={<StatusBadge value={conflict.status} label={conflict.status === "OPEN" ? "待处理" : conflict.status === "IGNORED" ? "已确认隔离" : "已处理"} />}
            href={"/reconciliation/conflicts/" + conflict.conflict_id} hrefLabel="查看冲突记录">
            <FieldList items={[
              { label: "发现时间", kind: "time", value: <RecordTime value={conflict.created_at} /> },
              !!conflict.resolved_at && { label: "处理时间", kind: "time", value: <RecordTime value={conflict.resolved_at} /> },
              !!existing && !!number && { label: "涉及的采集记录", value: <SourceLink id={existing} number={number} /> },
              // A source of this transaction is already shown above; any other entry is named here.
              !!existing && !numbers.has(existing) && { label: "关联 PerPay 流水", kind: "id", value: existing, copy: existing },
            ]} />
          </SubRecord>;
        })}
      </Section>}
    </Sections>
    <ActionBar menuLabel="更多操作，流水操作"
      primary={chosen && <Button className="h-auto min-h-8 min-w-0 max-w-full whitespace-normal py-1.5" disabled={associate.action.disabled}
        onClick={event => associate.action.onSelect?.(event.currentTarget)}>{associate.action.label}</Button>}
      technical={technicalEntries([
        { title: "流水技术信息", created: entry.created_at, data: entry, identifiers: [
          ["PerPay 流水编号", entry.ledger_entry_id], ["支付宝流水号", entry.external_event_id],
          ...(several ? [] : entry.sources.flatMap(sourceIdentifiers)),
        ] },
        ...(several ? entry.sources.map((source, index) => ({
          id: "source-" + source.ledger_entry_id, title: `采集记录 ${index + 1} 技术信息`, created: source.created_at, data: source,
          identifiers: [["PerPay 流水编号", source.ledger_entry_id] as const, ...sourceIdentifiers(source)],
        })) : []),
        ...entry.matches.map((match, index) => {
          const detail = matchQueries[index]?.data?.data;
          return { id: "match-" + match.payment_match_id, title: "收款关联技术信息", created: match.created_at, data: detail ?? match, identifiers: [
            ["关联编号", match.payment_match_id], ["流水编号", match.ledger_entry_id], ["可能匹配记录编号", detail?.candidate_id ?? null],
            ["内部订单编号", match.order_id], ["网站编号", match.api_client_id],
          ] as const };
        }),
        ...offered.map(({ candidate }) => ({
          id: "candidate-" + candidate.candidate_id, title: "匹配记录技术信息", created: candidate.created_at, data: candidate,
          identifiers: [["可能匹配记录编号", candidate.candidate_id]] as const,
        })),
        ...entry.conflicts.map(conflict => ({
          id: "conflict-" + conflict.conflict_id, title: "账本冲突技术信息", created: conflict.created_at, data: conflict,
          identifiers: [["账本冲突编号", conflict.conflict_id], ["关联 PerPay 流水", conflict.existing_ledger_entry_id]] as const,
        })),
      ])} />
    {associate.dialog}
  </>;
}

/** One of several sources. Its own association ties the order to this copy and no other. */
function SourceRecord({ source, entry, number, associable }: { source: AdminLedgerSource; entry: AdminLedgerDetail; number: number; associable: boolean }) {
  const associate = useAssociateIncome({ ledgerId: source.ledger_entry_id, ledgerLabel: ledgerLabel(source), actionLabel: "用这份记录关联" });
  return <SubRecord id={"source-" + source.ledger_entry_id} title={"采集记录 " + number} status={<LedgerState value={source.state} />}
    actions={associable ? [associate.action] : []} actionsLabel={`更多操作，采集记录 ${number} 操作`}>
    <FieldList items={sourceFields(source, entry, false)} />
    {associate.dialog}
  </SubRecord>;
}

/**
 * One association between this entry and an order. The order's name and the
 * state of the association are known with the entry; the rest is read on its own.
 */
function MatchRecord({ match, query, source, multiple }: {
  match: AdminLedgerMatch;
  query: UseQueryResult<PaymentMatchEnvelope, Error>;
  /** Number of the source the association uses, when the transaction has several. */
  source?: number | undefined;
  /** Still in effect beside another association of the same entry. */
  multiple: boolean;
}) {
  const detail = query.data?.data;
  const operation = detail?.creation_operation;
  const reversal = detail?.status === "REVERSED" ? detail.resolution_operation : null;
  // A reversed association moves into the collapsed history, taking its trigger with it.
  const reverse = useReverseMatch(detail, true);
  return <SubRecord id={"match-" + match.payment_match_id} title={match.product_name}
    status={<><StatusBadge value={match.status} />{multiple && <Badge variant="destructive">存在多条关联</Badge>}</>}
    description={<>
      {match.evidence_type === "MANUAL" ? "管理员人工关联" + (detail ? " · " + (operation?.actor_id ?? "未记录") : "") : "PerPay 按金额和付款时间推断"}
      {" · "}<RecordTime value={operation?.created_at ?? match.created_at} />
    </>}
    href={"/orders/" + match.order_id} hrefLabel="查看订单"
    // The entry may report the reversal before the association's own read does.
    actions={match.status === "SETTLED" && reverse.action ? [reverse.action] : []} actionsLabel="更多操作，收款关联记录操作">
    <FieldList items={[
      { label: "商户订单号", kind: "id", value: match.merchant_order_no, copy: match.merchant_order_no },
      siteField(match.api_client_id, match.site_name),
      ...(detail ? orderFields(detail.order, detail.ledger_entry.amount_cents) : []),
      !!source && { label: "采集记录", value: <SourceLink id={match.ledger_entry_id} number={source} /> },
      !!operation?.reason && { label: "关联理由", value: operation.reason },
      match.status === "REVERSED" && { label: "撤销时间", kind: "time", value: <RecordTime value={reversal?.created_at ?? match.resolved_at} /> },
      ...(match.status === "REVERSED" && detail ? [
        { label: "撤销操作人", value: reversal?.actor_id ?? "未记录" },
        { label: "撤销理由", value: reversal?.reason ?? "未记录" },
      ] : []),
    ]} />
    <Pending query={query} label="正在读取收款关联…" />
    <ErrorNotice scope="page" error={query.error} retainedData={!!detail} retry={() => { void query.refetch(); }} placeholder="收款关联读取失败，请刷新重试。" />
    {detail?.candidate && <MatchingEvidence candidate={detail.candidate} ledger={detail.ledger_entry} />}
    {reverse.dialog}
  </SubRecord>;
}

/** Why PerPay paired the order with the entry, beyond what the entry itself states. */
function MatchingEvidence({ candidate, ledger }: { candidate: MatchCandidate; ledger: { amount_cents: number; occurred_at: string } }) {
  const facts = candidateFactsBeyondLedger(candidate, ledger);
  const incomplete = candidateFacts(candidate).length < 3;
  if (!facts.length && !incomplete) return null;
  return <Disclosure label="匹配依据" {...(facts.length ? { count: facts.length } : {})}>
    <div id={"candidate-" + candidate.candidate_id} tabIndex={-1} data-match-evidence
      className="flex min-w-0 flex-col gap-1 rounded-md outline-none transition-colors duration-1000 data-anchor-hit:bg-accent data-anchor-hit:duration-0">
      {incomplete && <p className={note}>匹配信息不完整</p>}
      <FieldList items={facts.map(([name, value]) => ({ label: name, value }))} />
    </div>
  </Disclosure>;
}

/** An order PerPay found for this entry by amount and time, which nobody has confirmed. */
function CandidateRecord({ candidate, source, number, settled }: {
  candidate: MatchCandidate;
  source: AdminLedgerSource;
  /** Number of the source the suggestion was made for, when the transaction has several. */
  number?: number | undefined;
  /** Another copy of the payment already holds an association, which leaves this one nothing to take. */
  settled: boolean;
}) {
  const { order, query } = useRelatedOrder(candidate.order_id);
  const { canAssociate, guidance } = candidateGuidance(candidate, settled ? { ...source, state: "ALLOCATED" } : source, order ? orderPayment(order) : null);
  const associate = useAssociateIncome({ orderId: candidate.order_id, ledgerId: candidate.ledger_entry_id, orderLabel: order?.product_name,
    ledgerLabel: ledgerLabel(source), actionLabel: "关联到此订单" });
  return <SubRecord id={"candidate-" + candidate.candidate_id} title={order?.product_name ?? "可能匹配的订单"} status={<StatusBadge value={candidate.status} />}
    description={guidance} href={"/orders/" + candidate.order_id} hrefLabel="查看订单"
    actions={canAssociate ? [associate.action] : []} actionsLabel="更多操作，匹配建议操作">
    <Pending query={query} label="正在读取关联订单…" />
    <ErrorNotice scope="page" error={query.error} retainedData={!!order} retry={() => { void query.refetch(); }} placeholder="关联订单读取失败，请刷新重试。" />
    <FieldList items={[
      ...(order ? [
        { label: "商户订单号", kind: "id" as const, value: order.merchant_order_no, copy: order.merchant_order_no },
        siteField(order.api_client_id, order.site_name ?? null),
        ...orderFields(order, source.amount_cents),
      ] : []),
      ...candidateFactsBeyondLedger(candidate, source).map(([name, value]) => ({ label: name, value })),
      !!number && { label: "采集记录", value: <SourceLink id={source.ledger_entry_id} number={number} /> },
      { label: "形成时间", kind: "time", value: <RecordTime value={candidate.created_at} /> },
      !!candidate.decided_at && { label: "决定时间", kind: "time", value: <RecordTime value={candidate.decided_at} /> },
    ]} />
    {candidateFacts(candidate).length < 3 && <p className={note}>匹配信息不完整</p>}
    {associate.dialog}
  </SubRecord>;
}
