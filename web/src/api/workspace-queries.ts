import { infiniteQueryOptions, keepPreviousData, queryOptions, type QueryKey } from "@tanstack/react-query";
import { api, result, type AdminWorkItemTypeFilter, type CheckoutStatus, type PaymentStatus, type WebhookDeliveryStatus } from "@/api/client";
import { workspaceApi } from "@/api/workspace";
import { retainListData } from "@/lib/list-placeholder";
import { DELIVERY_SORT_FIELDS, ORDER_SORT_FIELDS, readListQuery, WORK_ITEM_SORT_FIELDS } from "@/lib/list-query";

type ListRead<S extends string> = ReturnType<typeof readListQuery<S>>;
type OrderSort = (typeof ORDER_SORT_FIELDS)[number];
type NotificationSort = (typeof DELIVERY_SORT_FIELDS)[number];
type WorkItemSort = (typeof WORK_ITEM_SORT_FIELDS)[number];
export type WorkItemVisibility = "ACTIVE" | "IGNORED";

export function overviewRange(search: URLSearchParams): 7 | 30 | 90 {
  const selected = Number(search.get("range"));
  return selected === 7 || selected === 90 ? selected : 30;
}

export function overviewQueries(clientId: string | null, range: 7 | 30 | 90) {
  const api = workspaceApi(clientId);
  return {
    analytics: queryOptions({
      queryKey: ["analytics", range, clientId] as QueryKey,
      queryFn: ({ signal }) => result(api.getAdministratorSystemAnalytics({ query: { range, ...(clientId ? { api_client_id: clientId } : {}) }, signal })),
      placeholderData: keepPreviousData,
      refetchInterval: 60_000,
    }),
    settings: queryOptions({
      queryKey: ["settings"] as QueryKey,
      queryFn: ({ signal }) => result(api.getRuntimeSettings({ signal })),
      refetchOnWindowFocus: false,
    }),
    orders: queryOptions({
      queryKey: ["orders", "recent", clientId] as QueryKey,
      queryFn: ({ signal }) => result(api.listAdministratorOrders({ query: { limit: 5, ...(clientId ? { api_client_id: clientId } : {}) }, signal })),
      refetchInterval: 60_000,
      refetchIntervalInBackground: false,
      refetchOnMount: "always",
    }),
    work: queryOptions({
      queryKey: ["work-items", "recent", clientId, "priority"] as QueryKey,
      queryFn: ({ signal }) => result(api.listAdministratorWorkItems({ query: { limit: 4, sort_by: "priority", sort_order: "desc", ...(clientId ? { api_client_id: clientId } : {}) }, signal })),
      refetchInterval: 60_000,
      refetchIntervalInBackground: false,
      refetchOnMount: "always",
    }),
    workSummary: queryOptions({
      queryKey: ["work-items", "summary", clientId] as QueryKey,
      queryFn: ({ signal }) => result(api.getAdministratorWorkItemSummary({ query: { api_client_id: clientId! }, signal })),
      enabled: !!clientId,
      refetchInterval: 60_000,
    }),
  };
}

export function siteOverviewQueryOptions(range: 7 | 30 | 90, pageSize: 10 | 30 = 10) {
  return infiniteQueryOptions({
    queryKey: ["site-overview", range, pageSize],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => result(api.listSiteOverview({
      query: { range, limit: pageSize, ...(pageParam ? { cursor: pageParam } : {}) },
      signal,
    })),
    getNextPageParam: page => page.page.next_cursor ?? undefined,
    staleTime: 0,
    refetchInterval: 60_000,
  });
}

export function orderFilters(search: URLSearchParams) {
  const payment = search.get("payment");
  const checkout = search.get("checkout");
  return {
    payment: ["UNPAID", "CONFIRMED", "DISPUTED"].includes(payment ?? "") ? payment as PaymentStatus : undefined,
    checkout: ["OPEN", "CLOSED", "EXPIRED"].includes(checkout ?? "") ? checkout as CheckoutStatus : undefined,
  };
}

export function ordersQuery(clientId: string | null, list: ListRead<OrderSort>, cursor: string | undefined, payment: PaymentStatus | undefined, checkout: CheckoutStatus | undefined, accountId?: string) {
  const api = workspaceApi(clientId);
  return queryOptions({
    ...retainListData(["orders", clientId, payment, checkout, accountId], list.query),
    queryKey: ["orders", payment, checkout, cursor, list.scope, clientId, accountId] as QueryKey,
    queryFn: ({ signal }) => result(api.listAdministratorOrders({
      signal,
      query: {
        limit: 20,
        ...list.apiQuery,
        ...(clientId ? { api_client_id: clientId } : {}),
        ...(payment ? { payment_status: payment } : {}),
        ...(checkout ? { checkout_status: checkout } : {}),
        ...(accountId ? { alipay_account_id: accountId } : {}),
        ...(cursor ? { cursor } : {}),
      },
    })),
  });
}

export function notificationStatus(search: URLSearchParams): WebhookDeliveryStatus | undefined {
  const status = search.get("status");
  return ["PENDING", "LEASED", "RETRY_WAIT", "ACKNOWLEDGED", "DEAD_LETTER"].includes(status ?? "") ? status as WebhookDeliveryStatus : undefined;
}

export function notificationsQuery(clientId: string | null, list: ListRead<NotificationSort>, cursor: string | undefined, status: WebhookDeliveryStatus | undefined) {
  const api = workspaceApi(clientId);
  return queryOptions({
    ...retainListData(["notifications", clientId, status], list.query),
    queryKey: ["notifications", status, cursor, list.scope, clientId] as QueryKey,
    queryFn: ({ signal }) => result(api.listWebhookDeliveries({
      signal,
      query: {
        limit: 20,
        ...list.apiQuery,
        ...(clientId ? { api_client_id: clientId } : {}),
        ...(status ? { status } : {}),
        ...(cursor ? { cursor } : {}),
      },
    })),
  });
}

export function workItemFilters(search: URLSearchParams, clientId: string | null) {
  const selected = search.get("type");
  const type = ["ALL", "FINANCIAL_EXCEPTION", "LEDGER_CONFLICT", "NOTIFICATION_FAILURE"]
    .find(value => value === selected && (!clientId || value !== "LEDGER_CONFLICT")) as AdminWorkItemTypeFilter | undefined;
  return {
    type: type ?? "ALL",
    visibility: (search.get("visibility") === "IGNORED" ? "IGNORED" : "ACTIVE") as WorkItemVisibility,
  };
}

export function workItemSortFields(visibility: WorkItemVisibility) {
  // Priority remains exclusive to the overview preview.
  return WORK_ITEM_SORT_FIELDS.filter(field => field !== "priority")
    .filter(field => visibility === "IGNORED" || field !== "ignored_at");
}

export function workItemsQuery(clientId: string | null, list: ListRead<WorkItemSort>, cursor: string | undefined, type: AdminWorkItemTypeFilter, visibility: WorkItemVisibility) {
  const api = workspaceApi(clientId);
  return queryOptions({
    ...retainListData(["work-items", clientId, type, visibility], list.query),
    queryKey: ["work-items", type, visibility, cursor, list.scope, clientId] as QueryKey,
    queryFn: ({ signal }) => result(api.listAdministratorWorkItems({
      signal,
      query: {
        type,
        visibility,
        limit: 20,
        ...list.apiQuery,
        ...(clientId ? { api_client_id: clientId } : {}),
        ...(cursor ? { cursor } : {}),
      },
    })),
  });
}
