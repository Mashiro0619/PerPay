import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { SystemStatus } from "../src/api/client";
import { mountOnboarding, systemStatus } from "./onboarding-fixture";

const lastSuccess = Date.parse("2026-10-18T00:00:00.000Z");

function mount(ledger: Partial<SystemStatus["ledger"]>) {
  return mountOnboarding({
    stage: 4,
    path: "/",
    status: (settings) => {
      const status = systemStatus(settings);
      return {
        ...status,
        status: "not_ready",
        ledger: {
          ...status.ledger,
          collection_ready: false,
          last_success_at: lastSuccess,
          ...ledger,
        },
      };
    },
  });
}

async function pausedAlert() {
  const title = await screen.findByText("已暂停接收新订单", { selector: '[data-slot="alert-title"]' });
  const alert = within(title.closest<HTMLElement>('[role="alert"]')!);
  expect(alert.getByRole("link", { name: "查看运行状态" })).toHaveAttribute("href", "/system");
  return alert;
}

describe("dashboard collection readiness guidance", () => {
  it("reports stale collection after a previous success while preserving that success time", async () => {
    const view = mount({
      state: "degraded",
      last_success_age_milliseconds: 60_001,
      maximum_success_age_milliseconds: 60_000,
    });
    const alert = await pausedAlert();

    expect(alert.getByText("最近查账成功已超过有效时限，请查看运行状态")).toBeVisible();
    expect(alert.queryByText(/还没有成功查账/)).not.toBeInTheDocument();
    expect(view.container.querySelector("[data-ledger-freshness] time")).toHaveAttribute(
      "datetime", new Date(lastSuccess).toISOString(),
    );
    expect(view.router.state.location.pathname).toBe("/");
  });

  it.each([true, false])("reports a stopped collector with enabled=%s after a previous success", async (enabled) => {
    const view = mount({
      enabled,
      state: "stopped",
      last_success_age_milliseconds: enabled ? 1000 : null,
    });
    const alert = await pausedAlert();

    expect(alert.getByText("查账任务未运行，请查看运行状态")).toBeVisible();
    expect(alert.queryByText(/还没有成功查账|超过有效时限/)).not.toBeInTheDocument();
    expect(view.container.querySelector("[data-ledger-freshness] time")).toHaveAttribute(
      "datetime", new Date(lastSuccess).toISOString(),
    );
    expect(view.router.state.location.pathname).toBe("/");
  });

  it("asks for an initial successful collection only when no success has been recorded", async () => {
    const view = mount({
      state: "running",
      in_flight: true,
      last_success_at: null,
      last_success_age_milliseconds: null,
    });
    const alert = await pausedAlert();

    expect(alert.getByText("还没有成功查账，请检查支付宝账号")).toBeVisible();
    expect(alert.queryByText(/查账任务未运行|超过有效时限/)).not.toBeInTheDocument();
    expect(view.container.querySelector("[data-ledger-freshness]")).toHaveTextContent("最近查账成功：暂无记录");
    expect(view.container.querySelector("[data-ledger-freshness] time")).not.toBeInTheDocument();
  });

  it("keeps the reason neutral when a recorded success has no usable age", async () => {
    const view = mount({ last_success_age_milliseconds: null });
    const alert = await pausedAlert();

    expect(alert.getByText("查账暂未就绪，请查看运行状态")).toBeVisible();
    expect(alert.queryByText(/还没有成功查账|超过有效时限/)).not.toBeInTheDocument();
    expect(view.container.querySelector("[data-ledger-freshness] time")).toHaveAttribute(
      "datetime", new Date(lastSuccess).toISOString(),
    );
  });
});
