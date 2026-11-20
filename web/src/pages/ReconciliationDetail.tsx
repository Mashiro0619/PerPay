import { useWorkspace } from "@/workspace";
import { useQuery } from '@/lib/workspace-query';
import { useWorkspaceApi } from "@/workspace";
import { PageHeaderActions } from "@/components/page-header-actions";
import { PageHeading } from "@/components/page-heading";
import { RefreshButton } from "@/components/refresh-button";
import { useSystemName } from "@/branding";
import { useOverlayContext } from "@/lib/overlay-context";
import { useEffect } from "react";

import { ArrowLeft, FileQuestion } from "lucide-react";
import { Navigate, useLocation, useParams } from "react-router";
import { LedgerDetailRedirect } from "./ReconciliationRedirect";
import { Link, useDetailBack } from "@/navigation";
import { result } from "@/api/client";
import { refreshReconciliationDetails } from "@/lib/record-refresh";
import { label } from "@/lib/labels";
import { QueryView } from "@/components/request-state";
import { CandidateRecord } from "@/components/detail/CandidateRecord";
import { ConflictRecord } from "@/components/detail/ConflictEvidence";
import { ExceptionRecord } from "@/components/detail/ExceptionRecord";
import { MatchRecord } from "@/components/detail/MatchRecord";
import { SiteLedgerRecord, siteLedgerTitle } from "@/components/detail/SiteLedgerRecord";
import {
  DetailNavigation,
  DetailPage,
  useDetailFetching,
} from "@/components/detail/DetailPrimitives";
import { buttonVariants } from "@/components/ui/button";
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription, EmptyContent, EmptyMedia } from "@/components/admin-empty";
export default function EvidenceDetail() {
  const { clientId } = useWorkspace();
  const { kind = "", resourceId = "" } = useParams();
  if (clientId && kind === "conflicts") return <p>账本冲突不属于单个网站，请回到<Link global to="/work-items">「待处理（全部网站）」</Link>查看。</p>;
  if (kind === "conflicts")
    return <ConflictDetail key={resourceId} resourceId={resourceId} />;
  if (kind === "matches")
    return <MatchDetail key={resourceId} resourceId={resourceId} />;
  if (kind === "exceptions")
    return <ExceptionDetail key={resourceId} resourceId={resourceId} />;
  if (kind === "ledger")
    return clientId ? <LedgerDetail key={resourceId} resourceId={resourceId} /> : <LedgerDetailRedirect />;
  if (kind === "candidates")
    return <CandidateDetail key={resourceId} resourceId={resourceId} />;
  return <ReconciliationRecovery />;
}

export function ReconciliationRecovery() {
  const back = useDetailBack("/reconciliation", "返回对账");
  return (
    <Empty>
      <PageHeading title="未找到这条对账记录" />
      <EmptyHeader>
        <EmptyMedia variant="icon"><FileQuestion /></EmptyMedia>
        <EmptyTitle role="heading" aria-level={2}>
          未找到这条对账记录
        </EmptyTitle>
        <EmptyDescription>链接中的记录类型无效，请点击「{back.label}」重新选择记录。</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Link to={back.to} state={back.state} className={buttonVariants({ variant: "outline" })}>
          <ArrowLeft data-icon="inline-start" />{back.label}
        </Link>
      </EmptyContent>
    </Empty>
  );
}
function EvidenceHeading({
  title,
  section,
}: {
  title: string;
  section?: string;
}) {
  const systemName = useSystemName();
  const overlay = useOverlayContext();
  const { clientId, site } = useWorkspace();
  const siteName = clientId ? site?.data?.data.configuration.name ?? clientId : "全部网站";
  const back = useDetailBack(
    "/reconciliation" + (section ? "?tab=" + section : ""),
    "返回对账",
  );
  const fetching = useDetailFetching();
  useEffect(() => {
    if (!overlay) document.title = title + ` · ${siteName} · ${systemName}`;
  }, [title, systemName, siteName, overlay]);
  return (
    <><PageHeading title={title} />
    <DetailNavigation back={back}>
      <PageHeaderActions><RefreshButton disabled={fetching > 0} onClick={() => {
        void refreshReconciliationDetails();
      }} busy={fetching > 0} /></PageHeaderActions>
    </DetailNavigation>
    </>
  );
}
function ConflictDetail({ resourceId }: { resourceId: string }) {
  const api = useWorkspaceApi();
  const query = useQuery({
    queryKey: ["conflict", resourceId],
    queryFn: ({ signal }) =>
      result(
        api.getLedgerConflict({ path: { conflictId: resourceId }, signal }),
      ),
  });
  return (
    <DetailPage>
      <EvidenceHeading title={query.data ? label(query.data.data.conflict.conflict_type) : "账本冲突"} section="conflicts" />
      <QueryView query={query}>
        {({ data }) => <ConflictRecord key={data.conflict.conflict_id} detail={data} />}
      </QueryView>
    </DetailPage>
  );
}
function MatchDetail({ resourceId }: { resourceId: string }) {
  const { clientId } = useWorkspace();
  const location = useLocation();
  const api = useWorkspaceApi();
  const query = useQuery({
    queryKey: ["match", resourceId],
    queryFn: ({ signal }) =>
      result(
        api.getPaymentMatch({ path: { paymentMatchId: resourceId }, signal }),
      ),
  });
  return (
    <DetailPage>
      <EvidenceHeading title="收款关联" />
      <QueryView query={query}>
        {({ data }) => clientId ? <MatchRecord key={data.payment_match_id} match={data} /> : <Navigate replace to={{ pathname: "/reconciliation/transactions/" + data.ledger_entry_id, search: location.search, hash: "#match-" + data.payment_match_id }} state={location.state} />}
      </QueryView>
    </DetailPage>
  );
}
function ExceptionDetail({ resourceId }: { resourceId: string }) {
  const api = useWorkspaceApi();
  const query = useQuery({
    queryKey: ["exception", resourceId],
    queryFn: ({ signal }) =>
      result(
        api.getFinancialException({
          path: { exceptionId: resourceId },
          signal,
        }),
      ),
  });
  return (
    <DetailPage>
      <EvidenceHeading title={query.data ? label(query.data.data.exception_type) : "账务异常详情"} section="exceptions" />
      <QueryView query={query}>
        {({ data }) => <ExceptionRecord key={data.exception_id} exception={data} />}
      </QueryView>
    </DetailPage>
  );
}
function CandidateDetail({ resourceId }: { resourceId: string }) {
  const api = useWorkspaceApi();
  const query = useQuery({
    queryKey: ["candidate", resourceId],
    queryFn: ({ signal }) =>
      result(
        api.getReconciliationCandidate({
          path: { candidateId: resourceId },
          signal,
        }),
      ),
  });
  return (
    <DetailPage>
      <EvidenceHeading title="可能匹配的记录" />
      <QueryView query={query}>
        {({ data }) => <CandidateRecord key={data.candidate_id} candidate={data} />}
      </QueryView>
    </DetailPage>
  );
}
function LedgerDetail({ resourceId }: { resourceId: string }) {
  const api = useWorkspaceApi();
  const ledger = useQuery({
    queryKey: ["ledger", resourceId],
    queryFn: ({ signal }) =>
      result(
        api.getReconciliationLedgerEntry({
          path: { ledgerEntryId: resourceId },
          signal,
        }),
      ),
  });
  const candidates = useQuery({
    queryKey: ["ledger-candidates", resourceId],
    enabled: ledger.data?.data.direction === "CREDIT",
    queryFn: ({ signal }) =>
      result(
        api.listLedgerEntryCandidates({
          path: { ledgerEntryId: resourceId },
          signal,
        }),
      ),
  });
  return (
    <DetailPage>
      <EvidenceHeading title={ledger.data ? siteLedgerTitle(ledger.data.data) : "支付宝流水"} />
      <QueryView query={ledger}>
        {({ data }) => <SiteLedgerRecord key={data.ledger_entry_id} entry={data} candidates={candidates} />}
      </QueryView>
    </DetailPage>
  );
}
