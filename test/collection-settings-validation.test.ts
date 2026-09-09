import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collectionSettingsInputSchema } from "../src/settings/model.ts";
import { collectionCodeError } from "../src/shared/collection-code.ts";

const parse = (code_payload: string) => collectionSettingsInputSchema.safeParse({ revision: 0, code_payload, order_ttl_seconds: 300, amount_offset_maximum_cents: 99 });

describe("Alipay collection payload validation", () => {
  for (const code of ["https://qr.alipay.com/fkx-test-code", "HTTPS://QR.ALIPAY.COM/FKXTEST", "http://qr.alipay.com/test", "https://qr.alipay.com/test?value=a%2Fb&note=收款"]) {
    it("preserves a supported original QR link: " + code, () => {
      assert.equal(collectionCodeError(code), null);
      const result = parse(code); assert.ok(result.success); assert.equal(result.data.code_payload, code);
    });
  }
  for (const code of ["not-a-payment-code", "https://example.invalid/pay", "https://qr.alipay.com.evil.invalid/pay", "https://qr.alipay.com@evil.invalid/pay", "https://user@qr.alipay.com/pay", "https://qr.alipay.com:443/pay", "alipays://platformapi/startapp?appId=20000067", "https://qr.alipay.com/", "https://qr.alipay.com/pay#fragment", "https://qr.alipay.com/../pay", " https://qr.alipay.com/pay", "https://qr.alipay.com/pay\n", "https://qr.alipay.com\\@evil.invalid/pay", "https://qr.alipay.com/pay?x=\ud800"]) {
    it("rejects unsupported or misleading content: " + JSON.stringify(code), () => {
      assert.ok(collectionCodeError(code)); assert.equal(parse(code).success, false);
    });
  }
  it("retains the UTF-8 capacity limit", () => {
    const prefix = "https://qr.alipay.com/test?x=";
    const exact = prefix + "a".repeat(2331 - prefix.length);
    assert.equal(parse(exact).success, true);
    assert.equal(parse(exact + "a").success, false);
    assert.equal(parse(prefix + "中".repeat(800)).success, false);
  });
});
