import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LedgerIngestionDiagnostics } from "../src/components/ledger-ingestion-diagnostics";
import type { LedgerDiagnostics } from "../src/api/generated/types.gen";
import { mountOnboarding, systemStatus } from "./onboarding-fixture";

function diagnostic(): LedgerDiagnostics {
  return { available: true, consecutive_failures: 3, in_flight: false, next_retry_at: "2026-10-05T04:00:08Z", latest_failure: {
    ingest_run_id: "11111111-1111-4111-8111-111111111111", ingest_segment_id: "22222222-2222-4222-8222-222222222222",
    scan_kind: "NORMAL", window_start: "2026-10-05T03:00:00Z", window_end: "2026-10-05T04:00:00Z", occurred_at: "2026-10-05T04:00:03Z",
    error_code: "pagination_invalid", reason: "账单流水时间超出本次查询窗口",
  } };
}

describe("ingestion failure presentation", () => {
  it("shows the persisted account count, controlled reason, window and real schedule without action buttons", () => {
    render(<LedgerIngestionDiagnostics diagnostics={diagnostic()} />);
    expect(screen.getByText("采集持续失败")).toBeVisible();
    expect(screen.getByText(/账户级连续失败 3 次/)).toBeVisible();
    expect(screen.getByText(/账单流水时间超出/)).toBeVisible();
    expect(screen.getByText(/^失败窗口：/)).toBeVisible();
    expect(screen.getByText(/计划下次尝试：.*12:00:08/)).toBeVisible();
    expect(screen.getByRole("link", { name: "安全恢复指引" })).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
  it("distinguishes compensation failures from the normal lane", () => {
    const data = diagnostic(); data.latest_failure!.scan_kind = "COMPENSATION_1H";
    render(<LedgerIngestionDiagnostics diagnostics={data} />);
    expect(screen.getByText(/历史补采，不代表正常采集也已停止/)).toBeVisible();
    expect(screen.queryByText(/最近失败属于正常采集/)).not.toBeInTheDocument();
  });
  it("does not show a scheduled time while running, or invent one when unknown", () => {
    const data = diagnostic(); data.in_flight = true;
    const { rerender } = render(<LedgerIngestionDiagnostics diagnostics={data} />);
    expect(screen.getByText("正在采集，请等待本轮结果。")).toBeVisible();
    expect(screen.queryByText(/计划下次尝试/)).not.toBeInTheDocument();
    rerender(<LedgerIngestionDiagnostics diagnostics={{ ...data, in_flight: false, next_retry_at: null }} />);
    expect(screen.getByText(/下次尝试时间尚未确定/)).toBeVisible();
  });
  it("clears the current alert on recovery, remains compatible with old responses, and distinguishes unavailable diagnostics", () => {
    const data = diagnostic(); data.consecutive_failures = 1;
    const { rerender } = render(<LedgerIngestionDiagnostics diagnostics={data} />);
    expect(screen.getByText("采集失败，等待恢复")).toBeVisible();
    expect(screen.queryByText("采集持续失败")).not.toBeInTheDocument();
    rerender(<LedgerIngestionDiagnostics diagnostics={{ ...data, consecutive_failures: 0, latest_failure: null }} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    rerender(<LedgerIngestionDiagnostics diagnostics={undefined} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    rerender(<LedgerIngestionDiagnostics diagnostics={{ ...data, available: false, consecutive_failures: null, latest_failure: null }} />);
    expect(screen.getByText("采集诊断暂不可用")).toBeVisible();
    expect(screen.queryByText(/等待恢复/)).not.toBeInTheDocument();
  });
  it("shows persisted failures on the actual System page even when in-memory counters reset", async () => {
    const status = systemStatus();
    status.ledger.diagnostics = diagnostic();
    status.ledger.consecutive_failures = 0; status.ledger.last_error_code = null;
    mountOnboarding({ stage: 4, path: "/system", status: () => status });
    expect(await screen.findByText("采集持续失败")).toBeVisible();
    expect(screen.getByText(/账户级连续失败 3 次/)).toBeVisible();
  });
  it("retains runtime storage errors even when no provider failure was persisted", async () => {
    const status = systemStatus();
    status.ledger.diagnostics = { ...diagnostic(), consecutive_failures: 0, latest_failure: null };
    status.ledger.last_error_code = "ledger_schedule_storage_error";
    status.ledger.consecutive_failures = 1;
    mountOnboarding({ stage: 4, path: "/system", status: () => status });
    expect(await screen.findByText(/最近错误：ledger_schedule_storage_error/)).toBeVisible();
    expect(screen.queryByText("采集持续失败")).not.toBeInTheDocument();
  });

});
