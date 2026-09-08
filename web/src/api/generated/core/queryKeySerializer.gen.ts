
export type JsonValue =
  | null
  | string
  | number
  | boolean
  | JsonValue[]
  | { [key: string]: JsonValue };
export const queryKeyJsonReplacer = (_key: string, value: unknown): unknown | undefined => {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return undefined;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return value;
};
export const stringifyToJsonValue = (input: unknown): JsonValue | undefined => {
  try {
    const json = JSON.stringify(input, queryKeyJsonReplacer);
    if (json === undefined) {
      return undefined;
    }
    return JSON.parse(json) as JsonValue;
  } catch {
    return undefined;
  }
};
const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const prototype = Object.getPrototypeOf(value as object);
  return prototype === Object.prototype || prototype === null;
};
const serializeSearchParams = (params: URLSearchParams): JsonValue => {
  const entries = Array.from(params.entries()).sort(([a], [b]) => a.localeCompare(b));
  const result: Record<string, JsonValue> = {};
  for (const [key, value] of entries) {
    const existing = result[key];
    if (existing === undefined) {
      result[key] = value;
      continue;
    }
    if (Array.isArray(existing)) {
      (existing as string[]).push(value);
    } else {
      result[key] = [existing, value];
    }
  }
  return result;
};
export const serializeQueryKeyValue = (value: unknown): JsonValue | undefined => {
  if (value === null) {
    return null;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return undefined;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return stringifyToJsonValue(value);
  }
  if (typeof URLSearchParams !== 'undefined' && value instanceof URLSearchParams) {
    return serializeSearchParams(value);
  }
  if (isPlainObject(value)) {
    return stringifyToJsonValue(value);
  }
  return undefined;
};
