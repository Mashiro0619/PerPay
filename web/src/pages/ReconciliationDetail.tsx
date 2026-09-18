import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { useParams } from "react-router";
import { Link, useDetailBack } from "@/navigation";
import { api, refreshOperationalData, result } from "@/api/client";
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
  useDetailFetching,
} from "@/components/detail/DetailPrimitives";
import { RecordTools } from "@/components/detail/RecordTools";
import { AssociateIncomeAction } from "@/components/detail/FinancialActions";
import { Button, buttonVariants } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
export default function EvidenceDetail() {
  const { kind = "", resourceId = "" } = useParams();
  if (kind === "conflicts")
    return <ConflictDetail key={resourceId} resourceId={resourceId} />;
  if (kind === "matches")
    return <MatchDetail key={resourceId} resourceId={resourceId} />;
  if (kind === "exceptions")
    return <ExceptionDetail key={resourceId} resourceId={resourceId} />;
  if (kind === "ledger")
    return <LedgerDetail key={resourceId} resourceId={resourceId} />;
  if (kind === "candidates")
    return <CandidateDetail key={resourceId} resourceId={resourceId} />;
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle role="heading" aria-level={2}>
          未找到这条对账记录
        </EmptyTitle>
      </EmptyHeader>
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
  const back = useDetailBack(
    "/reconciliation" + (section ? "?tab=" + section : ""),
    "账本与对账",
  );
  const fetching = useDetailFetching();
  useEffect(() => {
    document.title = title + " · PerPay";
  }, [title]);
  return (
    <div className="flex items-center justify-between gap-4">
      <Link
        to={back.to}
        state={back.state}
        className={buttonVariants({ variant: "ghost", size: "sm" })}
      >
        <ArrowLeft data-icon="inline-start" />
        {back.label}
      </Link>
      <Button
        variant="outline"
        disabled={fetching > 0}
        onClick={() => {
          void refreshOperationalData();
        }}
      >
        {fetching > 0 ? (
          <Spinner aria-hidden="true" data-icon="inline-start" />
        ) : (
          <RefreshCw data-icon="inline-start" />
        )}
        刷新
      </Button>
    </div>
  );
}
function ConflictDetail({ resourceId }: { resourceId: string }) {
  const query = useQuery({
    queryKey: ["conflict", resourceId],
    queryFn: ({ signal }) =>
      result(
        api.getLedgerConflict({ path: { conflictId: resourceId }, signal }),
      ),
  });
  return (
    <>
      <EvidenceHeading title="账本冲突" section="conflicts" />
      <QueryView query={query}>
        {({ data }) => <ConflictCard detail={data} />}
      </QueryView>
    </>
  );
}
function MatchDetail({ resourceId }: { resourceId: string }) {
  const query = useQuery({
    queryKey: ["match", resourceId],
    queryFn: ({ signal }) =>
      result(
        api.getPaymentMatch({ path: { paymentMatchId: resourceId }, signal }),
      ),
  });
  return (
    <>
      <EvidenceHeading title="支付关联详情" />
      <QueryView query={query}>
        {({ data }) => <MatchCard match={data} />}
      </QueryView>
    </>
  );
}
function ExceptionDetail({ resourceId }: { resourceId: string }) {
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
    <>
      <EvidenceHeading title="账务异常" section="exceptions" />
      <QueryView query={query}>
        {({ data }) => <ExceptionCard exception={data} />}
      </QueryView>
    </>
  );
}
function CandidateDetail({ resourceId }: { resourceId: string }) {
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
      <EvidenceHeading title="匹配候选证据" />
      <QueryView query={query}>
        {({ data }) => <CandidateCard candidate={data} />}
      </QueryView>
    </>
  );
}
function LedgerDetail({ resourceId }: { resourceId: string }) {
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
      <EvidenceHeading title="账本流水" />
      <QueryView query={ledger}>
        {({ data }) => (
          <>
            <Card>
              <CardHeader>
                <CardTitle role="heading" aria-level={2}>
                  账本流水
                </CardTitle>
                <CardDescription>{label(data.state)}</CardDescription>
              </CardHeader>
              <CardContent className="flex min-w-0 flex-col gap-4">
                <LedgerFacts entry={data} />
                <DetailFields
                  items={[["采集入库时间", dateTime(data.created_at)]]}
                />
                <RecordTools
                  data={data}
                  identifiers={[
                    ["流水编号", resourceId],
                    ["外部事件编号", data.external_event_id],
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
                      暂无匹配候选。
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
