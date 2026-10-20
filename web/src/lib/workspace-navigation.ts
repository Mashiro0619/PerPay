import { onlineManager, type FetchQueryOptions } from "@tanstack/react-query";
import { getSessionRequestGeneration, queryClient, sessionKey, type AdminSessionEnvelope } from "@/api/client";
import {
  notificationStatus,
  notificationsQuery,
  orderFilters,
  ordersQuery,
  overviewQueries,
  overviewRange,
  siteOverviewQueryOptions,
  workItemFilters,
  workItemSortFields,
  workItemsQuery,
} from "@/api/workspace-queries";
import { DELIVERY_SORT_FIELDS, ORDER_SORT_FIELDS, readListQuery } from "@/lib/list-query";
import { siteEditorQueryOptions } from "@/lib/site-editor-query";
import { workspaceQueryKey } from "@/lib/workspace-query-key";
import { workspaceSiteQuery } from "@/workspace";

function authenticatedSession() {
  const session = queryClient.getQueryState<AdminSessionEnvelope | null>(sessionKey);
  return session?.status === "success" && typeof session.data?.data?.username === "string"
    ? session.data
    : null;
}

/** Stop waiting promptly without cancelling a read that another observer may share. */
function untilNavigationEnds(promise: Promise<unknown>, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let unsubscribe: (() => void) | undefined;
    const cleanup = () => {
      signal.removeEventListener("abort", aborted);
      unsubscribe?.();
    };
    const aborted = () => {
      cleanup();
      resolve(false);
    };
    if (signal.aborted || !onlineManager.isOnline()) aborted();
    else {
      signal.addEventListener("abort", aborted, { once: true });
      unsubscribe = onlineManager.subscribe(online => { if (!online) aborted(); });
    }
    promise.then(
      () => {
        cleanup();
        resolve(!signal.aborted);
      },
      error => {
        cleanup();
        reject(error);
      },
    );
  });
}

/** Prepare an authenticated destination while the router still displays its original workspace. */
export async function prepareWorkspaceNavigation(request: Request, clientId: string | null, localPath: string): Promise<null> {
  const session = authenticatedSession();
  if (!session || request.signal.aborted || !onlineManager.isOnline()) return null;
  const generation = getSessionRequestGeneration();
  const { username, absolute_expires_at: absoluteExpiresAt } = session.data;
  try {
    if (clientId && !await untilNavigationEnds(queryClient.fetchQuery(workspaceSiteQuery(clientId)), request.signal)) return null;
    // A cancelled navigation, logout, or replacement session must not start its next stage.
    // Extending the same session's idle expiry must not interrupt preparation.
    const currentSession = authenticatedSession();
    if (request.signal.aborted || !currentSession || !onlineManager.isOnline() ||
      getSessionRequestGeneration() !== generation ||
      currentSession.data.username !== username ||
      currentSession.data.absolute_expires_at !== absoluteExpiresAt) return null;
    const search = new URL(request.url).searchParams;
    const cursor = search.get("cursor") || undefined;
    const reads: Promise<unknown>[] = [];
    const prepare = <T>(options: FetchQueryOptions<T>) => queryClient.prefetchQuery({
      ...options,
      queryKey: workspaceQueryKey(options.queryKey, clientId),
    });
    if (localPath === "/") {
      const range = overviewRange(search);
      const options = overviewQueries(clientId, range);
      reads.push(prepare(options.analytics), prepare(options.settings), prepare(options.orders), prepare(options.work));
      if (clientId) reads.push(prepare(options.workSummary));
      // Reuse loaded pages; the mounted hook refreshes them without delaying the route.
      else reads.push(queryClient.ensureInfiniteQueryData({ ...siteOverviewQueryOptions(range), revalidateIfStale: false }));
    } else if (localPath === "/orders") {
      const list = readListQuery(search, ORDER_SORT_FIELDS, "created_at", "desc", true);
      const { payment, checkout } = orderFilters(search);
      reads.push(prepare(ordersQuery(clientId, list, cursor, payment, checkout)));
    } else if (localPath === "/notifications") {
      const list = readListQuery(search, DELIVERY_SORT_FIELDS, "created_at", "desc", true);
      reads.push(prepare(notificationsQuery(clientId, list, cursor, notificationStatus(search))));
    } else if (localPath === "/work-items") {
      const { type, visibility } = workItemFilters(search, clientId);
      const list = readListQuery(search, workItemSortFields(visibility), visibility === "IGNORED" ? "ignored_at" : "actionable_at", "desc");
      reads.push(prepare(workItemsQuery(clientId, list, cursor, type, visibility)));
    } else if (clientId && /^\/settings(?:\/(?:basic|orders|integration|display))?$/.test(localPath)) {
      reads.push(queryClient.prefetchQuery(siteEditorQueryOptions(clientId)));
    }
    await untilNavigationEnds(Promise.allSettled(reads), request.signal);
  } catch {
    // Queries retain their own error state; the workspace/page boundary owns its recovery UI.
  }
  return null;
}
