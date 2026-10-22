import { ListQueryError, normalizeKeyword } from "../shared/list-query.ts";
import type {
  ManualCandidateKind,
  ManualCandidateQuery,
} from "../reconciliation/manual-candidates.ts";
import { decodeListCursor, encodeListCursor } from "./list-cursor.ts";
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function readManualCandidateQuery(
  values: URLSearchParams,
  kind: ManualCandidateKind,
  siteClientId?: string,
) {
  const contextKey = kind === "orders" ? "ledger_entry_id" : "order_id";
  const allowed = new Set([contextKey, "q", "view", "cursor", "limit"]);
  for (const key of values.keys())
    if (!allowed.has(key) || values.getAll(key).length !== 1)
      throw new ListQueryError("可能匹配的记录查询参数无效");
  const contextId = values.get(contextKey);
  if (
    (contextId !== null && !uuid.test(contextId)) ||
    (kind === "ledger-entries" && !contextId)
  )
    throw new ListQueryError("缺少有效的关联上下文");
  const view = values.get("view") ?? (contextId ? "recommended" : "all");
  if (
    (view !== "recommended" && view !== "all") ||
    (view === "recommended" && !contextId)
  )
    throw new ListQueryError("可能匹配的记录视图无效");
  const q = normalizeKeyword(values.get("q") ?? "");
  const limitText = values.get("limit") ?? "10";
  if (!/^[1-9][0-9]{0,2}$/.test(limitText) || Number(limitText) > 100)
    throw new ListQueryError("可能匹配的记录页大小无效");
  const resource = "manual-settlement-" + kind;
  const binding = siteClientId === undefined
    ? [contextId, q, view]
    : [contextId, q, view, siteClientId];
  const cursor = values.get("cursor");
  const position =
    cursor === null
      ? null
      : decodeListCursor(cursor, resource, binding, "number", 3);
  if (cursor !== null && position === null)
    throw new ListQueryError("可能匹配的记录分页游标无效");
  const query: ManualCandidateQuery = {
    contextId,
    q,
    view,
    limit: Number(limitText),
    position,
    ...(siteClientId === undefined ? {} : { siteClientId }),
  };
  return {
    query,
    encode: (next: ManualCandidateQuery["position"]) =>
      encodeListCursor(resource, binding, next),
  };
}
