import { useWorkspace } from "@/workspace";
import { useQuery } from '@/lib/workspace-query';
import { useWorkspaceApi } from "@/workspace";
import { PageHeaderActions } from "@/components/page-header-actions";
import { PageHeading } from "@/components/page-heading";
import { RefreshButton } from "@/components/refresh-button";
import { useSystemName } from "@/branding";
import { useEffect } from "react";

import { ArrowLeft, FileQuestion } from "lucide-react";
import { Navigate, useLocation, useParams } from "react-router";
import { LedgerDetailRedirect } from "./ReconciliationRedirect";
import { Link, useDetailBack } from "@/navigation";
import { refreshOperationalData, result } from "@/api/client";
import { dateTime, money } from "@/lib/format";
import { label } from "@/lib/labels";
import { QueryView } from "@/components/request-state";
import {
  CandidateCard,
  ExceptionCard,
  LedgerFacts,
  MatchCard,
} from "@/components/detail/PaymentEvidence";
import { ConflictCard } from "@/components/detail/ConflictEvidence";
import {
  DetailFields,
  DetailNavigation,
  DetailPage,
  type DetailDensity,
  useDetailFetching,
} from "@/components/detail/DetailPrimitives";
import { RecordTools } from "@/components/detail/RecordTools";
import { AssociateIncomeAction } from "@/components/detail/FinancialActions";
import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription, EmptyContent, EmptyMedia } from "@/components/admin-empty";
export default function EvidenceDetail() {
  const { clientId } = useWorkspace();
  const { kind = "", resourceId = "" } = useParams();
  const back = useDetailBack("/reconciliation", "返回对账");
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
  loaded,
  density = "default",
}: {
  title: string;
  section?: string;
  loaded?: boolean;
  density?: DetailDensity;
}) {
  const systemName = useSystemName();
  const { clientId, site } = useWorkspace();
  const { resourceId = "" } = useParams();
  const siteName = clientId ? site?.data?.data.configuration.name ?? clientId : "全部网站";
  const back = useDetailBack(
    "/reconciliation" + (section ? "?tab=" + section : ""),
    "返回对账",
  );
  const fetching = useDetailFetching();
  useEffect(() => {
    document.title = title + ` · ${siteName} · ${systemName}`;
  }, [title, systemName, siteName]);
  return (
    <><PageHeading title={loaded && density !== "comfortable" ? `${title} · ${resourceId}` : title} />
    {density === "comfortable" ? (
      <DetailNavigation back={back}>
        <PageHeaderActions><RefreshButton disabled={fetching > 0} onClick={() => {
          void refreshOperationalData();
        }} busy={fetching > 0} /></PageHeaderActions>
      </DetailNavigation>
    ) : (
    <div className="flex items-center justify-between gap-4">
      <Link
        to={back.to}
        state={back.state}
        className={buttonVariants({ variant: "ghost", size: "sm" })}
      >
        <ArrowLeft data-icon="inline-start" />
        {back.label}
      </Link>
      <PageHeaderActions><RefreshButton disabled={fetching > 0} onClick={() => {
          void refreshOperationalData();
        }} busy={fetching > 0} /></PageHeaderActions>
    </div>)}
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
    <>
      <EvidenceHeading title="账本冲突" section="conflicts" loaded={query.isSuccess} />
      <QueryView query={query}>
        {({ data }) => <ConflictCard detail={data} />}
      </QueryView>
    </>
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
      <EvidenceHeading title="收款关联详情" loaded={query.isSuccess} density="comfortable" />
      <QueryView query={query}>
        {({ data }) => clientId ? <MatchCard match={data} density="comfortable" /> : <Navigate replace to={{ pathname: "/reconciliation/transactions/" + data.ledger_entry_id, search: location.search, hash: "#match-" + data.payment_match_id }} state={location.state} />}
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
      <EvidenceHeading title="账务异常详情" section="exceptions" loaded={query.isSuccess} density="comfortable" />
      <QueryView query={query}>
        {({ data }) => <ExceptionCard exception={data} density="comfortable" />}
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
    <>
      <EvidenceHeading title="可能匹配的记录详情" loaded={query.isSuccess} />
      <QueryView query={query}>
        {({ data }) => <CandidateCard candidate={data} />}
      </QueryView>
    </>
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
    <>
      <EvidenceHeading title="支付宝流水" loaded={ledger.isSuccess} />
      <QueryView query={ledger}>
        {({ data }) => (
          <>
            <Card>
              <CardHeader>
                <CardTitle role="heading" aria-level={2}>
                  支付宝流水
                </CardTitle>
                <CardDescription>PerPay 处理状态：{label(data.state)}</CardDescription>
              </CardHeader>
              <CardContent className="flex min-w-0 flex-col gap-4">
                <LedgerFacts entry={data} />
                <DetailFields
                  items={[["写入时间", dateTime(data.created_at)]]}
                />
                <RecordTools
                  data={data}
                  identifiers={[
                    ["内部流水编号（PerPay）", resourceId],
                    ["支付宝流水号", data.external_event_id],
                  ]}
                  label="流水记录操作"
                />
              </CardContent>
              {data.direction === "CREDIT" &&
                ["UNALLOCATED", "CANDIDATE", "CONFLICT"].includes(
                  data.state,
                ) && (
                  <CardFooter>
                    <AssociateIncomeAction
                      ledgerId={resourceId}
                      ledgerLabel={
                        money(data.amount_cents) +
                        " · " +
                        dateTime(data.occurred_at)
                      }
                    />
                  </CardFooter>
                )}
            </Card>
            {data.direction === "CREDIT" && (
              <QueryView query={candidates}>
                {({ data: records }) =>
                  records.length ? (
                    records.map((candidate) => (
                      <CandidateCard
                        key={candidate.candidate_id}
                        candidate={candidate}
                        ledger={data}
                        embedded
                      />
                    ))
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      暂无可能匹配的订单。
                    </p>
                  )
                }
              </QueryView>
            )}
          </>
        )}
      </QueryView>
    </>
  );
}
