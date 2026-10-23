import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CheckoutApp } from "../src/checkout/CheckoutApp";
import type { CheckoutInitial, CheckoutViewOrder } from "../../src/shared/checkout-view";

function markup(
  basis: CheckoutViewOrder["payment"]["basis"],
  status: CheckoutViewOrder["payment"]["status"] = "CONFIRMED",
  refund: CheckoutViewOrder["refund"]["status"] = "NONE",
  systemName = "PerPay",
) {
  const initial: CheckoutInitial = {
    systemName, serverTime: Date.UTC(2026, 9, 21), initialError: null,
    apiUrl: "/api/public/v1/checkouts/synthetic-source-copy", qrUrl: "/synthetic-qr.svg", qrAvailable: false,
    checkout: {
      merchant_order_no: "merchant-source-number", product_name: "付款依据核对", currency: "CNY",
      requested_amount_cents: 1000, return_url: null, payment_instructions: null,
      checkout: { status: "CLOSED", expires_at: "2026-10-21T00:00:00Z", closed_at: "2026-10-21T00:00:00Z" },
      payment: { status, basis, received_amount_cents: 1001 }, refund: { status: refund },
    },
  };
  return renderToString(<CheckoutApp initial={initial} />);
}

describe("checkout presents payment results without internal confirmation explanations", () => {
  it("shows the confirmed result, amount and order without automatic inference details in the first render", () => {
    const html = markup("INFERRED");
    expect(html).toContain("收款已确认");
    expect(html).toContain("¥10.01");
    expect(html).toContain("merchant-source-number");
    expect(html).not.toContain("按支付宝流水的金额和付款时间推断");
    expect(html).not.toContain("商家管理员已根据支付宝流水人工确认");
    expect(html).not.toContain("data-qr-image");
  });
  it("shows manual confirmation as the payment result without an internal explanation", () => {
    const html = markup("MANUAL");
    expect(html).toContain("收款已确认");
    expect(html).toContain("¥10.01");
    expect(html).not.toContain("商家管理员已根据支付宝流水人工确认这笔收款");
    expect(html).not.toContain("付款时间推断");
  });
  it("does not invent a confirmation basis when it is unavailable", () => {
    const html = markup("NONE");
    expect(html).toContain("收款已确认");
    expect(html).not.toContain("付款时间推断");
    expect(html).not.toContain("商家管理员已根据支付宝流水人工确认");
  });
  it("keeps disputed payments actionable without describing internal reversal details", () => {
    const html = markup("INFERRED", "DISPUTED");
    expect(html).toContain("付款待核实");
    expect(html).toContain("请联系商家核实，勿重复付款。");
    expect(html).not.toContain("商家撤销了这笔收款确认");
    expect(html).not.toContain("已确认这笔收款");
    expect(html).not.toContain("data-qr-image");
  });
  it.each([["PARTIAL", "部分"], ["FULL", "全额"]] as const)("identifies %s as historical refund data", (refund, label) => {
    const html = markup("MANUAL", "CONFIRMED", refund);
    expect(html).toContain("历史退款记录：" + label);
    expect(html).toContain("具体金额请联系商家");
    expect(html).not.toContain("款项已");
    expect(html).not.toContain("refund_mark");
  });
  it("escapes the configured system name in the checkout identity", () => {
    const html = markup("INFERRED", "CONFIRMED", "NONE", "<script>example</script>");
    expect(html).toContain("&lt;script&gt;example&lt;/script&gt;");
    expect(html).not.toContain("<script>example</script>");
  });
});
