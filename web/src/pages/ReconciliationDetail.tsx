import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useParams } from "react-router";
import { useDetailBack } from "../navigation";
import { api, refreshOperationalData, result } from "../api/client";
import { Badge, Button, PageHeading, Panel, QueryView } from "../components/ui";
import { CandidateCard, ExceptionCard, LedgerFacts, MatchCard } from "../components/detail/PaymentEvidence";
import { ConflictCard } from "../components/detail/ConflictEvidence";
import { DetailFields, useDetailFetching } from "../components/detail/DetailPrimitives";
import { RecordTools } from "../components/detail/RecordTools";
import { AssociateIncomeAction } from "../components/detail/FinancialActions";
import { dateTime, money } from "../lib/format";
import { label } from "../lib/labels";

export default function EvidenceDetail() {
  const { kind = "", resourceId = "" } = useParams();
  if (kind === "conflicts") return <ConflictDetail key={resourceId} resourceId={resourceId} />;
  if (kind === "matches") return <MatchDetail key={resourceId} resourceId={resourceId} />;
  if (kind === "exceptions") return <ExceptionDetail key={resourceId} resourceId={resourceId} />;
  if (kind === "ledger") return <LedgerDetail key={resourceId} resourceId={resourceId} />;
  if (kind === "candidates") return <CandidateDetail key={resourceId} resourceId={resourceId} />;
  return <PageHeading title="未找到这条对账记录" />;
}
function EvidenceHeading({ title, section }: { title: string; section?: string }) {
  const back = useDetailBack("/reconciliation" + (section ? "?tab=" + section : ""), "账本与对账");
  const fetching = useDetailFetching();
  return <PageHeading title={title} back={back} actions={<Button pending={fetching > 0} onClick={() => { void refreshOperationalData(); }}><RefreshCw size={16} />刷新</Button>} />;
}
function ConflictDetail({ resourceId }: { resourceId: string }) {
  const query = useQuery({ queryKey: ["conflict", resourceId], queryFn: ({ signal }) => result(api.getLedgerConflict({ path: { conflictId: resourceId }, signal })) });
  return <div className="detail-page"><EvidenceHeading title="账本冲突" section="conflicts" /><QueryView query={query}>{({ data }) => <Panel className="detail-panel"><ConflictCard detail={data} /></Panel>}</QueryView></div>;
}
function MatchDetail({ resourceId }: { resourceId: string }) {
  const query = useQuery({ queryKey: ["match", resourceId], queryFn: ({ signal }) => result(api.getPaymentMatch({ path: { paymentMatchId: resourceId }, signal })) });
  return <div className="detail-page"><EvidenceHeading title="支付关联详情" /><QueryView query={query}>{({ data }) => <Panel className="detail-panel"><MatchCard match={data} /></Panel>}</QueryView></div>;
}
function ExceptionDetail({ resourceId }: { resourceId: string }) {
  const query = useQuery({ queryKey: ["exception", resourceId], queryFn: ({ signal }) => result(api.getFinancialException({ path: { exceptionId: resourceId }, signal })) });
  return <div className="detail-page"><EvidenceHeading title="账务异常" section="exceptions" /><QueryView query={query}>{({ data }) => <Panel className="detail-panel"><ExceptionCard exception={data} /></Panel>}</QueryView></div>;
}
function LedgerDetail({ resourceId }: { resourceId: string }) {
  const ledger = useQuery({ queryKey: ["ledger", resourceId], queryFn: ({ signal }) => result(api.getReconciliationLedgerEntry({ path: { ledgerEntryId: resourceId }, signal })) });
  const candidates = useQuery({ queryKey: ["ledger-candidates", resourceId], enabled: ledger.data?.data.direction === "CREDIT", queryFn: ({ signal }) => result(api.listLedgerEntryCandidates({ path: { ledgerEntryId: resourceId }, signal })) });
  return <div className="detail-page"><EvidenceHeading title="账本流水" /><QueryView query={ledger}>{({ data }) => <>
    <Panel className="detail-panel"><article className="detail-record"><div className="detail-record-heading"><h2>{money(data.amount_cents)}</h2><Badge value={data.direction} /></div><LedgerFacts entry={data} />
      <DetailFields items={[["分配状态", label(data.state)], ["采集入库时间", dateTime(data.created_at)]]} />
      {data.direction === "DEBIT" ? <p className="detail-caution">支出仅作流水留存，不参与收款匹配。</p> : ["UNALLOCATED", "CANDIDATE", "CONFLICT"].includes(data.state) && <div className="detail-actions"><AssociateIncomeAction ledgerId={resourceId} ledgerLabel={money(data.amount_cents) + " · " + dateTime(data.occurred_at)} /></div>}
      <RecordTools data={data} identifiers={[["流水编号", resourceId], ["外部事件编号", data.external_event_id]]} label="流水记录操作" /></article></Panel>
    {data.direction === "CREDIT" && <Panel title="匹配候选" className="detail-panel"><QueryView query={candidates}>{({ data: records }) => records.length ? records.map(candidate => <CandidateCard key={candidate.candidate_id} candidate={candidate} ledger={data} embedded />) : <p className="detail-empty">暂无匹配候选。</p>}</QueryView></Panel>}
  </>}</QueryView></div>;
}
function CandidateDetail({ resourceId }: { resourceId: string }) {
  const query = useQuery({ queryKey: ["candidate", resourceId], queryFn: ({ signal }) => result(api.getReconciliationCandidate({ path: { candidateId: resourceId }, signal })) });
  return <div className="detail-page"><EvidenceHeading title="匹配候选证据" /><QueryView query={query}>{({ data }) => <Panel className="detail-panel"><CandidateCard candidate={data} /></Panel>}</QueryView></div>;
}
