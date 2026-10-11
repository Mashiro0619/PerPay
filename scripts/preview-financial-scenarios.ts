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
import { previewLedgerNumber, previewOrderNumber, previewPayer, previewTradeNumber } from "./preview-identities.ts";

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
  let orderSequence = 0;
  let ledgerSequence = 0;
  const ledgerIdentities = new Map<string, { accountLogId: string; alipayOrderNo: string; payer: string }>();
  const advance = (milliseconds = 1_000) => { setNow(getNow() + milliseconds); return getNow(); };
  const beforeScenario = (key: string) => context.beforeScenario?.(key);

  function create(key: string, productName: string, amountCents: number, note: string): OrderProjection {
    advance();
    const order = orders.create(createOrderRequestSchema.parse({
      idempotency_key: "preview-financial-" + key,
      merchant_order_no: previewOrderNumber(getNow(), ++orderSequence, 20),
      product_name: productName,
      amount_cents: amountCents,
      note,
      ...(site.configuration.notification_origin ? {
        notify_url: site.configuration.notification_origin + "/api/payments/perpay",
      } : {}),
    })).order;
    manifest.orders[key] = order.orderId;
    return order;
  }

  function detail(key: string, amountCents: number, memo: string, overrides: Partial<AccountLogDetail> = {}): AccountLogDetail {
    let identity = ledgerIdentities.get(key);
    if (!identity) {
      const sequence = ++ledgerSequence;
      identity = {
        accountLogId: previewLedgerNumber(getNow(), sequence, 20),
        alipayOrderNo: previewTradeNumber(getNow(), sequence, 20),
        payer: previewPayer(sequence),
      };
      ledgerIdentities.set(key, identity);
    }
    const fields = {
      accountLogId: identity.accountLogId,
      occurredAt: new Date(getNow()).toISOString(),
      amount: (amountCents / 100).toFixed(2),
      direction: "CREDIT",
      alipayOrderNo: identity.alipayOrderNo,
      merchantOrderNo: null,
      transMemo: memo,
      otherAccount: identity.payer,
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
      evidence: { httpStatus: 200, headers: { "x-perpay-synthetic": "true" }, body, traceId: previewTradeNumber(getNow(), sequence, 20), signatureVerified: true },
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
  for (const [key, label, amount, difference, note] of [
    ["underpaid", "帆布托特包", 3_400, -100, "客户实付少于应付金额 1 元，已联系补差额。"],
    ["overpaid", "桌面收纳套装", 6_400, 500, "客户多付 5 元，待确认退款或抵扣后续订单。"],
  ] as const) {
    beforeScenario(key);
    const order = create(key, label, amount, note);
    const credit = entry(key, order.payableAmountCents + difference, label);
    exception(key, credit, "AMOUNT_MISMATCH");
    close(order);
  }

  for (const [key, label, amount, difference, reason] of [
    ["manualExact", "便携咖啡手冲套装", 8_800, 0, "已核对付款凭证、金额及付款人，人工关联到本订单。"],
    ["manualOverpaid", "纯棉短袖 T 恤", 7_600, 75, "付款人多付 0.75 元，已确认将差额计入本次实收。"],
    ["manualUnderpaid", "不锈钢随行杯", 5_400, -125, "客服同意优惠 1.25 元，按实际到账金额确认。"],
    ["manualWithoutNote", "方格笔记本双本装", 2_400, 0, null],
  ] as const) {
    beforeScenario(key);
    const order = create(key, label, amount, reason ?? "顾客到店自提，核对收款后交付商品。");
    const credit = entry(key, order.payableAmountCents + difference, label);
    if (difference !== 0) exception(key, credit, "AMOUNT_MISMATCH");
    manual(order, credit, reason);
  }

  beforeScenario("disputedInferred");
  const inferredDispute = create("disputedInferred", "折叠桌面灯", 12_400, "付款人提供的订单信息与收款关联结果不一致，待核对凭证。");
  const inferred = automatic(inferredDispute, "disputedInferred");
  reconciliation.reverseSettlement({
    financialOperationId: randomUUID(), expectedClientId: site.clientId,
    paymentMatchId: inferred.result.paymentMatchId, actorId: audit.actorId,
    reason: "付款人表示该笔款项用于另一订单，撤销原关联，等待补充付款凭证。", now: advance(),
  });
  manifest.exceptions.disputedInferred = reconciliation.financialExceptionsForOrder(inferredDispute.orderId)
    .find(item => item.exceptionType === "RECONCILIATION_CONFLICT")!.exceptionId;

  beforeScenario("disputedManual");
  const manualDispute = create("disputedManual", "无线键鼠套装", 16_400, "两笔同价订单发生关联混淆，已核对原始收款凭证。");
  const disputedCredit = entry("disputedManual", manualDispute.payableAmountCents, manualDispute.productName);
  const wrongClaim = manual(manualDispute, disputedCredit, "已核对付款截图及到账金额，人工确认收款。");
  reconciliation.reverseSettlement({
    financialOperationId: randomUUID(), expectedClientId: site.clientId,
    paymentMatchId: wrongClaim.paymentMatch.paymentMatchId, actorId: audit.actorId,
    reason: "客户补充的付款凭证对应另一订单，撤销本次关联。", now: advance(),
  });
  manifest.exceptions.disputedManual = reconciliation.financialExceptionsForOrder(manualDispute.orderId)
    .find(item => item.exceptionType === "RECONCILIATION_CONFLICT")!.exceptionId;
  const corrected = create("correctedClaim", "无线键鼠套装", 16_400, "付款凭证中的商品与收货信息已核实，收款归入本订单。");
  manual(corrected, disputedCredit, "已确认原流水属于本订单，保留前次撤销记录。以原始实收金额为准。");

  beforeScenario("duplicatePayment");
  const duplicate = create("duplicatePayment", "家庭工具箱 32 件套", 21_800, "客户重复付款，首笔已确认，第二笔待售后处理。");
  automatic(duplicate, "duplicatePaymentOriginal");
  const duplicateCredit = entry("duplicatePaymentExtra", duplicate.payableAmountCents, duplicate.productName, {
    otherAccount: ledgerIdentities.get("duplicatePaymentOriginal")!.payer,
  });
  exception("duplicatePayment", duplicateCredit, "DUPLICATE_PAYMENT");

  beforeScenario("lateClosed");
  const lateClosed = create("lateClosed", "人体工学鼠标", 13_800, "客户申请取消后仍完成了转账，待核实是否恢复订单。");
  close(lateClosed);
  advance(5_000);
  exception("lateClosed", entry("lateClosed", lateClosed.payableAmountCents, lateClosed.productName), "CHECKOUT_ENDED_PAYMENT");

  beforeScenario("timelyClosed");
  const timelyClosed = create("timelyClosed", "机械键盘", 14_800, "客户付款后申请取消，到账记录已核对，售后处理中。");
  const paidBeforeClose = advance(5_000);
  advance(5_000);
  close(timelyClosed);
  const beforeClose = entry("timelyClosed", timelyClosed.payableAmountCents, timelyClosed.productName, { occurredAt: new Date(paidBeforeClose).toISOString() });
  assert.equal(reconciliation.reconcileEntry(beforeClose.ledgerEntryId, advance()).kind, "auto_settled");

  // A current product refund mark is an administrator annotation. It does not
  // manufacture retired legacy refund records, outgoing transfers or refunds.
  for (const [key, label, amount, clear] of [
    ["refundMarked", "空气循环扇", 24_800, false],
    ["refundMarkCleared", "桌面净水壶套装", 32_800, true],
  ] as const) {
    beforeScenario(key);
    const order = create(key, label, amount, clear ? "售后记录已复核，退款标记需要更正。" : "退货已验收，售后退款通过线下转账完成。");
    automatic(order, key);
    const marked = setAdminRefundMark(database, order.orderId, {
      operation_id: randomUUID(), version: 0, marked: true,
      note: clear ? "售后记录显示退款已处理，登记退款标记，等待凭证复核。" : "已核对退货签收及线下退款凭证，登记退款完成。",
    }, { ...audit, expectedClientId: site.clientId, now: advance() });
    if (clear) setAdminRefundMark(database, order.orderId, {
      operation_id: randomUUID(), version: marked.refund_mark.version, marked: false,
      note: "复核发现退款凭证属于另一张订单，撤销本订单的退款标记。",
    }, { ...audit, expectedClientId: site.clientId, now: advance() });
  }

  beforeScenario("amountReuse");
  const reuseOriginal = create("amountReuseOriginal", "便携蓝牙音箱", 18_800, "客户更改收货地址，取消后重新下单。");
  close(reuseOriginal);
  const releasedAt = getNow();
  const offset = create("amountOffset", "便携蓝牙音箱", 18_800, "重新下单购买同款商品，请以新订单付款金额为准。");
  assert.notEqual(offset.payableAmountCents, reuseOriginal.payableAmountCents);
  close(offset);
  setNow(Math.max(getNow(), releasedAt + site.configuration.policy.orders.amount_reuse_cooldown_seconds * 1_000 + 1_000));
  const reused = create("amountReused", "便携蓝牙音箱", 18_800, "同款补货订单，客户确认收货信息后付款。");
  assert.equal(reused.payableAmountCents, reuseOriginal.payableAmountCents);
  automatic(reused, "amountReused");

  beforeScenario("expiryPayments");
  const lateExpired = create("lateExpired", "无线降噪耳机", 27_800, "支付页面已过期，客户随后完成转账，待客服核实。");
  const timelyExpired = create("timelyExpired", "便携照片打印机", 28_800, "客户已在有效期内付款，补回支付凭证后确认到账。");
  const paidBeforeExpiry = advance(5_000);
  setNow(Math.max(getNow(), timelyExpired.checkout.expiresAt + 5_000));
  orders.get(lateExpired.orderId);
  orders.get(timelyExpired.orderId);
  exception("lateExpired", entry("lateExpired", lateExpired.payableAmountCents, lateExpired.productName), "CHECKOUT_ENDED_PAYMENT");
  const beforeExpiry = entry("timelyExpired", timelyExpired.payableAmountCents, timelyExpired.productName, { occurredAt: new Date(paidBeforeExpiry).toISOString() });
  assert.equal(reconciliation.reconcileEntry(beforeExpiry.ledgerEntryId, advance()).kind, "auto_settled");

  beforeScenario("ledgerDiagnostics");
  const unmatched = entry("unmatched", 73_129, "办公用品采购尾款");
  exception("unmatched", unmatched, "UNMATCHED_CREDIT");
  for (const [key, amount, memo, recipient] of [
    ["expense", 8_900, "云主机月度服务费", "青屿云服务"],
    ["partialRefundDebit", 3_200, "商品售后退差价", "周*然"],
    ["fullRefundDebit", 24_801, "空气循环扇退货退款", ledgerIdentities.get("refundMarked")!.payer],
    ["providerReversalDebit", 1_780, "支付平台交易冲正", "支付平台结算账户"],
  ] as const) {
    const debit = entry(key, amount, memo, { direction: "DEBIT", otherAccount: recipient });
    assert.equal(reconciliation.reconcileEntry(debit.ledgerEntryId, advance()).kind, "ignored");
  }

  for (const [key, amount, resolved] of [["duplicateOpen", 43_200, false], ["duplicateResolved", 44_200, true]] as const) {
    const original = detail(key, amount, "便携咖啡机");
    const first = record(original).normalized[0];
    assert.ok(first?.kind === "created");
    manifest.entries[key] = first.entry.ledgerEntryId;
    const changed = detail(key, amount + 100, "便携咖啡机", {
      occurredAt: original.occurredAt, alipayOrderNo: original.alipayOrderNo,
    });
    const conflict = record(changed).normalized[0];
    assert.ok(conflict?.kind === "conflict");
    manifest.conflicts[key] = conflict.conflict.conflictId;
    if (resolved) ledger.resolveConflict({
      conflictOperationId: randomUUID(), conflictId: conflict.conflict.conflictId,
      action: "KEEP_EXISTING", ...audit,
      reason: "已与支付平台核对交易凭证，实收金额以首次返回的原始流水为准，后续金额变更不入账。", now: advance(),
    });
  }

  for (const [key, overrides] of [
    ["missingExternalId", { accountLogId: null }],
    ["invalidAmount", { amount: "12.345" }],
    ["invalidTimestamp", { occurredAt: "2026-02-30 12:00:00" }],
    ["invalidDirection", { direction: "UNKNOWN" }],
    ["invalidShape", { transMemo: "采购清单：竹木桌面收纳盒、抽屉分隔板、文件托盘；".repeat(150) }],
    ["isolatedAcknowledged", { amount: "not-a-number" }],
  ] as const) {
    const result = record(detail(key, 1_234, "办公用品采购款", overrides)).normalized[0];
    assert.ok(result?.kind === "isolated");
    manifest.conflicts[key] = result.conflict.conflictId;
    if (key === "isolatedAcknowledged") ledger.resolveConflict({
      conflictOperationId: randomUUID(), conflictId: result.conflict.conflictId,
      action: "ACKNOWLEDGE_ISOLATED", ...audit,
      reason: "支付平台确认该笔流水的金额格式有误，暂不入账，原始记录留存待复核。", now: advance(),
    });
  }

  ignoreReminder("ignoredFinancial", "FINANCIAL_EXCEPTION", manifest.exceptions.underpaid!);
  ignoreReminder("restoredFinancial", "FINANCIAL_EXCEPTION", manifest.exceptions.overpaid!, true);
  ignoreReminder("ignoredConflict", "LEDGER_CONFLICT", manifest.conflicts.invalidAmount!);
  ignoreReminder("restoredConflict", "LEDGER_CONFLICT", manifest.conflicts.invalidDirection!, true);

  const reminderOrder = create("reminderHandled", "智能显示器支架", 47_800, "客户补充付款凭证后已核实到账，多付差额按实收入账。");
  const reminderCredit = entry("reminderHandled", reminderOrder.payableAmountCents + 50, reminderOrder.productName);
  const reminderException = exception("reminderHandled", reminderCredit, "AMOUNT_MISMATCH");
  ignoreReminder("endedFinancial", "FINANCIAL_EXCEPTION", reminderException);
  manual(reminderOrder, reminderCredit, "已核实付款人和订单信息，多付 0.50 元按实收入账。");

  const endedConflict = record(detail("reminderHandled", 5_678, "智能显示器支架", { amount: "56.789" })).normalized[0];
  assert.ok(endedConflict?.kind === "isolated");
  manifest.conflicts.reminderHandled = endedConflict.conflict.conflictId;
  ignoreReminder("endedConflict", "LEDGER_CONFLICT", endedConflict.conflict.conflictId);
  ledger.resolveConflict({
    conflictOperationId: randomUUID(), conflictId: endedConflict.conflict.conflictId,
    action: "ACKNOWLEDGE_ISOLATED", ...audit,
    reason: "支付平台返回的金额精度有误，该条原始流水继续隔离，已完成复核记录。", now: advance(),
  });

  // Repeated observation of the same request with a different response is a
  // distinct diagnostic from a repeated external ID across independent pages.
  const variantWindow = { start: providerTime(getNow() - 2 * MINUTE), end: providerTime(getNow() + MINUTE) };
  const baseline = detail("rawPageBaseline", 4_900, "相片整理服务");
  assert.equal(record(baseline, variantWindow).kind, "inserted");
  const changedPage = detail("rawPageChanged", 5_900, "家庭云盘扩容包");
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
