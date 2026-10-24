import { useQuery } from '@/lib/workspace-query';
import { useWorkspace, useWorkspaceApi } from "@/workspace";
import { useState } from "react";

import { Search } from "lucide-react";
import { result, type ManualSettlementRecommendation } from "@/api/client";
import { normalizeKeyword } from "@/lib/list-query";
import { dateTime, money } from "@/lib/format";
import { ListDateTime, ListMoney } from "@/components/list-primitives";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldError } from "@/components/ui/field";
import {
  InputGroup,
  InputGroupInput,
  InputGroupAddon,
} from "@/components/ui/input-group";
import {
  Item,
  ItemGroup,
  ItemContent,
  ItemTitle,
  ItemDescription,
  ItemActions,
} from "@/components/ui/item";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from "@/components/admin-empty";
import { CursorPagination } from "@/components/cursor-pagination";
import { ErrorNotice, Loading } from "@/components/request-state";
interface Choice {
  id: string;
  title: string;
  summary: string;
  amount: number;
  occurredAt: string;
  identifiers: ReadonlyArray<readonly [label: string, value: string]>;
  website?: string;
  recommendation: ManualSettlementRecommendation | null;
}
export function ManualCandidatePicker({
  kind,
  contextId,
  disabled,
  onSelect,
}: {
  kind: "orders" | "ledger-entries";
  contextId: string;
  disabled: boolean;
  onSelect: (id: string, title: string) => void;
}) {
  const api = useWorkspaceApi();
  const { clientId } = useWorkspace();
  const noun = kind === "orders" ? "订单" : clientId ? "共享收入流水" : "收入流水";
  const candidateNoun = kind === "orders" ? "订单" : "流水";
  const [draft, setDraft] = useState("");
  const [q, setQ] = useState("");
  const [view, setView] = useState<"recommended" | "all">(
    contextId ? "recommended" : "all",
  );
  const [trail, setTrail] = useState<Array<string | null>>([null]);
  const [error, setError] = useState("");
  const cursor = trail.at(-1);
  const query = useQuery({
    queryKey: ["manual-candidates", kind, contextId, view, q, cursor],
    enabled: !disabled,
    retry: false,
    staleTime: 0,
    queryFn: async ({
      signal,
    }): Promise<{ choices: Choice[]; next: string | null }> => {
      const base = { q, view, limit: 10, ...(cursor ? { cursor } : {}) };
      if (kind === "orders") {
        const response = await result(
          api.listManualSettlementOrders({
            signal,
            query: {
              ...base,
              ...(contextId ? { ledger_entry_id: contextId } : {}),
            },
          }),
        );
        return {
          next: response.page.next_cursor,
          choices: response.data.map(({ order, recommendation }): Choice => ({
            id: order.order_id,
            title: order.product_name,
            summary: {OPEN: "收银台开放中", CLOSED: "收银台已关闭", EXPIRED: "收银台已过期"}[order.checkout_status],
            amount: order.payable_amount_cents,
            occurredAt: order.created_at,
            identifiers: [["商户订单号（业务网站）", order.merchant_order_no]],
            website: `${order.site_name ?? "名称不可用"} · ${order.api_client_id}`,
            recommendation,
          })),
        };
      }
      const response = await result(
        api.listManualSettlementLedgerEntries({
          signal,
          query: { ...base, order_id: contextId },
        }),
      );
      return {
        next: response.page.next_cursor,
        choices: response.data.map(
          ({ ledger_entry: entry, recommendation }): Choice => ({
            id: entry.ledger_entry_id,
            title:
              money(entry.amount_cents) + " · " + dateTime(entry.occurred_at),
            summary: entry.other_account || "未提供支付宝交易对方",
            amount: entry.amount_cents,
            occurredAt: entry.occurred_at,
            identifiers: [
              ...(entry.provider_order_no ? [["支付宝订单号", entry.provider_order_no] as const] : []),
              ...(entry.merchant_order_no ? [["支付宝商户单号", entry.merchant_order_no] as const] : []),
              ["支付宝流水号", entry.external_event_id],
            ],
            recommendation,
          }),
        ),
      };
    },
  });
  function search() {
    if (disabled) return;
    try {
      const normalized = normalizeKeyword(draft);
      setError("");
      setDraft(normalized);
      setQ(normalized);
      setTrail([null]);
      const nextView = normalized ? "all" : view;
      setView(nextView);
      if (normalized === q && nextView === view && trail.length === 1)
        void query.refetch();
    } catch {
      setError("关键词最多 100 个字符。");
    }
  }
  return (
    <section className="flex min-w-0 flex-col gap-4" aria-label={"选择" + noun}>
      <h3 className="text-sm font-medium">选择{noun}</h3>
      <div role="search" aria-label={"搜索可关联" + noun}>
        <FieldGroup className="flex-row flex-wrap items-start gap-2">
          <Field className="min-w-40 flex-1" data-invalid={!!error}>
            <InputGroup>
              <InputGroupAddon>
                <Search />
              </InputGroupAddon>
              <InputGroupInput
                type="search"
                aria-label={"搜索" + noun}
                aria-invalid={!!error}
                placeholder={
                  kind === "orders"
                    ? "商品名、商户订单号或金额"
                    : "支付宝流水号、支付宝交易对方或金额"
                }
                value={draft}
                disabled={disabled}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setError("");
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    search();
                  }
                }}
              />
            </InputGroup>
            {error && <FieldError>{error}</FieldError>}
          </Field>
          <Button
            type="button"
            variant="outline"
            disabled={disabled}
            onClick={search}
          >
            搜索
          </Button>
        </FieldGroup>
      </div>
      {contextId && (
        <ToggleGroup
          aria-label="可能匹配的记录范围"
          value={[view]}
          variant="outline"
          spacing={0}
          onValueChange={(values) => {
            if (disabled || !values[0]) return;
            setView(values[0] as "recommended" | "all");
            setTrail([null]);
          }}
        >
          <ToggleGroupItem value="recommended" disabled={disabled}>
            可能匹配的{candidateNoun}
          </ToggleGroupItem>
          <ToggleGroupItem value="all" disabled={disabled}>
            全部可关联
          </ToggleGroupItem>
        </ToggleGroup>
      )}
      <ErrorNotice error={query.error} retry={() => void query.refetch()} />
      {query.isPending || query.isFetching ? (
        <Loading label={"正在查找可关联" + noun + "…"} />
      ) : (
        !query.isError &&
        query.data && (
          <>
            {query.data.choices.length ? (
              <ItemGroup className="record-list" data-density="compact">
                {query.data.choices.map((choice) => (
                  <Item className="record-list-row" size="xs" key={choice.id} role="listitem">
                    <ItemContent className="min-w-0">
                      <ItemTitle className="record-list-title" title={kind === "orders" ? choice.title : choice.summary}>
                        {kind === "orders" ? choice.title : choice.summary}
                      </ItemTitle>
                      {choice.website && (
                        <ItemDescription className="line-clamp-none whitespace-normal wrap-anywhere">
                          所属网站：{choice.website}
                        </ItemDescription>
                      )}
                      <ItemDescription>
                        <ListDateTime value={choice.occurredAt} inline />
                        {kind === "orders" && " · " + choice.summary}
                      </ItemDescription>
                      {choice.identifiers.map(([label, value]) => <ItemDescription key={label} className="whitespace-normal wrap-anywhere">
                        {label}：{value}
                      </ItemDescription>)}
                      {choice.recommendation?.amount_match && (
                        <ItemDescription>
                          {choice.recommendation.time_window_overlap
                            ? "同金额 · 匹配时间窗口重叠，仍需核对"
                            : "同金额 · 时间不在匹配窗口内，请核对"}
                        </ItemDescription>
                      )}
                    </ItemContent>
                    <ItemActions className="flex-col items-end">
                      <ListMoney value={choice.amount} />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={disabled}
                        aria-label={"选择" + noun + "：" + choice.title + (choice.website ? " · " + choice.website : "")}
                        onClick={() => onSelect(choice.id, choice.title)}
                      >
                        选择
                      </Button>
                    </ItemActions>
                  </Item>
                ))}
              </ItemGroup>
            ) : (
              <Empty kind="filtered">
                <EmptyHeader>
                  <EmptyTitle>
                    {view === "recommended"
                      ? "暂无可能匹配的" + candidateNoun
                      : "没有符合条件的" + noun}
                  </EmptyTitle>
                  <EmptyDescription>
                    {view === "recommended"
                      ? "仅推荐同金额记录，其他记录可搜索。"
                      : "可更换关键词，已关联记录不再列出。"}
                  </EmptyDescription>
                </EmptyHeader>
                {view === "recommended" && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setView("all");
                      setTrail([null]);
                    }}
                  >
                    查看全部可关联
                  </Button>
                )}
              </Empty>
            )}
            <CursorPagination
              page={trail.length}
              count={query.data.choices.length}
              hasNext={!!query.data.next}
              pending={disabled || query.isFetching}
              onPrevious={() =>
                setTrail((current) =>
                  current.length > 1 ? current.slice(0, -1) : current,
                )
              }
              onNext={() => {
                if (query.data?.next)
                  setTrail((current) => [...current, query.data!.next]);
              }}
            />
          </>
        )
      )}
    </section>
  );
}
