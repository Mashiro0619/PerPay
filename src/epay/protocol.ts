// SPDX-License-Identifier: MIT
import { constants, createHash, createPrivateKey, createPublicKey, KeyObject, sign, timingSafeEqual, verify } from "node:crypto";

export type EpayProtocol = "epay_v1" | "epay_v2";
export type EpayParameters = Readonly<Record<string, string>>;
export type EpaySignable = Readonly<Record<string, unknown>>;
export type EpayKey = string | KeyObject;

export class EpayProtocolError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "EpayProtocolError";
    this.code = code;
  }
}

const PHP_EMPTY = /^[\x00\x09\x0a\x0b\x0d\x20]*$/;
export const EPAY_NOTIFICATION_FIELDS = Object.freeze([
  "pid", "trade_no", "out_trade_no", "api_trade_no", "type", "trade_status",
  "addtime", "endtime", "name", "money", "param", "buyer", "timestamp", "sign", "sign_type",
]);

/** Decode exactly once, before any business field normalization or signature verification. */
export function parseEpayParameters(query: string, body?: string | Uint8Array): EpayParameters {
  let form = "";
  try { form = typeof body === "string" ? body : body ? new TextDecoder("utf-8", { fatal: true }).decode(body) : ""; }
  catch { throw new EpayProtocolError("invalid_parameters", "表单必须使用有效 UTF-8。"); }
  if (Buffer.byteLength(query) + Buffer.byteLength(form) > 64 * 1024) {
    throw new EpayProtocolError("invalid_parameters", "表单参数过大。");
  }
  const parameters: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const source of [query.startsWith("?") ? query.slice(1) : query, form]) {
    if (!source) continue;
    for (const pair of source.split("&")) {
      if (!pair) continue;
      const separator = pair.indexOf("=");
      const key = decodeComponent(separator < 0 ? pair : pair.slice(0, separator));
      const value = decodeComponent(separator < 0 ? "" : pair.slice(separator + 1));
      validateField(key, value);
      if (Object.hasOwn(parameters, key)) throw new EpayProtocolError("invalid_parameters", "参数名不能重复。");
      parameters[key] = value;
    }
  }
  return Object.freeze(parameters);
}

function decodeComponent(value: string): string {
  try { return decodeURIComponent(value.replaceAll("+", " ")); }
  catch { throw new EpayProtocolError("invalid_parameters", "表单包含无效编码。"); }
}

function validateField(key: string, value: string): void {
  if (!key || /[\[\]&=\x00-\x20\x7f]/.test(key) || value.includes("&") || !key.isWellFormed() || !value.isWellFormed()) {
    throw new EpayProtocolError("invalid_parameters", "参数包含数组、非法参数名或不支持的 & 字符。");
  }
}

/** PHP SDK skips arrays and trim-empty scalars, while preserving the original non-empty value. */
export function epaySigningContent(parameters: EpaySignable, protocol: EpayProtocol = "epay_v2"): string {
  const entries: string[] = [];
  for (const key of Object.keys(parameters).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const value = parameters[key];
    if (key === "sign" || key === "sign_type" || value === null || value === undefined || typeof value === "object") continue;
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw new EpayProtocolError("invalid_parameters", "签名参数必须为标量。");
    }
    if (typeof value === "number" && !Number.isFinite(value)) throw new EpayProtocolError("invalid_parameters", "签名参数包含无效数字。");
    const text = typeof value === "boolean" ? (value ? "1" : "") : String(value);
    if (protocol === "epay_v1" ? text === "" : PHP_EMPTY.test(text)) continue;
    validateField(key, text);
    entries.push(`${key}=${text}`);
  }
  return entries.join("&");
}

export function signEpayV1(parameters: EpaySignable, key: string): string {
  if (!key) throw new EpayProtocolError("invalid_key", "易支付密钥未配置。");
  return createHash("md5").update(epaySigningContent(parameters, "epay_v1") + key, "utf8").digest("hex");
}

export function verifyEpayV1(parameters: EpaySignable, key: string): boolean {
  const actual = parameters.sign;
  if (typeof actual !== "string" || !/^[a-f0-9]{32}$/.test(actual) ||
      (parameters.sign_type !== undefined && parameters.sign_type !== "MD5")) return false;
  const expected = signEpayV1(parameters, key);
  return timingSafeEqual(Buffer.from(actual, "ascii"), Buffer.from(expected, "ascii"));
}

export function parseEpayRsaKey(value: EpayKey, kind: "private" | "public"): KeyObject {
  try {
    let material = value;
    if (typeof material === "string" && !material.includes("-----BEGIN")) {
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(material)) throw new Error("Invalid base64");
      const label = kind === "private" ? "PRIVATE KEY" : "PUBLIC KEY";
      material = `-----BEGIN ${label}-----\n${material}\n-----END ${label}-----`;
    }
    const key = material instanceof KeyObject ? material : kind === "private" ? createPrivateKey(material) : createPublicKey(material);
    if (key.type !== kind || key.asymmetricKeyType !== "rsa" || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) {
      throw new Error("Invalid RSA key");
    }
    return key;
  } catch { throw new EpayProtocolError("invalid_key", "易支付 RSA 密钥无效，需使用至少 2048 位密钥。"); }
}

export function signEpayV2(parameters: EpaySignable, key: EpayKey): string {
  return sign("RSA-SHA256", Buffer.from(epaySigningContent(parameters)), {
    key: parseEpayRsaKey(key, "private"), padding: constants.RSA_PKCS1_PADDING,
  }).toString("base64");
}

export function verifyEpayV2(parameters: EpaySignable, key: EpayKey): boolean {
  const signature = parameters.sign;
  if (typeof signature !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature) ||
      (parameters.sign_type !== undefined && parameters.sign_type !== "RSA")) return false;
  const bytes = Buffer.from(signature, "base64");
  if (bytes.toString("base64") !== signature) return false;
  return verify("RSA-SHA256", Buffer.from(epaySigningContent(parameters)), {
    key: parseEpayRsaKey(key, "public"), padding: constants.RSA_PKCS1_PADDING,
  }, bytes);
}

export function assertEpayTimestamp(parameters: EpaySignable, nowMilliseconds = Date.now()): void {
  const timestamp = parameters.timestamp;
  if ((typeof timestamp !== "string" && typeof timestamp !== "number") || !/^\d{10}$/.test(String(timestamp)) ||
      !Number.isSafeInteger(nowMilliseconds) || Math.abs(Math.floor(nowMilliseconds / 1000) - Number(timestamp)) > 300) {
    throw new EpayProtocolError("invalid_timestamp", "时间戳须为 Unix 秒，且与服务器相差不超过 300 秒。");
  }
}

export function epayMoneyToCents(value: string): number {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value)) throw new EpayProtocolError("invalid_money", "金额须为最多两位小数的元字符串。");
  const [whole = "", fraction = ""] = value.split(".");
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (cents < 1n || cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new EpayProtocolError("invalid_money", "金额超出支持范围。");
  return Number(cents);
}

export function moneyFromCents(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new EpayProtocolError("invalid_money", "金额必须为非负整数分。");
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

export function truncateEpayName(value: string): string {
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character);
    if (bytes + size > 127) break;
    result += character;
    bytes += size;
  }
  return result;
}

export interface EpayNotificationOrder {
  readonly pid: string;
  readonly tradeNo: string;
  readonly outTradeNo: string;
  readonly name: string;
  readonly moneyCents: number;
  readonly param?: string | undefined;
  readonly apiTradeNo?: string | undefined;
  readonly buyer?: string | undefined;
  readonly addTime?: string | undefined;
  readonly endTime?: string | undefined;
}

export function buildEpayNotification(order: EpayNotificationOrder, protocol: EpayProtocol, key: EpayKey, nowMilliseconds = Date.now()): EpayParameters {
  const result: Record<string, string> = {
    pid: order.pid, trade_no: order.tradeNo, out_trade_no: order.outTradeNo,
    type: "alipay", trade_status: "TRADE_SUCCESS", name: order.name, money: moneyFromCents(order.moneyCents),
  };
  if (order.param !== undefined) result.param = order.param;
  if (protocol === "epay_v2") {
    if (order.apiTradeNo) result.api_trade_no = order.apiTradeNo;
    if (order.buyer) result.buyer = order.buyer;
    if (order.addTime) result.addtime = order.addTime;
    if (order.endTime) result.endtime = order.endTime;
    result.timestamp = String(Math.floor(nowMilliseconds / 1000));
    result.sign_type = "RSA";
    result.sign = signEpayV2(result, key);
  } else {
    if (typeof key !== "string") throw new EpayProtocolError("invalid_key", "V1 密钥须为字符串。");
    result.sign_type = "MD5";
    result.sign = signEpayV1(result, key);
  }
  return Object.freeze(result);
}

export function appendEpayParameters(target: string, parameters: EpayParameters): string {
  const url = new URL(target);
  const existing = parseEpayParameters(url.search);
  for (const name of Object.keys(existing)) {
    // PHP decodes dots as underscores in $_GET, changing the signed parameter name.
    if (name.includes(".")) throw new EpayProtocolError("invalid_return_url", "回调地址参数名不能包含点号，PHP 接收端会改变该名称。");
    if (EPAY_NOTIFICATION_FIELDS.includes(name)) throw new EpayProtocolError("invalid_return_url", "返回地址已有易支付保留参数。");
  }
  for (const [name, value] of Object.entries(parameters)) url.searchParams.append(name, value);
  return url.href;
}

/** Sign the complete delivered query, including the merchant's existing scalar parameters. */
export function buildEpayCallbackUrl(target: string, order: EpayNotificationOrder, protocol: EpayProtocol, key: EpayKey, nowMilliseconds = Date.now()): string {
  appendEpayParameters(target, {});
  const existing = parseEpayParameters(new URL(target).search);
  const notification = { ...buildEpayNotification(order, protocol, key, nowMilliseconds) };
  const parameters = { ...existing, ...notification };
  if (protocol === "epay_v2") notification.sign = signEpayV2(parameters, key);
  else {
    if (typeof key !== "string") throw new EpayProtocolError("invalid_key", "V1 密钥须为字符串。");
    notification.sign = signEpayV1(parameters, key);
  }
  return appendEpayParameters(target, notification);
}

export function isEpaySuccessAck(status: number, body: string | Uint8Array): boolean {
  if (status < 200 || status >= 300) return false;
  try { return (typeof body === "string" ? body : new TextDecoder("utf-8", { fatal: true }).decode(body)).trim() === "success"; }
  catch { return false; }
}
