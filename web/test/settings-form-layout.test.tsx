import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SitePolicyFields } from "../src/components/SitePolicyFields";
import type { SitePolicy } from "../src/api/client";
const value: SitePolicy = {
  orders: {
    order_ttl_seconds: 300,
    amount_offset_maximum_cents: 99,
    amount_reuse_cooldown_seconds: 600,
    pending_order_limit: null,
  },
  display: {
    checkout_name: "网站",
    checkout_help_url: null,
    checkout_show_product_name: true,
  },
  notification_delivery: {
    timeout_milliseconds: 5000,
    maximum_attempts: 3,
    retry_base_seconds: 5,
    retry_maximum_seconds: 60,
  },
};
describe("readable settings form structure", () => {
  it("keeps labels separate from inputs with explicit associations and error descriptions", () => {
    const view = render(
      <SitePolicyFields
        value={value}
        onChange={vi.fn()}
        errors={{
          "configuration.policy.orders.order_ttl_seconds": "有效期错误",
          "configuration.policy.orders.pending_order_limit": "容量错误",
        }}
      />,
    );
    expect(view.container.querySelectorAll("label input")).toHaveLength(0);
    for (const label of [
      "订单有效期（秒）",
      "最大尾差（分）",
      "金额复用冷却（秒）",
      "待付款订单上限",
      "收银台名称",
    ]) {
      const input = screen.getByLabelText(label);
      expect(input.id).not.toBe("");
      expect(
        view.container.querySelector(`label[for="${input.id}"]`),
      ).not.toBeNull();
    }
    expect(
      screen.getByLabelText("订单有效期（秒）"),
    ).toHaveAccessibleDescription("有效期错误");
    expect(screen.getByLabelText("待付款订单上限")).toHaveAccessibleDescription(
      "容量错误",
    );
    expect(view.container.querySelectorAll(".settings-fields")).toHaveLength(2);
  });
  it("uses unique control and error ids when multiple policy sections are mounted", () => {
    const view = render(
      <>
        <SitePolicyFields value={value} section="orders" onChange={vi.fn()} />
        <SitePolicyFields value={value} section="orders" onChange={vi.fn()} />
      </>,
    );
    const ids = [...view.container.querySelectorAll("[id]")].map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
