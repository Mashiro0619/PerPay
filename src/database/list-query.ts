import type { ListPosition, SortOrder } from "../shared/list-query.ts";
import { ListQueryError } from "../shared/list-query.ts";

/** SQL expressions and tie-break columns must come only from application whitelists. */
export function listKeyset(
  expression: string,
  keys: readonly string[],
  order: SortOrder,
  position: ListPosition | null | undefined,
  nullable = false,
) {
  const direction = order === "asc" ? "ASC" : "DESC";
  const compare = order === "asc" ? ">" : "<";
  const orderBy =
    expression +
    " " +
    direction +
    (nullable ? " NULLS LAST" : "") +
    ", " +
    keys.map((key) => key + " " + direction).join(", ");
  if (!position)
    return { orderBy, where: "", parameters: [] as Array<string | number> };
  const value = position.value;
  if (
    position.keys.length !== keys.length ||
    position.keys.some((key) => typeof key !== "string") ||
    (value !== null &&
      typeof value !== "string" &&
      !(typeof value === "number" && Number.isSafeInteger(value))) ||
    (!nullable && value === null)
  )
    throw new ListQueryError("分页游标无效");
  const tie = keys.length === 1 ? keys[0]! : "(" + keys.join(", ") + ")";
  const slots =
    keys.length === 1 ? "?" : "(" + keys.map(() => "?").join(", ") + ")";
  const tail = tie + " " + compare + " " + slots;
  if (value === null)
    return {
      orderBy,
      where: "(" + expression + " IS NULL AND " + tail + ")",
      parameters: [...position.keys],
    };
  return {
    orderBy,
    where:
      "(" +
      expression +
      " " +
      compare +
      " ? OR (" +
      expression +
      " = ? AND " +
      tail +
      ")" +
      (nullable ? " OR " + expression + " IS NULL" : "") +
      ")",
    parameters: [value, value, ...position.keys],
  };
}
/** instr uses literal text; percent, underscore and quotes never become LIKE patterns. */
export function listSearch(columns: readonly string[], q: string) {
  return q
    ? {
        where:
          "(" +
          columns
            .map((column) => "instr(COALESCE(" + column + ", ''), ?) > 0")
            .join(" OR ") +
          ")",
        parameters: columns.map(() => q),
      }
    : { where: "", parameters: [] as string[] };
}
