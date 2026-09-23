export type SortOrder = "asc" | "desc";
export interface ListQuery<Sort extends string = string> {
  readonly q: string;
  readonly sortBy: Sort;
  readonly sortOrder: SortOrder;
}
export interface ListPosition {
  readonly value: number | string | null;
  readonly keys: readonly string[];
}
export const ORDER_SORT_FIELDS = [
  "created_at",
  "payable_amount_cents",
  "received_amount_cents",
] as const;
export type OrderSort = (typeof ORDER_SORT_FIELDS)[number];
export const DELIVERY_SORT_FIELDS = [
  "created_at",
  "attempt_count",
  "next_attempt_at",
] as const;
export type DeliverySort = (typeof DELIVERY_SORT_FIELDS)[number];
export class ListQueryError extends Error {}
export function normalizeKeyword(value: string): string {
  const q = value.trim();
  if (
    Array.from(q).length > 100 ||
    q.includes("\0") ||
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
      q,
    )
  )
    throw new ListQueryError("关键词须为不超过100个Unicode字符的普通文本");
  return q;
}
export function normalizeListQuery<S extends string>(
  input: Partial<ListQuery> | undefined,
  fields: readonly S[],
  defaultSort: S,
  defaultOrder: SortOrder,
): ListQuery<S> {
  const sortBy = input?.sortBy ?? defaultSort;
  const sortOrder = input?.sortOrder ?? defaultOrder;
  if (
    !fields.includes(sortBy as S) ||
    (sortOrder !== "asc" && sortOrder !== "desc")
  )
    throw new ListQueryError("排序字段或方向无效");
  return {
    q: normalizeKeyword(input?.q ?? ""),
    sortBy: sortBy as S,
    sortOrder,
  };
}
export function readListQuery<S extends string>(
  values: URLSearchParams,
  fields: readonly S[],
  defaultSort: S,
  defaultOrder: SortOrder,
): ListQuery<S> {
  for (const key of ["q", "sort_by", "sort_order"])
    if (values.getAll(key).length > 1)
      throw new ListQueryError("查询参数不能重复");
  return normalizeListQuery(
    {
      q: values.get("q") ?? "",
      sortBy: values.get("sort_by") ?? defaultSort,
      sortOrder: (values.get("sort_order") ?? defaultOrder) as SortOrder,
    },
    fields,
    defaultSort,
    defaultOrder,
  );
}
export function isDefaultQuery(
  query: ListQuery,
  field: string,
  order: SortOrder,
): boolean {
  return query.q === "" && query.sortBy === field && query.sortOrder === order;
}

export const MATCH_SORT_FIELDS = [
  "event_sequence",
  "created_at",
  "amount_cents",
] as const;
export type MatchSort = (typeof MATCH_SORT_FIELDS)[number];
export const CONFLICT_SORT_FIELDS = [
  "created_at",
  "external_event_id",
] as const;
export type ConflictSort = (typeof CONFLICT_SORT_FIELDS)[number];
export const EXCEPTION_SORT_FIELDS = ["created_at"] as const;
export type ExceptionSort = (typeof EXCEPTION_SORT_FIELDS)[number];
export const WORK_ITEM_SORT_FIELDS = [
  "actionable_at",
  "created_at",
  "ignored_at",
] as const;
export type WorkItemSort = (typeof WORK_ITEM_SORT_FIELDS)[number];
