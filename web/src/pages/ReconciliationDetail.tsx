import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { useParams } from "react-router";

import { Link, useDetailBack } from "../navigation";

import { api, refreshOperationalData, result } from "../api/client";
import { ReasonDialog } from "../components/ReasonDialog";
import { Badge, Button, CopyValue, Details, EmptyState, JsonDetails, Notice, PageHeading, Panel, QueryView } from "../components/ui";
import { dateTime, money, shortId } from "../lib/format";
import { label } from "../lib/labels";
import { FinancialDialog } from "./FinancialDialog";

export default function EvidenceDetail() {
  const { kind = "", resourceId = "" } = useParams();
  if (kind === "conflicts") return <ConflictDetail key={resourceId} resourceId={resourceId} />;
  if (kind === "matches") return <MatchDetail key={resourceId} resourceId={resourceId} />;
  if (kind === "exceptions") return <ExceptionDetail key={resourceId} resourceId={resourceId} />;
  if (kind === "ledger") return <LedgerDetail key={resourceId} resourceId={resourceId} />;
  if (kind === "candidates") return <CandidateDetail key={resourceId} resourceId={resourceId} />;
  return <EmptyState title="没有这种账务记录" description="请从待处理或对账列表重新进入。"><Link to="/reconciliation">返回账本与对账</Link></EmptyState>;
}

function EvidenceHeading({ title, section }: { title: string; section?: string }) {
  const back = useDetailBack(`/reconciliation${section ? `?tab=${section}` : ""}`, "账本与对账");
  return <PageHeading title={title} back={back} />;
}

function ConflictDetail({ resourceId }: { resourceId: string }) {
  const [confirm, setConfirm] = useState(false);
  const [completed, setCompleted] = useState(false);
  const query = useQuery({ queryKey: ["conflict", resourceId], queryFn: ({ signal }) => result(api.getLedgerConflict({ path: { conflictId: resourceId }, signal })) });
  return <><EvidenceHeading title="账本冲突" section="conflicts" />{completed && <Notice tone="success">冲突处理已记录。</Notice>}<QueryView query={query}>{({ data }) => {
    const conflict = data.conflict;
    const action = conflict.conflict_type === "DUPLICATE_EXTERNAL_ID" ? "KEEP_EXISTING" : "ACKNOWLEDGE_ISOLATED";
    return <><Panel title={label(conflict.conflict_type)} action={<Badge value={conflict.status} label={conflict.status === "OPEN" ? "待处理" : undefined} />} className="content-panel">
      <Details items={[["冲突编号", <CopyValue value={conflict.conflict_id} />], ["外部事件编号", conflict.external_event_id], ["发现时间", dateTime(conflict.created_at)], ["处理时间", dateTime(conflict.resolved_at)], ["处理方式", label(conflict.resolution_action)], ["已有流水", conflict.existing_ledger_entry_id ? <Link to={`/reconciliation/ledger/${conflict.existing_ledger_entry_id}`}>{shortId(conflict.existing_ledger_entry_id)}</Link> : "无"]]} />
      <JsonDetails data={conflict.details} label="查看冲突原因" />
      {conflict.status === "OPEN" && (conflict.conflict_type === "RAW_PAGE_VARIANT" ? <Notice>原始页变更由账本采集流程确认，当前 API 不提供人工忽略此类变更的操作。</Notice> : <div className="form-actions"><Button variant="danger" onClick={() => setConfirm(true)}>{label(action)}</Button></div>)}
    </Panel>
      <div className="two-column"><Panel title="传入事件证据" className="content-panel"><JsonDetails data={data.incoming_event} label="查看传入事件" /><JsonDetails data={data.raw_page} label="查看原始页元数据" /></Panel><Panel title="已有流水证据" className="content-panel"><JsonDetails data={data.existing_ledger_entry} label="查看已有流水" /><JsonDetails data={data.resolution_operation} label="查看处理记录" /></Panel></div>
      {confirm && <ReasonDialog title={label(action)} description={action === "KEEP_EXISTING" ? "保留已经入账的流水，拒绝本次冲突记录。不会以新记录覆盖历史账本。" : "确认该无效流水保持隔离，不将它计入可分配的收款。"} action="确认处理冲突" onClose={() => setConfirm(false)} execute={(reason, operationId) => result(api.resolveLedgerConflict({ path: { conflictId: resourceId }, body: { reason, action, conflict_operation_id: operationId } }))} onSuccess={() => { setConfirm(false); setCompleted(true); void refreshOperationalData(); }}><CopyValue value={resourceId} label="复制冲突编号" /></ReasonDialog>}
    </>;
  }}</QueryView></>;
}

function MatchDetail({ resourceId }: { resourceId: string }) {
  const [reverse, setReverse] = useState(false);
  const [completed, setCompleted] = useState(false);
  const query = useQuery({ queryKey: ["match", resourceId], queryFn: ({ signal }) => result(api.getPaymentMatch({ path: { paymentMatchId: resourceId }, signal })) });
  return <><EvidenceHeading title="支付关联详情" />{completed && <Notice tone="success">关联已撤销，订单状态已重新计算。</Notice>}<QueryView query={query}>{({ data }) => <>
    <Panel title={data.order.product_name} action={<Badge value={data.status} />} className="content-panel"><Details items={[["关联编号", <CopyValue value={data.payment_match_id} />], ["关联依据", <Badge value={data.evidence_type} />], ["账本金额", <strong className="amount">{money(data.ledger_entry.amount_cents)}</strong>], ["订单应付", money(data.order.payable_amount_cents)], ["关联订单", <Link to={`/orders/${data.order_id}`}>{data.order.merchant_order_no}</Link>], ["账本流水", <Link to={`/reconciliation/ledger/${data.ledger_entry_id}`}>{shortId(data.ledger_entry_id)}</Link>], ["创建时间", dateTime(data.created_at)], ["撤销时间", dateTime(data.resolved_at)]]} />
      <JsonDetails data={data.evidence} label="查看匹配证据" />{data.candidate_id && <Link className="text-link" to={`/reconciliation/candidates/${data.candidate_id}`}>查看原始匹配候选<ArrowRight size={14} /></Link>}
      {data.status === "SETTLED" && <div className="form-actions"><Button variant="danger" onClick={() => setReverse(true)}>撤销错误关联</Button></div>}
    </Panel>
    {reverse && <ReasonDialog title="撤销错误关联" description="这会撤销账务关联并更新订单付款状态，不会从支付宝转出资金。仅在确认关联错误时执行。" action="确认撤销关联" onClose={() => setReverse(false)} execute={(reason, operationId) => result(api.reversePaymentSettlement({ path: { paymentMatchId: resourceId }, body: { reason, financial_operation_id: operationId } }))} onSuccess={() => { setReverse(false); setCompleted(true); void refreshOperationalData(); }}><Details items={[["订单", data.order.merchant_order_no], ["流水金额", money(data.ledger_entry.amount_cents)]]} /></ReasonDialog>}
  </>}</QueryView></>;
}

function ExceptionDetail({ resourceId }: { resourceId: string }) {
  const [operation, setOperation] = useState<"settlement" | "refund" | null>(null);
  const [completed, setCompleted] = useState(false);
  const query = useQuery({ queryKey: ["exception", resourceId], queryFn: ({ signal }) => result(api.getFinancialException({ path: { exceptionId: resourceId }, signal })) });
  return <><EvidenceHeading title="账务异常" section="exceptions" />{completed && <Notice tone="success">账务决定已保存。异常是否解决以重新读取的状态为准。</Notice>}<QueryView query={query}>{({ data }) => <>
    <Panel title={label(data.exception_type)} action={<Badge value={data.status} label={data.status === "OPEN" ? "待处理" : "已处理"} />} className="content-panel"><Details items={[["异常编号", <CopyValue value={data.exception_id} />], ["发现时间", dateTime(data.created_at)], ["关联订单", data.order_id ? <Link to={`/orders/${data.order_id}`}>{shortId(data.order_id)}</Link> : "尚未关联"], ["关联流水", data.ledger_entry_id ? <Link to={`/reconciliation/ledger/${data.ledger_entry_id}`}>{shortId(data.ledger_entry_id)}</Link> : "无"], ["匹配候选", data.candidate_id ? <Link to={`/reconciliation/candidates/${data.candidate_id}`}>{shortId(data.candidate_id)}</Link> : "无"], ["解决时间", dateTime(data.resolved_at)]]} />
      <JsonDetails data={data.details} label="查看异常证据" /><JsonDetails data={data.resolution} label="查看处理结果" />
      {data.status === "OPEN" && <><div className="form-actions"><Button onClick={() => setOperation("settlement")}>人工关联收款</Button><Button onClick={() => setOperation("refund")}>登记已发生退款</Button></div></>}
    </Panel>{operation && <FinancialDialog mode={operation} initialOrderId={data.order_id ?? ""} initialLedgerId={data.ledger_entry_id ?? ""} onClose={() => setOperation(null)} onSuccess={() => { setOperation(null); setCompleted(true); }} />}
  </>}</QueryView></>;
}

function LedgerDetail({ resourceId }: { resourceId: string }) {
  const ledger = useQuery({ queryKey: ["ledger", resourceId], queryFn: ({ signal }) => result(api.getReconciliationLedgerEntry({ path: { ledgerEntryId: resourceId }, signal })) });
  const candidates = useQuery({ queryKey: ["ledger-candidates", resourceId], queryFn: ({ signal }) => result(api.listLedgerEntryCandidates({ path: { ledgerEntryId: resourceId }, signal })) });
  return <><EvidenceHeading title="账本流水" /><QueryView query={ledger}>{({ data }) => <Panel title={money(data.amount_cents)} action={<Badge value={data.direction} />} className="content-panel"><Details items={[["流水编号", <CopyValue value={data.ledger_entry_id} />], ["分配状态", label(data.state)], ["支付宝订单号", data.provider_order_no], ["商户订单号", data.merchant_order_no], ["外部事件编号", data.external_event_id], ["交易时间", dateTime(data.occurred_at)], ["交易对方", data.other_account], ["备注", data.memo]]} /><JsonDetails data={data} label="查看规范化流水及指纹" /></Panel>}</QueryView>
    <Panel title="匹配候选"><QueryView query={candidates}>{({ data }) => data.length ? <ul className="related-list">{data.map((candidate) => <li key={candidate.candidate_id}><Link to={`/reconciliation/candidates/${candidate.candidate_id}`}><span><strong>{shortId(candidate.order_id)}</strong><small>金额推断 · 规则版本 {candidate.rule_version}</small></span><Badge value={candidate.status} /><ArrowRight size={15} /></Link></li>)}</ul> : <EmptyState title="尚无匹配候选" description="这笔流水暂未找到符合自动匹配规则的订单。" />}</QueryView></Panel>
  </>;
}

function CandidateDetail({ resourceId }: { resourceId: string }) {
  const query = useQuery({ queryKey: ["candidate", resourceId], queryFn: ({ signal }) => result(api.getReconciliationCandidate({ path: { candidateId: resourceId }, signal })) });
  return <><EvidenceHeading title="匹配候选证据" /><QueryView query={query}>{({ data }) => <Panel title="金额推断候选" action={<Badge value={data.status} />} className="content-panel"><Details items={[["候选编号", <CopyValue value={data.candidate_id} />], ["规则版本", data.rule_version], ["关联订单", <Link to={`/orders/${data.order_id}`}>{shortId(data.order_id)}</Link>], ["关联流水", <Link to={`/reconciliation/ledger/${data.ledger_entry_id}`}>{shortId(data.ledger_entry_id)}</Link>], ["创建时间", dateTime(data.created_at)], ["决定时间", dateTime(data.decided_at)]]} /><JsonDetails data={data.evidence} label="查看推断规则与证据" /><Notice>候选是匹配证据，不等于付款已经确认。请以订单付款状态和支付关联记录为准。</Notice></Panel>}</QueryView></>;
}
