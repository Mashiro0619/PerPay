// SPDX-License-Identifier: MIT
// Synthetic local-preview evidence, written only through production services/stores.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import type { AppDatabase } from "../src/database/database.ts";
import { setAdminRefundMark } from "../src/database/admin-refund-mark-store.ts";
import { adminWorkItemPage, ignoreAllAdminWorkItems, restoreAdminWorkItem, type AdminWorkItemKind } from "../src/http/admin-work-items.ts";
import type { AccountLogDetail } from "../src/infrastructure/alipay/types.ts";
import type { LedgerEntry, LedgerWindow } from "../src/ledger/model.ts";
import type { LedgerStore } from "../src/ledger/store.ts";
import { createOrderRequestSchema, type OrderProjection } from "../src/orders/model.ts";
import type { OrderService } from "../src/orders/service.ts";
import type { FinancialExceptionType } from "../src/reconciliation/model.ts";
import type { ReconciliationStore } from "../src/reconciliation/store.ts";
import type { SettingsAuditContext } from "../src/settings/store.ts";
import type { SiteSnapshot } from "../src/sites/model.ts";

const MINUTE = 60_000;
const providerTime = (time: number) => new Date(time + 8 * 3_600_000).toISOString().slice(0, 19).replace("T", " ");

export interface FinancialScenarioContext {
  readonly database: AppDatabase;
  readonly orders: OrderService;
  readonly ledger: LedgerStore;
  readonly reconciliation: ReconciliationStore;
  readonly site: SiteSnapshot;
  readonly audit: SettingsAuditContext;
  readonly providerAccountKey: string;
  readonly getNow: () => number;
  readonly setNow: (time: number) => void;
  readonly beforeScenario?: (key: string) => void;
}

export interface FinancialScenarioManifest {
  readonly orders: Record<string, string>;
  readonly entries: Record<string, string>;
  readonly conflicts: Record<string, string>;
  readonly exceptions: Record<string, string>;
  readonly reminders: Record<string, string>;
}

/** Schedule complete groups with beforeScenario, or reserve TTL + cooldown + 15 minutes. */
export function seedFinancialScenarios(context: FinancialScenarioContext): FinancialScenarioManifest {
  const { database, ledger, reconciliation, site, audit, providerAccountKey, getNow, setNow } = context;
  const orders = context.orders.forSite(site.clientId);
  const manifest: FinancialScenarioManifest = { orders: {}, entries: {}, conflicts: {}, exceptions: {}, reminders: {} };
  let pageSequence = 0;
  const advance = (milliseconds = 1_000) => { setNow(getNow() + milliseconds); return getNow(); };
  const beforeScenario = (key: string) => context.beforeScenario?.(key);

  function create(key: string, label: string, amountCents: number, note: string): OrderProjection {
    advance();
    const order = orders.create(createOrderRequestSchema.parse({
      idempotency_key: "preview-financial-" + key,
      merchant_order_no: "DEMO-FIN-" + key.replace(/[A-Z]/g, letter => "-" + letter).toUpperCase(),
      product_name: "场景演示 · " + label,
      amount_cents: amountCents,
      note: "合成数据（非真实交易）· " + note,
      ...(site.configuration.notification_origin ? {
        notify_url: site.configuration.notification_origin + "/api/payments/perpay",
      } : {}),
    })).order;
    manifest.orders[key] = order.orderId;
    return order;
  }

  function detail(key: string, amountCents: number, memo: string, overrides: Partial<AccountLogDetail> = {}): AccountLogDetail {
    const fields = {
      accountLogId: "DEMO-FIN-LEDGER-" + key.toUpperCase(),
      occurredAt: new Date(getNow()).toISOString(),
      amount: (amountCents / 100).toFixed(2),
      direction: "CREDIT",
      alipayOrderNo: "DEMO-FIN-TRADE-" + key.toUpperCase(),
      merchantOrderNo: null,
      transMemo: "合成流水 · " + memo,
      otherAccount: "演示付款人 · 财务场景",
      ...overrides,
    };
    return { ...fields, raw: {
      synthetic: true, account_log_id: fields.accountLogId, occurred_at: fields.occurredAt,
      amount: fields.amount, direction: fields.direction, trans_memo: fields.transMemo,
      other_account: fields.otherAccount, alipay_order_no: fields.alipayOrderNo,
    } };
  }

  function record(row: AccountLogDetail, fixedWindow?: LedgerWindow) {
    advance();
    const sequence = ++pageSequence;
    // Different regular windows keep independent synthetic pages independent.
    const window = fixedWindow ?? {
      start: providerTime(getNow() - (site.configuration.policy.orders.order_ttl_seconds * 1_000) - 2 * MINUTE - sequence * 1_000),
      end: providerTime(getNow() + sequence * 1_000),
    };
    const run = ledger.startIngestRun({ providerAccountKey, ...window, pageSize: 1, now: getNow() });
    const body = JSON.stringify({ synthetic: true, details: [row.raw] });
    const observation = ledger.recordPage({
      ingestRunId: run.ingestRunId,
      page: { pageNo: 1, pageSize: 1, totalSize: 1, hasMore: false, details: [row] },
      // Fixture evidence only: no provider request or real signature check takes place.
      evidence: { httpStatus: 200, headers: { "x-perpay-synthetic": "true" }, body, traceId: "DEMO-FIN-PAGE-" + sequence, signatureVerified: true },
      now: advance(),
    });
    return { ...observation, ingestRunId: run.ingestRunId };
  }

  function entry(key: string, amountCents: number, memo: string, overrides: Partial<AccountLogDetail> = {}): LedgerEntry {
    const result = record(detail(key, amountCents, memo, overrides)).normalized[0];
    assert.ok(result?.kind === "created", "财务演示应生成独立流水：" + key);
    manifest.entries[key] = result.entry.ledgerEntryId;
    return result.entry;
  }

  function exception(key: string, credit: LedgerEntry, expected: FinancialExceptionType) {
    const result = reconciliation.reconcileEntry(credit.ledgerEntryId, advance());
    assert.equal(result.kind, "unmatched", "财务演示应保留待核对收款：" + key);
    assert.ok(result.kind === "unmatched");
    assert.equal(reconciliation.exception(result.exceptionId)?.exceptionType, expected);
    manifest.exceptions[key] = result.exceptionId;
    return result.exceptionId;
  }

  function manual(order: OrderProjection, credit: LedgerEntry, reason: string | null) {
    return reconciliation.settleManually({
      financialOperationId: randomUUID(), expectedClientId: site.clientId,
      orderId: order.orderId, ledgerEntryId: credit.ledgerEntryId,
      actorId: audit.actorId, reason, now: advance(),
    });
  }

  function automatic(order: OrderProjection, key: string) {
    advance(5_000);
    const credit = entry(key, order.payableAmountCents, order.productName);
    const result = reconciliation.reconcileEntry(credit.ledgerEntryId, advance());
    assert.equal(result.kind, "auto_settled", "财务演示应自动确认收款：" + key);
    assert.ok(result.kind === "auto_settled");
    return { credit, result };
  }

  function close(order: OrderProjection) { advance(); orders.close(order.orderId); }

  function ignoreReminder(key: string, type: AdminWorkItemKind, itemId: string, restore = false) {
    const active = adminWorkItemPage(database, { type, cursor: null, limit: 200 });
    assert.equal(active.nextCursor, null, "演示提醒应落在单个已知批次内");
    assert.ok(active.items.some(item => item.itemId === itemId));
    // Unfiltered bulk operations have the canonical audit form understood by
    // the current offline integrity verifier. Restore every other active item
    // afterward, preserving earlier ignored items and the requested final state.
    const result = ignoreAllAdminWorkItems(database, {
      operation_id: randomUUID(), type,
    }, { ...audit, now: advance() });
    assert.equal(result.ignored_count, active.items.length);
    for (const item of active.items) {
      if (!restore && item.itemId === itemId) continue;
      restoreAdminWorkItem(database, {
        operation_id: randomUUID(), type, resource_id: item.itemId,
      }, { ...audit, now: advance() });
    }
    manifest.reminders[key] = itemId;
  }

  // Keep these isolated from other unpaid slots so the current classifier can
  // attach an amount discrepancy to one specific order without inventing evidence.
  for (const [key, label, amount, difference] of [
    ["underpaid", "少付金额待核对", 3_400, -100],
    ["overpaid", "多付金额待核对", 6_400, 500],
  ] as const) {
    beforeScenario(key);
    const order = create(key, label, amount, "实付与应付不一致，保留提醒；收银台已关闭。");
    const credit = entry(key, order.payableAmountCents + difference, label);
    exception(key, credit, "AMOUNT_MISMATCH");
    close(order);
  }

  for (const [key, label, amount, difference, reason] of [
    ["manualExact", "人工关联收款", 8_800, 0, "已核对演示付款凭证、金额及付款人，人工关联到本订单。"],
    ["manualOverpaid", "多付后人工确认", 7_600, 75, "付款人多付 0.75 元，演示商户确认按实收金额入账。"],
    ["manualUnderpaid", "少付后人工确认", 5_400, -125, "演示商户同意优惠 1.25 元，按实际到账金额确认。"],
    ["manualWithoutNote", "人工关联未填备注", 2_400, 0, null],
  ] as const) {
    beforeScenario(key);
    const order = create(key, label, amount, reason ?? "展示未填写人工关联备注的情况。");
    const credit = entry(key, order.payableAmountCents + difference, label);
    if (difference !== 0) exception(key, credit, "AMOUNT_MISMATCH");
    manual(order, credit, reason);
  }

  beforeScenario("disputedInferred");
  const inferredDispute = create("disputedInferred", "撤销自动关联 · 待核对", 12_400, "原自动关联被管理员撤销，保留争议及原收款依据。");
  const inferred = automatic(inferredDispute, "disputedInferred");
  reconciliation.reverseSettlement({
    financialOperationId: randomUUID(), expectedClientId: site.clientId,
    paymentMatchId: inferred.result.paymentMatchId, actorId: audit.actorId,
    reason: "演示复核发现付款归属有争议，撤销原自动关联，等待进一步核对。", now: advance(),
  });
  manifest.exceptions.disputedInferred = reconciliation.financialExceptionsForOrder(inferredDispute.orderId)
    .find(item => item.exceptionType === "RECONCILIATION_CONFLICT")!.exceptionId;

  beforeScenario("disputedManual");
  const manualDispute = create("disputedManual", "撤销人工关联 · 已纠正归属", 16_400, "人工关联曾选错订单，保留撤销历史，收款已归入正确订单。");
  const disputedCredit = entry("disputedManual", manualDispute.payableAmountCents, "人工关联选错订单的演示收款");
  const wrongClaim = manual(manualDispute, disputedCredit, "演示首次人工核对并关联。");
  reconciliation.reverseSettlement({
    financialOperationId: randomUUID(), expectedClientId: site.clientId,
    paymentMatchId: wrongClaim.paymentMatch.paymentMatchId, actorId: audit.actorId,
    reason: "商户补充的演示凭证对应另一订单，撤销本次关联。", now: advance(),
  });
  manifest.exceptions.disputedManual = reconciliation.financialExceptionsForOrder(manualDispute.orderId)
    .find(item => item.exceptionType === "RECONCILIATION_CONFLICT")!.exceptionId;
  const corrected = create("correctedClaim", "核对后重新关联正确订单", 16_400, "通过同一条原始流水重新确认；原订单保留争议历史。");
  manual(corrected, disputedCredit, "已确认原流水属于本订单，保留前次撤销记录。以原始实收金额为准。");

  beforeScenario("duplicatePayment");
  const duplicate = create("duplicatePayment", "重复付款 · 首笔已确认", 21_800, "第一笔收款已确认，第二笔相同金额收入保留为重复付款提醒。");
  automatic(duplicate, "duplicatePaymentOriginal");
  const duplicateCredit = entry("duplicatePaymentExtra", duplicate.payableAmountCents, "同一订单第二次付款，等待人工核对");
  exception("duplicatePayment", duplicateCredit, "DUPLICATE_PAYMENT");

  beforeScenario("lateClosed");
  const lateClosed = create("lateClosed", "关闭后才付款", 13_800, "到账时间晚于收银台关闭时间，未自动确认。");
  close(lateClosed);
  advance(5_000);
  exception("lateClosed", entry("lateClosed", lateClosed.payableAmountCents, "关闭后到账"), "CHECKOUT_ENDED_PAYMENT");

  beforeScenario("timelyClosed");
  const timelyClosed = create("timelyClosed", "关闭后补拉 · 关闭前已付", 14_800, "付款发生在关闭前，平台流水稍后才发现，保留有效的自动确认依据。");
  const paidBeforeClose = advance(5_000);
  advance(5_000);
  close(timelyClosed);
  const beforeClose = entry("timelyClosed", timelyClosed.payableAmountCents, "关闭前付款、关闭后发现", { occurredAt: new Date(paidBeforeClose).toISOString() });
  assert.equal(reconciliation.reconcileEntry(beforeClose.ledgerEntryId, advance()).kind, "auto_settled");

  // A current product refund mark is an administrator annotation. It does not
  // manufacture retired legacy refund records, outgoing transfers or refunds.
  for (const [key, label, amount, clear] of [
    ["refundMarked", "已标记线下退款", 24_800, false],
    ["refundMarkCleared", "退款标记撤销历史", 32_800, true],
  ] as const) {
    beforeScenario(key);
    const order = create(key, label, amount, "退款标记为演示管理备注，保留独立操作历史。");
    automatic(order, key);
    const marked = setAdminRefundMark(database, order.orderId, {
      operation_id: randomUUID(), version: 0, marked: true,
      note: "演示商户已在线下处理退款，此处仅记录管理标记。",
    }, { ...audit, expectedClientId: site.clientId, now: advance() });
    if (clear) setAdminRefundMark(database, order.orderId, {
      operation_id: randomUUID(), version: marked.refund_mark.version, marked: false,
      note: "演示复核确认先前标记有误，撤销标记并保留历史。",
    }, { ...audit, expectedClientId: site.clientId, now: advance() });
  }

  beforeScenario("amountReuse");
  const reuseOriginal = create("amountReuseOriginal", "同价订单 · 原金额槽位", 18_800, "关闭订单后，应付金额仍在冷却期内，后续订单使用不同尾数。");
  close(reuseOriginal);
  const releasedAt = getNow();
  const offset = create("amountOffset", "同价订单 · 冷却期内错开尾数", 18_800, "与前一订单价格相同，实际应付金额不同，避免收款归属混淆。");
  assert.notEqual(offset.payableAmountCents, reuseOriginal.payableAmountCents);
  close(offset);
  setNow(Math.max(getNow(), releasedAt + site.configuration.policy.orders.amount_reuse_cooldown_seconds * 1_000 + 1_000));
  const reused = create("amountReused", "同价订单 · 冷却完成后复用", 18_800, "原金额冷却完成后重新分配，使用当前支付时间窗安全确认。");
  assert.equal(reused.payableAmountCents, reuseOriginal.payableAmountCents);
  automatic(reused, "amountReused");

  beforeScenario("expiryPayments");
  const lateExpired = create("lateExpired", "过期后才付款", 27_800, "收银台已过期，到账时间确实晚于有效期，因此进入待核对列表。");
  const timelyExpired = create("timelyExpired", "过期后补拉 · 有效期内已付", 28_800, "实际付款发生在有效期内，过期后才取得流水，仍按有效凭证确认。");
  const paidBeforeExpiry = advance(5_000);
  setNow(Math.max(getNow(), timelyExpired.checkout.expiresAt + 5_000));
  orders.get(lateExpired.orderId);
  orders.get(timelyExpired.orderId);
  exception("lateExpired", entry("lateExpired", lateExpired.payableAmountCents, "有效期结束后付款"), "CHECKOUT_ENDED_PAYMENT");
  const beforeExpiry = entry("timelyExpired", timelyExpired.payableAmountCents, "有效期内付款、过期后发现", { occurredAt: new Date(paidBeforeExpiry).toISOString() });
  assert.equal(reconciliation.reconcileEntry(beforeExpiry.ledgerEntryId, advance()).kind, "auto_settled");

  beforeScenario("ledgerDiagnostics");
  const unmatched = entry("unmatched", 73_129, "无对应订单的转入，等待核实付款来源");
  exception("unmatched", unmatched, "UNMATCHED_CREDIT");
  for (const [key, amount, memo] of [
    ["expense", 8_900, "演示服务采购支出"],
    ["partialRefundDebit", 3_200, "演示线下部分退款支出，仅保留账户流水"],
    ["fullRefundDebit", 24_801, "演示线下全额退款支出，仅保留账户流水"],
    ["providerReversalDebit", 1_780, "演示平台冲正扣款，仅保留账户流水"],
  ] as const) {
    const debit = entry(key, amount, memo, { direction: "DEBIT", otherAccount: "演示收款方 · 支出记录" });
    assert.equal(reconciliation.reconcileEntry(debit.ledgerEntryId, advance()).kind, "ignored");
  }

  for (const [key, amount, resolved] of [["duplicateOpen", 43_200, false], ["duplicateResolved", 44_200, true]] as const) {
    const original = detail(key, amount, "同一平台流水号的原始金额");
    const first = record(original).normalized[0];
    assert.ok(first?.kind === "created");
    manifest.entries[key] = first.entry.ledgerEntryId;
    const changed = detail(key, amount + 100, "同一平台流水号返回不同金额", {
      occurredAt: original.occurredAt, alipayOrderNo: original.alipayOrderNo,
    });
    const conflict = record(changed).normalized[0];
    assert.ok(conflict?.kind === "conflict");
    manifest.conflicts[key] = conflict.conflict.conflictId;
    if (resolved) ledger.resolveConflict({
      conflictOperationId: randomUUID(), conflictId: conflict.conflict.conflictId,
      action: "KEEP_EXISTING", ...audit,
      reason: "演示复核确认原始证据正确，保留原流水，拒绝重复编号下的变化金额。", now: advance(),
    });
  }

  for (const [key, overrides] of [
    ["missingExternalId", { accountLogId: null }],
    ["invalidAmount", { amount: "12.345" }],
    ["invalidTimestamp", { occurredAt: "2026-02-30 12:00:00" }],
    ["invalidDirection", { direction: "UNKNOWN" }],
    ["invalidShape", { transMemo: "演示超长平台备注".repeat(150) }],
    ["isolatedAcknowledged", { amount: "not-a-number" }],
  ] as const) {
    const result = record(detail(key, 1_234, "平台异常字段 · " + key, overrides)).normalized[0];
    assert.ok(result?.kind === "isolated");
    manifest.conflicts[key] = result.conflict.conflictId;
    if (key === "isolatedAcknowledged") ledger.resolveConflict({
      conflictOperationId: randomUUID(), conflictId: result.conflict.conflictId,
      action: "ACKNOWLEDGE_ISOLATED", ...audit,
      reason: "演示异常字段已核实为不可用数据，确认隔离并保留原始证据。", now: advance(),
    });
  }

  ignoreReminder("ignoredFinancial", "FINANCIAL_EXCEPTION", manifest.exceptions.underpaid!);
  ignoreReminder("restoredFinancial", "FINANCIAL_EXCEPTION", manifest.exceptions.overpaid!, true);
  ignoreReminder("ignoredConflict", "LEDGER_CONFLICT", manifest.conflicts.invalidAmount!);
  ignoreReminder("restoredConflict", "LEDGER_CONFLICT", manifest.conflicts.invalidDirection!, true);

  const reminderOrder = create("reminderHandled", "忽略提醒后完成人工核对", 47_800, "先忽略提醒，再人工关联；已忽略列表保留事项结束的历史。");
  const reminderCredit = entry("reminderHandled", reminderOrder.payableAmountCents + 50, "忽略提醒后核实为本订单的收款");
  const reminderException = exception("reminderHandled", reminderCredit, "AMOUNT_MISMATCH");
  ignoreReminder("endedFinancial", "FINANCIAL_EXCEPTION", reminderException);
  manual(reminderOrder, reminderCredit, "演示复核完成，多付 0.50 元按实收入账；此前忽略的提醒已结束。");

  const endedConflict = record(detail("reminderHandled", 5_678, "忽略提醒后确认隔离", { amount: "56.789" })).normalized[0];
  assert.ok(endedConflict?.kind === "isolated");
  manifest.conflicts.reminderHandled = endedConflict.conflict.conflictId;
  ignoreReminder("endedConflict", "LEDGER_CONFLICT", endedConflict.conflict.conflictId);
  ledger.resolveConflict({
    conflictOperationId: randomUUID(), conflictId: endedConflict.conflict.conflictId,
    action: "ACKNOWLEDGE_ISOLATED", ...audit,
    reason: "演示复核完成，字段不合法的原始流水继续隔离，此前忽略的提醒已结束。", now: advance(),
  });

  // Repeated observation of the same request with a different response is a
  // distinct diagnostic from a repeated external ID across independent pages.
  const variantWindow = { start: providerTime(getNow() - 2 * MINUTE), end: providerTime(getNow() + MINUTE) };
  const baseline = detail("rawPageBaseline", 4_900, "平台分页第一次观察");
  assert.equal(record(baseline, variantWindow).kind, "inserted");
  const changedPage = detail("rawPageChanged", 5_900, "同一分页请求返回不同证据");
  const changedObservation = record(changedPage, variantWindow);
  assert.equal(changedObservation.kind, "variant");
  const pageConflict = ledger.listOpenConflicts(providerAccountKey).find(item => item.conflictType === "RAW_PAGE_VARIANT");
  assert.ok(pageConflict);
  manifest.conflicts.rawPageVariant = pageConflict.conflictId;
  // A -> B -> A -> A simulates a transient provider response. Returning to A
  // still needs two consecutive observations. Production code confirms that
  // recovery and completes the cursor, while B's unconfirmed evidence remains
  // open for inspection. Later scenarios can then start independent windows.
  const returnedBaseline = record(baseline, variantWindow);
  assert.equal(returnedBaseline.kind, "variant");
  const recoveryConflict = ledger.listOpenConflicts(providerAccountKey).find(item =>
    item.conflictType === "RAW_PAGE_VARIANT" && item.rawPageId === returnedBaseline.page.rawPageId);
  assert.ok(recoveryConflict);
  manifest.conflicts.rawPageRecovered = recoveryConflict.conflictId;
  const recovered = record(baseline, variantWindow);
  assert.equal(recovered.kind, "confirmed_variant");
  assert.equal(recovered.cursor.complete, true);

  return manifest;
}
