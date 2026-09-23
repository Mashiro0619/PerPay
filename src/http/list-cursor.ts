import { createHash } from "node:crypto";
import { ListQueryError, type ListPosition } from "../shared/list-query.ts";
const PREFIX = "perpay:list:v1";
function fingerprint(binding: unknown): string {
  return createHash("sha256").update(JSON.stringify(binding)).digest("hex");
}
export function encodeListCursor(
  resource: string,
  binding: unknown,
  position: ListPosition | null,
): string | null {
  return position
    ? Buffer.from(
        JSON.stringify([
          PREFIX,
          resource,
          fingerprint(binding),
          position.value,
          position.keys,
        ]),
        "utf8",
      ).toString("base64url")
    : null;
}
/** A null result denotes an old textual cursor. Its resource-specific decoder still validates it. */
export function decodeListCursor(
  value: string,
  resource: string,
  binding: unknown,
  valueType: "number" | "string",
  keyCount = 1,
): ListPosition | null {
  const invalid = () => new ListQueryError("分页游标无效或不属于当前查询");
  if (!/^[A-Za-z0-9_-]{1,2048}$/.test(value)) throw invalid();
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) throw invalid();
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw invalid();
  }
  if (text.startsWith("perpay:")) return null;
  let parts: unknown;
  try {
    parts = JSON.parse(text);
  } catch {
    throw invalid();
  }
  if (
    !Array.isArray(parts) ||
    parts.length !== 5 ||
    parts[0] !== PREFIX ||
    parts[1] !== resource ||
    parts[2] !== fingerprint(binding) ||
    (parts[3] !== null &&
      (typeof parts[3] !== valueType ||
        (valueType === "number" &&
          (!Number.isSafeInteger(parts[3]) || parts[3] < 0)) ||
        (valueType === "string" && parts[3].length > 512))) ||
    !Array.isArray(parts[4]) ||
    parts[4].length !== keyCount ||
    parts[4].some(
      (key: unknown) =>
        typeof key !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(key),
    )
  )
    throw invalid();
  return { value: parts[3], keys: parts[4] };
}
