import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import {
  appendEpayParameters, assertEpayTimestamp, buildEpayCallbackUrl, buildEpayNotification, epayMoneyToCents,
  epaySigningContent, isEpaySuccessAck, moneyFromCents, parseEpayParameters,
  signEpayV1, signEpayV2, truncateEpayName, verifyEpayV1, verifyEpayV2,
} from "../src/epay/protocol.ts";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const now = 1_793_981_234_000;

test("form decoding preserves signed values and rejects ambiguous encodings and parameter sources", () => {
  const fields = parseEpayParameters("name=%E4%B8%AD%E6%96%87+%2B%3D%2526&zero=0", "empty=");
  assert.equal(fields.name, "中文 +=%26");
  assert.equal(fields.zero, "0");
  assert.equal(fields.empty, "");
  for (const query of ["pid=1&pid=2", "x%5B%5D=1", "x=a%26b", "x=%FF", "x=%xx", "a%3Db=x"]) {
    assert.throws(() => parseEpayParameters(query));
  }
  assert.throws(() => parseEpayParameters("pid=1", "pid=1"));
  assert.throws(() => parseEpayParameters("", new Uint8Array([0xff])));
});

test("V1 and V2 keep their PHP SDK empty-value rules and preserve zero", () => {
  const fields = { name: "中文 +=%26", zero: "0", blank: " ", empty: "", nullable: null, data: [{ code: 0 }] };
  assert.equal(epaySigningContent(fields, "epay_v1"), "blank= &name=中文 +=%26&zero=0");
  assert.equal(epaySigningContent(fields), "name=中文 +=%26&zero=0");
  const expected = createHash("md5").update("blank= &name=中文 +=%26&zero=0secret").digest("hex");
  assert.equal(signEpayV1(fields, "secret"), expected);
  assert.equal(verifyEpayV1({ ...fields, sign: expected, sign_type: "MD5" }, "secret"), true);
  assert.equal(verifyEpayV1({ ...fields, zero: "1", sign: expected }, "secret"), false);
});

test("V2 signs scalar response fields including code zero while excluding list arrays", () => {
  const fields = { code: 0, msg: "success", data: [{ money: "1.00" }], timestamp: String(now / 1000) };
  const signature = signEpayV2(fields, keys.privateKey);
  assert.equal(verifyEpayV2({ ...fields, sign: signature, sign_type: "RSA" }, keys.publicKey), true);
  assert.equal(verifyEpayV2({ ...fields, data: [], sign: signature }, keys.publicKey), true);
  assert.equal(verifyEpayV2({ ...fields, code: 1, sign: signature }, keys.publicKey), false);
  const privateBase64 = keys.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  const publicBase64 = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  assert.equal(verifyEpayV2({ ...fields, sign: signEpayV2(fields, privateBase64) }, publicBase64), true);
});

test("V2 timestamp tolerance includes both exact 300-second boundaries", () => {
  for (const offset of [-300, 0, 300]) assertEpayTimestamp({ timestamp: String(now / 1000 + offset) }, now);
  for (const offset of [-301, 301]) assert.throws(() => assertEpayTimestamp({ timestamp: String(now / 1000 + offset) }, now));
  assert.throws(() => assertEpayTimestamp({ timestamp: String(now) }, now));
});

test("money parsing is exact and truncation keeps complete UTF-8 characters", () => {
  assert.equal(epayMoneyToCents("10.03"), 1003);
  assert.equal(epayMoneyToCents("10.0"), 1000);
  for (const value of ["0", "1.001", "1e2", "-1", "NaN", " 1.00", "1.", "01.00"]) assert.throws(() => epayMoneyToCents(value));
  assert.equal(moneyFromCents(1003), "10.03");
  const name = truncateEpayName("中".repeat(43));
  assert.equal(name, "中".repeat(42));
  assert.equal(Buffer.byteLength(name), 126);
});

test("notification and browser return carry original price and refresh V2 signatures on retries", () => {
  const order = { pid: "1001", tradeNo: "202611070001", outTradeNo: "SHOP-1", name: "商品", moneyCents: 1000, param: "0" };
  const first = buildEpayNotification(order, "epay_v2", keys.privateKey, now);
  const retry = buildEpayNotification(order, "epay_v2", keys.privateKey, now + 1000);
  assert.equal(first.money, "10.00");
  assert.notEqual(first.sign, retry.sign);
  assert.equal(verifyEpayV2(retry, keys.publicKey), true);
  assert.equal(new URL(appendEpayParameters("https://shop.example/return?source=demo", first)).searchParams.get("source"), "demo");
  assert.throws(() => appendEpayParameters("https://shop.example/return?money=9.00", first));
  const callback = buildEpayCallbackUrl("https://shop.example/return?source=demo%2B%3D%2526", order, "epay_v2", keys.privateKey, now);
  const delivered = parseEpayParameters(new URL(callback).search);
  assert.equal(delivered.source, "demo+=%26");
  assert.equal(verifyEpayV2(delivered, keys.publicKey), true);
  assert.throws(() => buildEpayCallbackUrl("https://shop.example/return?source=a&source=b", order, "epay_v2", keys.privateKey, now));
  for (const status of [200, 201, 204, 299]) assert.equal(isEpaySuccessAck(status, " success\n"), true);
  for (const body of ["SUCCESS", "successx", "{\"success\":true}"]) assert.equal(isEpaySuccessAck(200, body), false);
  assert.equal(isEpaySuccessAck(302, "success"), false);
});
