import { useSearchParams } from "react-router";
import type { ListQuery, SortOrder } from "../../../src/shared/list-query";
export {
  ORDER_SORT_FIELDS,
  DELIVERY_SORT_FIELDS,
  MATCH_SORT_FIELDS,
  CONFLICT_SORT_FIELDS,
  EXCEPTION_SORT_FIELDS,
  WORK_ITEM_SORT_FIELDS,
  normalizeKeyword,
} from "../../../src/shared/list-query";
export type { ListQuery, SortOrder } from "../../../src/shared/list-query";
export function useListQuery<S extends string>(
  fields: readonly S[],
  defaultSort: S,
  defaultOrder: SortOrder,
) {
  const [search, setSearch] = useSearchParams();
  const sortBy = fields.includes(search.get("sort_by") as S)
    ? (search.get("sort_by") as S)
    : defaultSort;
  const sortOrder =
    search.get("sort_order") === "asc" || search.get("sort_order") === "desc"
      ? (search.get("sort_order") as SortOrder)
      : defaultOrder;
  const query: ListQuery<S> = {
    q: (search.get("q") ?? "").trim(),
    sortBy,
    sortOrder,
  };
  function update(values: Record<string, string | null>) {
    setSearch(
      (current) => {
        const next = new URLSearchParams(current);
        for (const [key, value] of Object.entries(values)) {
          if (value) next.set(key, value);
          else next.delete(key);
        }
        next.delete("cursor");
        next.delete("page");
        return next;
      },
      { replace: true },
    );
  }
  return {
    query,
    apiQuery: {
      ...(query.q ? { q: query.q } : {}),
      sort_by: query.sortBy,
      sort_order: query.sortOrder,
    },
    scope: JSON.stringify(query),
    update,
    setKeyword: (q: string) => update({ q }),
    setSort: (sortBy: string, sortOrder: SortOrder) =>
      update({ sort_by: sortBy, sort_order: sortOrder }),
    clear: () => update({ q: null, sort_by: null, sort_order: null }),
  };
}
export type ListQueryControl = Pick<
  ReturnType<typeof useListQuery>,
  "query" | "setKeyword" | "setSort" | "clear"
>;
