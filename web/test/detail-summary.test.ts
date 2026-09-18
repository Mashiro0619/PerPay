import { describe, expect, it } from "vitest";
import {
  attemptResult,
  candidateFacts,
  detailTimestamp,
  exceptionExplanation,
  exceptionResolution,
  exceptionStateLabel,
  eventExplanation,
  isHistoricalException,
} from "../src/lib/detail-summary";
import {
  comparisonAmount,
  comparisonDirection,
  comparisonTime,
} from "../src/lib/conflict-comparison";
import {
  candidate,
  failedAttempt,
  financialException,
  paidOrder,
} from "./detail-fixtures";

describe("readable evidence without stronger financial claims", () => {
  it.each([
    "CREATED",
    "CHECKOUT_CLOSED",
    "CHECKOUT_EXPIRED",
    "PAYMENT_DISPUTED",
    "REFUND_UPDATED",
  ] as const)(
    "does not repeat the %s timeline title with generic prose",
    (event_type) => {
      expect(
        eventExplanation({ ...paidOrder.events[0]!, event_type }),
      ).toBeNull();
    },
  );
  it("keeps an actual confirmation basis but does not invent one for old events", () => {
    const event = {
      ...paidOrder.events[1]!,
      event_type: "PAYMENT_CONFIRMED" as const,
    };
    expect(
      eventExplanation({ ...event, details: { evidence_type: "MANUAL" } }),
    ).toBe("人工关联确认");
    expect(
      eventExplanation({
        ...event,
        details: { evidence_type: "AMOUNT_INFERRED" },
      }),
    ).toBe("按金额与付款时间推断");
    expect(eventExplanation({ ...event, details: {} })).toBeNull();
  });
  it("states both reminder visibility and financial status without a separate disclaimer", () => {
    expect(
      exceptionStateLabel({ ...financialException, reminder_ignored: true }),
    ).toBe("未处理 · 已忽略");
    expect(
      exceptionStateLabel({
        ...financialException,
        reminder_ignored: true,
        status: "RESOLVED",
      }),
    ).toBe("已处理");
    expect(
      exceptionResolution({
        ...financialException,
        status: "RESOLVED",
        resolution: null,
      }),
    ).toBeNull();
  });
  it("does not interpret an unknown evidence schema or invent missing facts", () => {
    expect(
      candidateFacts({
        ...candidate,
        evidence: { ...candidate.evidence, schema: "future:v9" },
      }),
    ).toEqual([]);
    expect(
      candidateFacts({
        ...candidate,
        evidence: {
          schema: "perpay:match-candidate:v3",
          amount_cents: "101",
          occurred_at: NaN,
        },
      }),
    ).toEqual([]);
    expect(candidateFacts(candidate).map(([name]) => name)).toEqual([
      "匹配金额",
      "流水发生时间",
      "金额占用窗口",
    ]);
  });
  it("does not mistake HTTP success for business acknowledgement", () => {
    expect(attemptResult(failedAttempt)).toBe("HTTP 200 · 业务确认响应无效");
    expect(
      attemptResult({
        ...failedAttempt,
        outcome: "ACKNOWLEDGED",
        error_code: null,
      }),
    ).toBe("HTTP 200 · ACK 已确认");
  });
  it("separates ignored, retired, ended and active exceptions", () => {
    expect(isHistoricalException(financialException)).toBe(false);
    expect(
      isHistoricalException({ ...financialException, reminder_ignored: true }),
    ).toBe(true);
    expect(
      isHistoricalException({ ...financialException, status: "RESOLVED" }),
    ).toBe(true);
    expect(
      isHistoricalException({
        ...financialException,
        exception_type: "UNMATCHED_DEBIT",
      }),
    ).toBe(true);
    expect(exceptionExplanation(financialException)).toContain("仅为推断");
    expect(
      exceptionResolution({
        ...financialException,
        status: "RESOLVED",
        resolution: { resolution: "manually_settled" },
      }),
    ).toContain("管理员");
  });
});

describe("display-only conflict comparison", () => {
  it.each([
    ["1.23", 123],
    ["-1.23", 123],
    [" +1.23 ", 123],
    ["0.01", 1],
    ["1.001", null],
    ["00.50", null],
    ["0", null],
    ["10000000000.00", null],
  ] as const)(
    "normalizes retained amount %s without losing ledger semantics",
    (raw, expected) => {
      expect(comparisonAmount(raw)).toBe(expected);
    },
  );
  it("normalizes direction aliases and timezone-equivalent timestamps", () => {
    expect(comparisonDirection(" 收入 ")).toBe("CREDIT");
    expect(comparisonDirection("paid")).toBe("DEBIT");
    expect(comparisonDirection("invalid")).toBe(null);
    expect(comparisonTime("2026-09-06 08:01:02")).toEqual(
      comparisonTime("2026-09-06T00:01:02Z"),
    );
    expect(comparisonTime("2026-09-06T08:01:02+08:00")).toEqual(
      comparisonTime("2026-09-06T00:01:02Z"),
    );
    expect(comparisonTime("2026-02-30 08:01:02")).toBe(null);
    expect(comparisonTime("2026-09-06T00:01:02.1234Z")).toBe(null);
  });
  it("retains seconds and distinguishes subsecond evidence precision", () => {
    expect(detailTimestamp("2026-09-06T00:01:02.125Z")).toBe(
      "2026/09/06 08:01:02.125",
    );
    expect(comparisonTime("2026-09-06 08:01:02.000")?.precision).toBe(1);
    expect(comparisonTime("2026-09-06 08:01:02")?.precision).toBe(1000);
  });
  it("uses Chinese ACK failures while preserving unknown errors", () => {
    expect(
      attemptResult({ ...failedAttempt, error_code: "ack_event_mismatch" }),
    ).toContain("确认的事件编号不匹配");
    expect(
      attemptResult({
        ...failedAttempt,
        error_code: "future_transport_failure",
      }),
    ).toContain("future_transport_failure");
  });
});
