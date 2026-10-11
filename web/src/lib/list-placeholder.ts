import type { Query } from "@tanstack/react-query";
import type { ListQuery } from "@/lib/list-query";

/** Retain rows for a new sort only within the same resource and filters. */
export function retainListData(
  scope: readonly unknown[],
  { q, createdFrom, createdTo, sortBy, sortOrder }: ListQuery<string>,
) {
  const identity = JSON.stringify([scope, q, createdFrom, createdTo]);
  const sort = JSON.stringify([sortBy, sortOrder]);
  return {
    meta: { listDataScope: identity, listDataSort: sort },
    placeholderData: <T>(previousData: T | undefined, previousQuery: Pick<Query, "meta"> | undefined) =>
      previousQuery?.meta?.listDataScope === identity && previousQuery.meta.listDataSort !== sort
        ? previousData
        : undefined,
  };
}
