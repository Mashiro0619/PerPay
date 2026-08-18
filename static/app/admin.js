(() => {
  "use strict";

  const API_ROOT = "/api/admin/v1";
  const CURSOR_PARENT_STORAGE_KEY = "perpay:cursor-parents:v1";
  const state = {
    session: null,
    csrfToken: readCsrfCookie(),
    stepUpPromise: null,
    dialogTriggers: new WeakMap(),
  };

  class ApiError extends Error {
    constructor(status, body, retryAfter) {
      super(body?.error?.message || `请求失败（HTTP ${status}）`);
      this.name = "ApiError";
      this.status = status;
      this.code = body?.error?.code || "request_failed";
      this.requestId = body?.error?.request_id || null;
      this.retryAfter = retryAfter;
    }
  }

  const page = document.body.dataset.perpayAdminPage;
  if (page === "setup") {
    void initializeSetup();
  } else if (page === "login") {
    void initializeLogin();
  } else if (page === "application") {
    void initializeApplication();
  }

  async function initializeSetup() {
    const form = document.querySelector("#setup-form");
    if (!(form instanceof HTMLFormElement)) return;
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      const password = valueOf("#setup-password");
      if (Array.from(password).length < 12) {
        showSetupError("管理员密码至少需要 12 个字符。");
        document.querySelector("#setup-password")?.focus();
        return;
      }
      if (password !== valueOf("#setup-password-confirmation")) {
        showSetupError("两次输入的密码不一致。");
        document.querySelector("#setup-password-confirmation")?.focus();
        return;
      }
      const submit = document.querySelector("#setup-submit");
      setBusy(submit, true, "正在设置");
      showSetupError("");
      try {
        await api("/setup", {
          method: "POST",
          body: { password },
          redirectOnUnauthorized: false,
        });
        // Initialization deliberately does not create a session.  Once the
        // password is persisted, the setup route is closed permanently and
        // the administrator must use the regular login flow.
        location.replace("/admin/login");
      } catch (error) {
        if (error instanceof ApiError && error.code === "identity_already_initialized") {
          location.replace("/admin/login");
          return;
        }
        showSetupError(errorMessage(error));
      } finally {
        setBusy(submit, false, "完成设置");
      }
    });
  }

  async function initializeLogin() {
    const form = document.querySelector("#login-form");
    if (!(form instanceof HTMLFormElement)) return;
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      const submit = document.querySelector("#login-submit");
      setBusy(submit, true, "正在登录");
      showLoginError("");
      try {
        const response = await api("/session/login", {
          method: "POST",
          body: {
            password: valueOf("#login-password"),
          },
          redirectOnUnauthorized: false,
        });
        state.csrfToken = response.data.csrf_token;
        const returnTo = new URLSearchParams(location.search).get("return_to");
        location.replace(returnTo && returnTo.startsWith("/admin") && !returnTo.startsWith("//")
          ? returnTo
          : "/admin");
      } catch (error) {
        showLoginError(errorMessage(error));
      } finally {
        setBusy(submit, false, "登录");
      }
    });
    try {
      await api("/session", { redirectOnUnauthorized: false });
      location.replace("/admin");
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) {
        showLoginError(errorMessage(error));
      }
    }
  }

  async function initializeApplication() {
    bindGlobalActions();
    markCurrentNavigation();
    try {
      const response = await api("/session");
      state.session = response.data;
      state.csrfToken = readCsrfCookie();
      renderSessionSummary(response.data);
      if (location.pathname !== "/admin" && location.pathname !== "/admin/") {
        void refreshGlobalStatus();
      }
      await renderCurrentRoute();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return;
      renderRouteError(error, () => location.reload());
    }
  }

  function bindGlobalActions() {
    document.querySelector("#logout-button")?.addEventListener("click", async () => {
      const button = document.querySelector("#logout-button");
      setBusy(button, true, "正在退出");
      try {
        await api("/session/logout", { method: "POST", redirectOnUnauthorized: false });
        location.replace("/admin/login");
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          location.replace("/admin/login");
          return;
        }
        toast(errorMessage(error), "danger");
        setBusy(button, false, "退出");
      }
    });

    const stepUpDialog = document.querySelector("#step-up-dialog");
    const stepUpOverlay = document.querySelector("#step-up-overlay");
    stepUpOverlay?.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const closeControl = target.closest("[data-uzu-dialog-close]");
      if (target === stepUpOverlay || (closeControl && stepUpDialog?.contains(closeControl))) {
        cancelStepUp();
      }
    }, { capture: true });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && isOpenDialog(stepUpDialog)) cancelStepUp();
    }, { capture: true });

    const stepUpForm = document.querySelector("#step-up-form");
    stepUpForm?.addEventListener("submit", (event) => void submitStepUp(event));
    stepUpDialog?.addEventListener("uzu-dialog-close", () => cancelStepUp());
  }

  async function renderCurrentRoute() {
    const path = location.pathname.replace(/\/+$/, "") || "/admin";
    switch (path) {
      case "/admin":
        await renderOverview();
        break;
      case "/admin/orders":
        await renderOrders();
        break;
      case "/admin/exceptions":
        await renderExceptions();
        break;
      case "/admin/settlements":
        await renderSettlements();
        break;
      case "/admin/ledger-conflicts":
        await renderLedgerConflicts();
        break;
      case "/admin/notifications":
        await renderNotifications();
        break;
      case "/admin/settings":
        await renderSettings();
        break;
      case "/admin/security":
        renderSecurity();
        break;
      default:
        renderNotFound();
    }
  }

  async function renderOverview() {
    setDocumentTitle("系统状态");
    const response = await api("/system/status");
    const data = response.data;
    updateGlobalStatus(data.status);
    updateNavigationCounts(data);
    const collection = data.ledger || {};
    const confirmation = data.reconciliation || {};
    const webhook = data.webhook || {};
    const backup = data.backup || {};

    renderMain(
      pageHeader("系统状态", "收款入口、自动确认、通知与备份的当前事实。", [
        button("刷新", () => location.reload()),
      ]),
      section("收款链路", healthStrip([
        healthCell("数据库", data.database?.ok ? "可用" : "不可用", data.database?.ok ? "success" : "danger", data.instance_id),
        healthCell("流水采集", collection.collection_ready ? "可收款" : "已暂停", collection.collection_ready ? "success" : "danger", freshnessText(collection)),
        healthCell("自动确认", confirmation.confirmation_ready ? "可确认" : "未就绪", confirmation.confirmation_ready ? "success" : "danger", freshnessText(confirmation)),
        healthCell("通知", healthLabel(webhook), webhookTone(webhook), webhook.last_error_code || `${webhook.pending_deliveries || 0} 条待投递`),
      ])),
      section("待处理", metricGrid([
        ["开放异常", data.reconciliation?.exceptions?.open ?? "-"],
        ["账务冲突", data.ledger?.conflicts?.open ?? "-"],
        ["通知死信", webhook.dead_letters ?? "-"],
        ["待对账订单", confirmation.pending_orders ?? "-"],
        ["连续采集失败", collection.consecutive_failures ?? "-"],
        ["连续通知失败", webhook.consecutive_failures ?? "-"],
      ])),
      section("数据保护", facts([
        ["自动备份", backup.enabled ? (backup.ok ? "正常" : "异常") : "未启用"],
        ["最近成功", formatTime(backup.last_success_at)],
        ["备份文件", backup.backup_name || "-", "code"],
        ["保留数量", backup.retained_count ?? "-"],
        ["实例一致", formatBoolean(backup.instance_matches)],
        ["恢复要求", backup.recovery_required ? "需要处理" : "无"],
      ])),
    );
  }

  async function renderOrders() {
    setDocumentTitle("订单");
    const query = new URLSearchParams(location.search);
    const orderId = query.get("id");
    if (orderId) {
      const response = await api(`/orders/${encodeURIComponent(orderId)}`);
      renderOrderDetail(response.data);
      return;
    }

    const merchantNo = query.get("merchant_order_no");
    if (merchantNo) {
      try {
        const response = await api(`/orders/by-merchant-no/${encodeURIComponent(merchantNo)}`);
        renderOrderDetail(response.data);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          renderMain(
            pageHeader("订单", "按商户订单号精确查找，或浏览最近订单。"),
            orderSearchForm(merchantNo),
            emptyState("未找到订单", "请核对完整商户订单号。"),
          );
          return;
        }
        throw error;
      }
      return;
    }

    const checkoutFilter = readEnumQuery(
      query,
      "checkout_status",
      ["ALL", "OPEN", "CLOSED", "EXPIRED"],
      "ALL",
    );
    const paymentFilter = readEnumQuery(
      query,
      "payment_status",
      ["ALL", "UNPAID", "CONFIRMED", "DISPUTED"],
      "ALL",
    );
    const parameters = pickQuery(query, ["cursor"]);
    if (checkoutFilter !== "ALL") parameters.set("checkout_status", checkoutFilter);
    if (paymentFilter !== "ALL") parameters.set("payment_status", paymentFilter);
    parameters.set("limit", "50");
    const response = await api(`/orders?${parameters}`);
    const rows = response.data || [];
    renderMain(
      pageHeader("订单", "按收银台和付款状态查看订单事实。", [button("刷新", () => location.reload())]),
      orderSearchForm(""),
      filterBar([
        selectField("收银台", "checkout_status", checkoutFilter, ["ALL", "OPEN", "CLOSED", "EXPIRED"], statusText),
        selectField("付款", "payment_status", paymentFilter, ["ALL", "UNPAID", "CONFIRMED", "DISPUTED"], statusText),
        button("应用筛选", () => applyFilters(["checkout_status", "payment_status"]), "primary"),
      ]),
      rows.length === 0
        ? emptyState("没有符合条件的订单", "调整筛选条件后重新查询。")
        : tableRegion("订单列表", [
          ["商户订单号", (row) => detailLink("orders", row.order_id, row.merchant_order_no, "perpay-code")],
          ["应付金额", (row) => money(row.payable_amount_cents, row.currency)],
          ["收银台", (row) => stateLabel(row.checkout?.status, toneForState(row.checkout?.status))],
          ["付款", (row) => stateLabel(row.payment?.status, toneForState(row.payment?.status))],
          ["退款", (row) => stateLabel(row.refund?.status, toneForState(row.refund?.status))],
          ["创建时间", (row) => formatTime(row.created_at)],
        ], rows),
      cursorNavigation(response.page?.next_cursor),
    );
  }

  function renderOrderDetail(payload) {
    const order = payload.order || payload;
    const events = payload.events || [];
    setDocumentTitle(`订单 ${order.merchant_order_no || "详情"}`);
    const timeline = events.length
      ? tableRegion("订单事件", [
        ["时间", (item) => formatTime(item.occurred_at)],
        ["类型", (item) => code(item.event_type)],
        ["序号", (item) => String(item.sequence ?? "-")],
        ["详情", (item) => jsonDisclosure(item.details || item.event_details || {})],
      ], events)
      : emptyState("暂无事件", "该订单还没有可显示的状态事件。", true);
    renderMain(
      pageHeader(order.merchant_order_no || "订单详情", order.description || "订单状态与审计事件。", [
        linkButton("返回订单", "/admin/orders"),
      ]),
      div("perpay-detail-grid", [
        detailBlock("订单事实", facts([
          ["订单 ID", order.order_id, "code"],
          ["请求金额", formatMoney(order.requested_amount_cents, order.currency)],
          ["应付金额", formatMoney(order.payable_amount_cents, order.currency)],
          ["实收金额", formatMoney(order.received_amount_cents, order.currency)],
          ["收银台", statusText(order.checkout_status || order.checkout?.status)],
          ["付款", `${statusText(order.payment_status || order.payment?.status)} / ${statusText(order.payment_basis || order.payment?.basis)}`],
          ["退款", statusText(order.refund_status || order.refund?.status)],
          ["创建时间", formatTime(order.created_at)],
          ["到期时间", formatTime(order.expires_at || order.checkout?.expires_at)],
          ["更新时间", formatTime(order.updated_at)],
        ])),
        detailBlock("通知", facts([
          ["目标", order.notification?.notify_url || order.notify_url || "未配置", "code"],
          ["当前版本", order.version ?? "-"],
          ["付款证据", evidenceText(order.payment_basis || order.payment?.basis)],
        ])),
      ]),
      section("状态轨道", timeline),
    );
  }

  async function renderExceptions() {
    setDocumentTitle("异常处理");
    const query = new URLSearchParams(location.search);
    const id = query.get("id");
    if (id) {
      const response = await api(`/reconciliation/exceptions/${encodeURIComponent(id)}`);
      await renderExceptionDetail(response.data);
      return;
    }
    const settingsView = (await api("/settings")).data || {};
    const generations = settingsView.provider_generations || [];
    const providerAccountKey = selectedProviderGeneration(query, generations);
    const parameters = pickQuery(query, ["cursor"]);
    if (providerAccountKey) parameters.set("provider_account_key", providerAccountKey);
    parameters.set("limit", "100");
    const response = await api(`/reconciliation/exceptions?${parameters}`);
    const rows = response.data || [];
    renderMain(
      pageHeader("异常处理", "只有不能唯一、安全自动匹配的资金事实会进入这里。", [button("刷新", () => location.reload())]),
      providerGenerationFilter(generations, providerAccountKey, ["provider_account_key"]),
      rows.length === 0
        ? emptyState("没有开放异常", "正常唯一匹配的付款已经自动确认。")
        : tableRegion("开放异常", [
          ["类型", (row) => detailLink("exceptions", row.exception_id, statusText(row.exception_type))],
          ["流水 ID", (row) => shortCode(row.ledger_entry_id)],
          ["订单 ID", (row) => shortCode(row.order_id)],
          ["状态", (row) => stateLabel(row.status, "warning")],
          ["发现时间", (row) => formatTime(row.created_at)],
        ], rows),
      cursorNavigation(response.page?.next_cursor),
    );
  }

  async function renderExceptionDetail(exception) {
    let ledger = null;
    let candidates = [];
    let ledgerError = null;
    let candidatesError = null;
    if (exception.ledger_entry_id) {
      const results = await Promise.allSettled([
        api(`/reconciliation/ledger-entries/${encodeURIComponent(exception.ledger_entry_id)}`),
        api(`/reconciliation/ledger-entries/${encodeURIComponent(exception.ledger_entry_id)}/candidates`),
      ]);
      if (results[0].status === "fulfilled") ledger = results[0].value.data;
      else ledgerError = results[0].reason;
      if (results[1].status === "fulfilled") candidates = results[1].value.data;
      else candidatesError = results[1].reason;
    }
    const actions = [];
    const evidenceReady = ledgerError === null && candidatesError === null;
    if (exception.status === "OPEN" && exception.ledger_entry_id && evidenceReady && isManualLedgerEligible(ledger)) {
      actions.push(button("人工认领", () => openFinancialDecision("manual", exception, ledger), "primary"));
    }
    if (exception.status === "OPEN" && exception.ledger_entry_id && evidenceReady && isRefundLedgerEligible(ledger)) {
      actions.push(button("登记退款", () => openFinancialDecision("refund", exception, ledger)));
    }
    actions.push(linkButton(
      "返回异常",
      exception.provider_account_key
        ? `/admin/exceptions?provider_account_key=${encodeURIComponent(exception.provider_account_key)}`
        : "/admin/exceptions",
    ));
    renderMain(
      pageHeader(statusText(exception.exception_type), "异常证据与可执行处置。", actions),
      div("perpay-detail-grid", [
        detailBlock("异常事实", facts([
          ["异常 ID", exception.exception_id, "code"],
          ["状态", statusText(exception.status)],
          ["订单 ID", exception.order_id || "未关联", "code"],
          ["流水 ID", exception.ledger_entry_id || "无", "code"],
          ["候选 ID", exception.candidate_id || "无", "code"],
          ["发现时间", formatTime(exception.created_at)],
          ["处理时间", formatTime(exception.resolved_at)],
          ["处理结果", exception.resolution ? jsonDisclosure(exception.resolution) : "待处理"],
        ])),
        detailBlock("流水", ledgerError ? unavailableState("流水详情不可用", ledgerError) : ledger ? facts([
          ["方向", statusText(ledger.direction)],
          ["金额", formatMoney(ledger.amount_cents, ledger.currency)],
          ["发生时间", formatTime(ledger.occurred_at)],
          ["状态", statusText(ledger.state)],
          ["平台流水号", ledger.provider_order_no || "-", "code"],
          ["对方账户", ledger.other_account || "-"],
        ]) : emptyState("没有流水详情", "此异常没有可读取的标准化流水。", true)),
      ]),
      section("候选订单", candidatesError ? unavailableState("候选订单不可用", candidatesError) : candidates.length ? tableRegion("匹配候选", [
        ["订单 ID", (row) => orderLink(row.order_id)],
        ["证据", (row) => evidenceText(row.evidence_type)],
        ["状态", (row) => stateLabel(row.status, toneForState(row.status))],
        ["创建时间", (row) => formatTime(row.created_at)],
      ], candidates) : emptyState("没有候选订单", "可通过商户订单号查找正确订单后人工认领。", true)),
      section("原始上下文", jsonBlock(exception.details || {})),
    );
  }

  async function renderSettlements() {
    setDocumentTitle("结算历史");
    const query = new URLSearchParams(location.search);
    const id = query.get("id");
    if (id) {
      const response = await api(`/reconciliation/matches/${encodeURIComponent(id)}`);
      renderSettlementDetail(response.data);
      return;
    }
    const status = readEnumQuery(query, "status", ["SETTLED", "REVERSED"], "SETTLED");
    const parameters = pickQuery(query, ["cursor"]);
    if (status !== "SETTLED") parameters.set("status", status);
    parameters.set("limit", "100");
    const response = await api(`/reconciliation/matches?${parameters}`);
    const rows = response.data || [];
    renderMain(
      pageHeader("结算历史", "自动确认和管理员处置形成的有效或已撤销关联。", [button("刷新", () => location.reload())]),
      filterBar([
        selectField("状态", "status", status, ["SETTLED", "REVERSED"], statusText),
        button("应用筛选", () => applyFilters(["status"]), "primary"),
      ]),
      rows.length === 0 ? emptyState("没有结算记录", "新的自动确认会直接出现在这里。") : tableRegion("结算记录", [
        ["关联 ID", (row) => detailLink("settlements", row.payment_match_id, short(row.payment_match_id), "perpay-code")],
        ["订单", (row) => orderLink(row.order_id)],
        ["流水", (row) => shortCode(row.ledger_entry_id)],
        ["证据", (row) => evidenceText(row.evidence_type)],
        ["状态", (row) => stateLabel(row.status, toneForState(row.status))],
        ["创建时间", (row) => formatTime(row.created_at)],
      ], rows),
      cursorNavigation(response.page?.next_cursor),
    );
  }

  function renderSettlementDetail(match) {
    const actions = [linkButton("返回结算", "/admin/settlements")];
    if (match.status === "SETTLED") {
      actions.unshift(button("撤销关联", () => openReverseSettlement(match), "danger"));
    }
    const order = match.order || {};
    const ledger = match.ledger_entry || {};
    const steps = [
      processStep("订单创建", true),
      processStep("流水采集", true),
      processStep(match.candidate ? "唯一候选" : "管理员认领", true),
      processStep(match.status === "REVERSED" ? "关联已撤销" : "付款已确认", true, match.status === "REVERSED" ? "danger" : "success"),
    ];
    renderMain(
      pageHeader(`结算 ${short(match.payment_match_id)}`, "订单、流水与确认依据的证据轨道。", actions),
      section("状态轨道", el("ol", { class: "uzu-process", "aria-label": "结算证据轨道" }, steps)),
      div("perpay-detail-grid", [
        detailBlock("订单", facts([
          ["商户订单号", order.merchant_order_no || "-", "code"],
          ["订单 ID", match.order_id, "code"],
          ["应付金额", formatMoney(order.payable_amount_cents, order.currency)],
          ["实收金额", formatMoney(order.received_amount_cents, order.currency)],
          ["付款状态", statusText(order.payment_status)],
          ["证据来源", evidenceText(order.payment_basis)],
        ])),
        detailBlock("流水", facts([
          ["流水 ID", match.ledger_entry_id, "code"],
          ["金额", formatMoney(ledger.amount_cents, ledger.currency)],
          ["方向", statusText(ledger.direction)],
          ["发生时间", formatTime(ledger.occurred_at)],
          ["平台流水号", ledger.provider_order_no || "-", "code"],
          ["状态", statusText(ledger.state)],
        ])),
      ]),
      section("关联证据", jsonBlock(match.evidence || {})),
    );
  }

  async function renderLedgerConflicts() {
    setDocumentTitle("账务冲突");
    const query = new URLSearchParams(location.search);
    const id = query.get("id");
    if (id) {
      const response = await api(`/ledger/conflicts/${encodeURIComponent(id)}`);
      renderLedgerConflictDetail(response.data);
      return;
    }
    const status = readEnumQuery(
      query,
      "status",
      ["OPEN", "ALL", "RESOLVED", "IGNORED"],
      "OPEN",
    );
    const settingsView = (await api("/settings")).data || {};
    const generations = settingsView.provider_generations || [];
    const providerAccountKey = selectedProviderGeneration(query, generations);
    const parameters = pickQuery(query, ["cursor"]);
    if (status !== "OPEN") parameters.set("status", status);
    if (providerAccountKey) parameters.set("provider_account_key", providerAccountKey);
    parameters.set("limit", "100");
    const response = await api(`/ledger/conflicts?${parameters}`);
    const rows = response.data || [];
    renderMain(
      pageHeader("账务冲突", "采集证据重复、变化或无法标准化时形成的隔离记录。", [button("刷新", () => location.reload())]),
      filterBar([
        selectField("状态", "status", status, ["OPEN", "ALL", "RESOLVED", "IGNORED"], statusText),
        generations.length > 0
          ? selectField(
              "采集应用",
              "provider_account_key",
              providerAccountKey,
              generations.map((generation) => generation.provider_account_key),
              (value) => providerGenerationLabel(value, generations),
            )
          : null,
        button(
          "应用筛选",
          () => applyFilters(["status", "provider_account_key"], true),
          "primary",
        ),
      ]),
      rows.length === 0 ? emptyState("没有账务冲突", "采集到的流水证据目前一致。") : tableRegion("冲突记录", [
        ["类型", (row) => detailLink("ledger-conflicts", row.conflict_id, statusText(row.conflict_type))],
        ["外部流水", (row) => code(row.external_event_id || "-")],
        ["状态", (row) => stateLabel(row.status, toneForState(row.status))],
        ["处理结果", (row) => row.resolution_action ? statusText(row.resolution_action) : "-"],
        ["发现时间", (row) => formatTime(row.created_at)],
      ], rows),
      cursorNavigation(response.page?.next_cursor),
    );
  }

  function renderLedgerConflictDetail(detail) {
    const conflict = detail.conflict;
    const availableAction = conflictResolutionAction(conflict.conflict_type);
    const actions = [linkButton(
      "返回冲突",
      conflict.provider_account_key
        ? `/admin/ledger-conflicts?provider_account_key=${encodeURIComponent(conflict.provider_account_key)}`
        : "/admin/ledger-conflicts",
    )];
    if (conflict.status === "OPEN" && availableAction) {
      actions.unshift(button("处理冲突", () => openConflictResolution(conflict), "primary"));
    }
    renderMain(
      pageHeader(statusText(conflict.conflict_type), "冲突证据和隔离结果。", actions),
      div("perpay-detail-grid", [
        detailBlock("冲突事实", facts([
          ["冲突 ID", conflict.conflict_id, "code"],
          ["状态", statusText(conflict.status)],
          ["外部流水号", conflict.external_event_id || "-", "code"],
          ["原始页", conflict.raw_page_id || "-", "code"],
          ["现有流水", conflict.existing_ledger_entry_id || "-", "code"],
          ["发现时间", formatTime(conflict.created_at)],
          ["处理时间", formatTime(conflict.resolved_at)],
        ])),
        detailBlock("处理", facts([
          ["动作", conflict.resolution_action ? statusText(conflict.resolution_action) : "待处理"],
          ["可用处置", conflict.status !== "OPEN"
            ? "无需处置"
            : availableAction
              ? statusText(availableAction)
              : "等待系统补充一致采集证据"],
          ["结果", conflict.resolution ? jsonDisclosure(conflict.resolution) : "待处理"],
          ["操作 ID", conflict.resolution_operation_id || "-", "code"],
          ["证据指纹", conflict.conflict_fingerprint || "-", "code"],
        ])),
      ]),
      section("原始响应", detail.raw_page ? jsonBlock(detail.raw_page) : emptyState("没有原始页", "该冲突未关联原始分页记录。", true)),
      section("流入事件", detail.incoming_event ? jsonBlock(detail.incoming_event) : emptyState("没有流入事件", "该冲突未关联单条流入事件。", true)),
      section("现有流水", detail.existing_ledger_entry ? jsonBlock(detail.existing_ledger_entry) : emptyState("没有现有流水", "该冲突未关联标准化流水。", true)),
    );
  }

  async function renderNotifications() {
    setDocumentTitle("通知投递");
    const query = new URLSearchParams(location.search);
    const id = query.get("id");
    if (id) {
      const [detailResponse, attemptsResponse] = await Promise.all([
        api(`/webhooks/deliveries/${encodeURIComponent(id)}`),
        api(`/webhooks/deliveries/${encodeURIComponent(id)}/attempts`),
      ]);
      renderNotificationDetail(detailResponse.data, attemptsResponse.data || []);
      return;
    }
    const status = readEnumQuery(
      query,
      "status",
      ["ALL", "PENDING", "LEASED", "RETRY_WAIT", "ACKNOWLEDGED", "DEAD_LETTER"],
      "ALL",
    );
    const parameters = pickQuery(query, ["cursor"]);
    if (status !== "ALL") parameters.set("status", status);
    parameters.set("limit", "100");
    const response = await api(`/webhooks/deliveries?${parameters}`);
    const rows = response.data || [];
    renderMain(
      pageHeader("通知投递", "付款、争议和退款事件的异步送达状态。", [button("刷新", () => location.reload())]),
      filterBar([
        selectField("状态", "status", status, ["ALL", "PENDING", "LEASED", "RETRY_WAIT", "ACKNOWLEDGED", "DEAD_LETTER"], statusText),
        button("应用筛选", () => applyFilters(["status"]), "primary"),
      ]),
      rows.length === 0 ? emptyState("没有通知投递", "配置回调地址的订单产生事件后会出现在这里。") : tableRegion("通知记录", [
        ["事件", (row) => detailLink("notifications", row.delivery_id, row.event?.event_type || "通知")],
        ["订单", (row) => orderLink(row.event?.order_id)],
        ["代次", (row) => String(row.generation)],
        ["状态", (row) => stateLabel(row.status, toneForState(row.status))],
        ["尝试", (row) => String(row.attempt_count)],
        ["更新时间", (row) => formatTime(row.updated_at)],
      ], rows),
      cursorNavigation(response.page?.next_cursor),
    );
  }

  function renderNotificationDetail(detail, attempts) {
    const delivery = detail.delivery;
    const actions = [linkButton("返回通知", "/admin/notifications")];
    if (delivery.status === "DEAD_LETTER" || delivery.status === "ACKNOWLEDGED") {
      actions.unshift(button("重新投递", () => openRedelivery(delivery), "primary"));
    }
    renderMain(
      pageHeader(detail.event?.event_type || "通知详情", "事件、目标与每次网络尝试的持久证据。", actions),
      div("perpay-detail-grid", [
        detailBlock("投递", facts([
          ["投递 ID", delivery.delivery_id, "code"],
          ["状态", statusText(delivery.status)],
          ["代次", delivery.generation],
          ["尝试次数", delivery.attempt_count],
          ["下次尝试", formatTime(delivery.next_attempt_at)],
          ["最后错误", delivery.last_error_code || "无", "code"],
          ["更新时间", formatTime(delivery.updated_at)],
        ])),
        detailBlock("目标", facts([
          ["地址", detail.target?.target_url || "-", "code"],
          ["允许来源", detail.target?.allowed_origin || "-", "code"],
          ["格式", detail.target?.format || "-"],
          ["事件 ID", detail.event?.event_id || "-", "code"],
          ["订单 ID", detail.event?.order_id || "-", "code"],
        ])),
      ]),
      section("尝试记录", attempts.length ? tableRegion("通知尝试", [
        ["次数", (row) => String(row.attempt_number)],
        ["结果", (row) => stateLabel(row.outcome, toneForState(row.outcome))],
        ["HTTP", (row) => row.http_status === null ? "-" : String(row.http_status)],
        ["地址", (row) => code(row.connected_address || "-")],
        ["错误", (row) => code(row.error_code || row.ack_code || "-")],
        ["开始时间", (row) => formatTime(row.started_at)],
      ], attempts) : emptyState("还没有投递尝试", "调度器领取任务后会记录尝试证据。", true)),
      section("事件载荷", jsonBlock(detail.event?.payload || {})),
    );
  }

  async function renderSettings() {
    setDocumentTitle("设置");
    const response = await api("/settings");
    const view = response.data || {};
    renderMain(
      pageHeader("设置", "经营码、支付宝平台、API 客户端、通知与收银台策略。", [
        button("刷新", () => location.reload()),
      ]),
      settingsCompletion(view),
      section("收款配置", div("perpay-detail-grid", [
        detailBlock("经营码与金额", collectionSettingsForm(view)),
        detailBlock("支付宝平台", providerSettingsForm(view)),
      ])),
      section("通知", detailBlock("异步通知", notificationSettingsForm(view))),
      section("高级设置", detailBlock("收银台生命周期", advancedSettingsForm(view))),
      section("API 客户端", detailBlock("调用凭据", apiSettingsBlock(view))),
      section("已保存密钥", detailBlock("敏感值", secretSettingsBlock(view))),
      providerGenerationHistory(view.provider_generations || []),
    );
  }

  function settingsCompletion(view) {
    const completion = view.completion || {};
    const complete = completion.complete === true;
    const missing = [];
    if (!completion.collection) missing.push("经营码");
    if (!completion.provider) missing.push("支付宝平台");
    if (!completion.api) missing.push("API 客户端");
    return el("div", {
      class: `uzu-alert ${complete ? "uzu-alert-success" : "uzu-alert-warning"}`,
      role: "status",
    }, [
      el("strong", { text: complete ? "收款配置已完成" : "收款入口暂未开放" }),
      el("p", {
        text: complete
          ? "必需配置已就绪；后台会继续根据采集和自动确认状态控制收款入口。"
          : `还缺少：${missing.join("、") || "必需配置"}。完成这些配置前不会创建新订单或展示付款指令。`,
      }),
    ]);
  }

  function collectionSettingsForm(view) {
    const collection = view.collection || {};
    const form = el("form", { class: "uzu-form", id: "settings-collection-form", novalidate: true }, [
      field(
        "经营码内容",
        settingsTextarea("settings-code-payload", collection.code_payload || "", 3, true),
        "填写支付宝经营码对应的收款链接；不会把内容写入前端脚本。",
      ),
      field(
        "订单有效期（秒）",
        input({
          id: "settings-order-ttl",
          type: "number",
          min: 60,
          max: 1800,
          step: 1,
          value: collection.order_ttl_seconds ?? 300,
          required: true,
        }),
        "范围 60–1800 秒。",
      ),
      field(
        "金额尾差上限（分）",
        input({
          id: "settings-amount-offset",
          type: "number",
          min: 1,
          max: 99,
          step: 1,
          value: collection.amount_offset_maximum_cents ?? 99,
          required: true,
        }),
        "用于分配唯一应付金额，范围 1–99 分。",
      ),
      button("保存收款配置", null, "primary", "submit"),
    ]);
    form.addEventListener("submit", (event) => void saveCollectionSettings(event, form, view.revision));
    return form;
  }

  function providerSettingsForm(view) {
    const provider = view.provider || {};
    const hasProvider = Boolean(view.completion?.provider);
    const form = el("form", { class: "uzu-form", id: "settings-provider-form", novalidate: true }, [
      field(
        "运行环境",
        select(["PRODUCTION", "SANDBOX"], provider.environment || "PRODUCTION", (value) =>
          value === "PRODUCTION" ? "生产环境" : "沙箱环境"),
        "应用 ID 或端点变更会创建新的流水账户代际，历史账务保持隔离。",
      ),
      field(
        "应用 ID",
        input({ id: "settings-provider-app-id", value: provider.app_id || "", maxlength: 64, required: true }),
      ),
      field(
        "应用私钥",
        settingsTextarea("settings-provider-private-key", "", 5, !hasProvider),
        hasProvider ? "留空表示保留当前私钥；填写新值会替换它。" : "首次配置必填，支持 PEM 或 Base64 内容。",
      ),
      field(
        "平台公钥",
        settingsTextarea("settings-provider-public-key", "", 5, !hasProvider),
        hasProvider ? "留空表示保留当前平台公钥；填写新值会替换它。" : "首次配置必填，支持 PEM 或 Base64 内容。",
      ),
      field(
        "请求超时（毫秒）",
        input({
          id: "settings-provider-timeout",
          type: "number",
          min: 1000,
          max: 120000,
          step: 1000,
          value: provider.timeout_milliseconds ?? 8000,
          required: true,
        }),
      ),
      field(
        "采集间隔（秒）",
        input({
          id: "settings-provider-scan-interval",
          type: "number",
          min: 5,
          max: 3600,
          step: 1,
          value: provider.scan_interval_seconds ?? 10,
          required: true,
        }),
      ),
      field(
        "最大成功年龄（秒）",
        input({
          id: "settings-provider-max-age",
          type: "number",
          min: 10,
          max: 86400,
          step: 1,
          value: provider.maximum_success_age_seconds ?? 60,
          required: true,
        }),
        "至少是采集间隔的两倍。",
      ),
      button("保存平台配置", null, "primary", "submit"),
    ]);
    const environment = form.querySelector("select");
    if (environment instanceof HTMLSelectElement) environment.id = "settings-provider-environment";
    form.addEventListener("submit", (event) => void saveProviderSettings(
      event,
      form,
      view.revision,
      provider,
    ));
    return form;
  }

  function notificationSettingsForm(view) {
    const notifications = view.notifications || {};
    const form = el("form", { class: "uzu-form", id: "settings-notification-form", novalidate: true }, [
      field(
        "启用通知",
        input({ id: "settings-notification-enabled", type: "checkbox", checked: notifications.enabled === true }),
        "通知是可选功能；关闭后不会影响支付确认。",
      ),
      field(
        "允许的 HTTPS Origin",
        input({
          id: "settings-notification-origin",
          type: "url",
          value: notifications.allowed_origin || "",
          placeholder: "https://merchant.example",
        }),
        "启用通知时必填，不要填写路径。",
      ),
      field(
        "请求超时（毫秒）",
        input({
          id: "settings-notification-timeout",
          type: "number",
          min: 1000,
          max: 30000,
          step: 1000,
          value: notifications.timeout_milliseconds ?? 5000,
          required: true,
        }),
      ),
      field(
        "最大尝试次数",
        input({
          id: "settings-notification-attempts",
          type: "number",
          min: 1,
          max: 100,
          step: 1,
          value: notifications.maximum_attempts ?? 12,
          required: true,
        }),
      ),
      field(
        "初始重试间隔（秒）",
        input({
          id: "settings-notification-retry-base",
          type: "number",
          min: 1,
          max: 3600,
          step: 1,
          value: notifications.retry_base_seconds ?? 5,
          required: true,
        }),
      ),
      field(
        "最大重试间隔（秒）",
        input({
          id: "settings-notification-retry-max",
          type: "number",
          min: 1,
          max: 86400,
          step: 1,
          value: notifications.retry_maximum_seconds ?? 3600,
          required: true,
        }),
      ),
      button("保存通知配置", null, "primary", "submit"),
    ]);
    form.addEventListener("submit", (event) => void saveNotificationSettings(event, form, view.revision));
    return form;
  }

  function advancedSettingsForm(view) {
    const advanced = view.advanced || {};
    const form = el("form", { class: "uzu-form", id: "settings-advanced-form", novalidate: true }, [
      field(
        "收银台令牌轮换周期（天）",
        input({
          id: "settings-checkout-key-rotation-days",
          type: "number",
          min: 1,
          max: 3650,
          step: 1,
          value: advanced.checkout_key_rotation_days ?? 90,
          required: true,
        }),
        "新订单使用新令牌密钥的周期，范围 1–3650 天；已创建的订单不受影响。",
      ),
      field(
        "终态收银台观察期（秒）",
        input({
          id: "settings-checkout-terminal-observation-seconds",
          type: "number",
          min: 60,
          max: 604800,
          step: 1,
          value: advanced.checkout_terminal_observation_seconds ?? 86400,
          required: true,
        }),
        "订单关闭或过期后仍可读取收银台的时间，范围 60–604800 秒。",
      ),
      button("保存高级设置", null, "primary", "submit"),
    ]);
    form.addEventListener("submit", (event) => void saveAdvancedSettings(event, form, view.revision));
    return form;
  }

  function apiSettingsBlock(view) {
    const metadata = view.secrets?.api_secret || {};
    return div("uzu-stack", [
      el("p", {
        class: "uzu-help",
        text: "API 客户端 ID 固定为 default。轮换后旧密钥立即失效，新密钥只在本次操作中显示。",
      }),
      secretMetadataRow("API 密钥", "api_secret", metadata),
      button("轮换 API 密钥", () => void rotateApiSecret(view.revision), "danger"),
    ]);
  }

  function secretSettingsBlock(view) {
    const secrets = view.secrets || {};
    return div("uzu-stack", [
      el("p", {
        class: "uzu-help",
        text: "敏感值默认只显示掩码。查看会要求再次输入管理员密码，并写入审计记录。",
      }),
      secretMetadataRow("应用私钥", "provider_private_key", secrets.provider_private_key),
      secretMetadataRow("平台公钥", "provider_public_key", secrets.provider_public_key),
      secretMetadataRow("通知密钥", "webhook_secret", secrets.webhook_secret),
    ]);
  }

  function secretMetadataRow(label, name, metadata = {}) {
    const configured = metadata.configured === true;
    const reveal = button("查看", () => void revealRuntimeSecret(name, label));
    reveal.disabled = !configured;
    return div("uzu-flex uzu-wrap uzu-gap-2", [
      div("uzu-stack", [
        el("strong", { text: label }),
        el("span", { class: "uzu-muted uzu-mono perpay-code", text: configured ? (metadata.masked || "已配置") : "未配置" }),
        metadata.fingerprint ? el("span", { class: "uzu-help uzu-mono perpay-code", text: `指纹 ${metadata.fingerprint}` }) : null,
      ]),
      reveal,
    ]);
  }

  function settingsTextarea(id, value, rows, required) {
    const control = el("textarea", { class: "uzu-textarea", id, rows: String(rows), maxlength: 16384 });
    control.value = value;
    control.required = required;
    control.spellcheck = false;
    return control;
  }

  async function saveCollectionSettings(event, form, revision) {
    event.preventDefault();
    if (!(form instanceof HTMLFormElement) || !form.reportValidity()) return;
    const submit = form.querySelector("button[type=submit]");
    setBusy(submit, true, "正在保存");
    try {
      await protectedRequest("/settings/collection", {
        revision,
        code_payload: valueOf("#settings-code-payload"),
        order_ttl_seconds: Number(valueOf("#settings-order-ttl")),
        amount_offset_maximum_cents: Number(valueOf("#settings-amount-offset")),
      }, "PUT");
      toast("收款配置已保存", "success");
      await renderSettings();
    } catch (error) {
      toast(errorMessage(error), "danger");
    } finally {
      setBusy(submit, false, "保存收款配置");
    }
  }

  async function saveProviderSettings(event, form, revision, currentProvider) {
    event.preventDefault();
    if (!(form instanceof HTMLFormElement) || !form.reportValidity()) return;
    const privateKey = valueOf("#settings-provider-private-key");
    const publicKey = valueOf("#settings-provider-public-key");
    const environment = valueOf("#settings-provider-environment");
    const appId = valueOf("#settings-provider-app-id");
    const identityChanged = Boolean(currentProvider?.app_id) && (
      environment !== currentProvider.environment || appId !== currentProvider.app_id
    );
    if ((!currentProvider?.app_id || identityChanged) && (!privateKey || !publicKey)) {
      toast(
        identityChanged
          ? "更换采集应用时必须重新填写应用私钥和平台公钥"
          : "首次配置必须填写应用私钥和平台公钥",
        "danger",
      );
      return;
    }
    if (identityChanged && !window.confirm(
      "这会归档当前采集应用并创建新的账务代际。旧订单和流水会保留，但不能与新代际交叉匹配。确定继续吗？",
    )) return;
    const submit = form.querySelector("button[type=submit]");
    setBusy(submit, true, "正在保存");
    const body = {
      revision,
      environment,
      app_id: appId,
      timeout_milliseconds: Number(valueOf("#settings-provider-timeout")),
      scan_interval_seconds: Number(valueOf("#settings-provider-scan-interval")),
      maximum_success_age_seconds: Number(valueOf("#settings-provider-max-age")),
      ...(privateKey ? { private_key: privateKey } : {}),
      ...(publicKey ? { platform_public_key: publicKey } : {}),
    };
    try {
      await protectedRequest("/settings/provider", body, "PUT");
      toast("支付宝平台配置已保存", "success");
      await renderSettings();
    } catch (error) {
      toast(errorMessage(error), "danger");
    } finally {
      setBusy(submit, false, "保存平台配置");
    }
  }

  async function saveNotificationSettings(event, form, revision) {
    event.preventDefault();
    if (!(form instanceof HTMLFormElement) || !form.reportValidity()) return;
    const enabled = checkedOf("#settings-notification-enabled");
    const submit = form.querySelector("button[type=submit]");
    setBusy(submit, true, "正在保存");
    const body = {
      revision,
      enabled,
      ...(enabled ? { allowed_origin: valueOf("#settings-notification-origin") } : {}),
      timeout_milliseconds: Number(valueOf("#settings-notification-timeout")),
      maximum_attempts: Number(valueOf("#settings-notification-attempts")),
      retry_base_seconds: Number(valueOf("#settings-notification-retry-base")),
      retry_maximum_seconds: Number(valueOf("#settings-notification-retry-max")),
    };
    try {
      await protectedRequest("/settings/notifications", body, "PUT");
      toast("通知配置已保存", "success");
      await renderSettings();
    } catch (error) {
      toast(errorMessage(error), "danger");
    } finally {
      setBusy(submit, false, "保存通知配置");
    }
  }

  async function saveAdvancedSettings(event, form, revision) {
    event.preventDefault();
    if (!(form instanceof HTMLFormElement) || !form.reportValidity()) return;
    const submit = form.querySelector("button[type=submit]");
    setBusy(submit, true, "正在保存");
    try {
      await protectedRequest("/settings/advanced", {
        revision,
        checkout_key_rotation_days: Number(valueOf("#settings-checkout-key-rotation-days")),
        checkout_terminal_observation_seconds: Number(
          valueOf("#settings-checkout-terminal-observation-seconds"),
        ),
      }, "PUT");
      toast("高级设置已保存", "success");
      await renderSettings();
    } catch (error) {
      toast(errorMessage(error), "danger");
    } finally {
      setBusy(submit, false, "保存高级设置");
    }
  }

  async function rotateApiSecret(revision) {
    const confirmed = await confirmAction(
      "轮换 API 密钥",
      "现有 API 密钥会立即失效，正在运行的客户端需要改用新密钥。",
      "继续轮换",
    );
    if (!confirmed) return;
    try {
      const response = await protectedRequest("/settings/api-key/actions/rotate", { revision });
      showSecretValue(
        "新的 API 密钥",
        response.data.secret,
        "请立即复制；关闭后不会再次显示完整值。",
        () => void refreshSettingsAfterSecret(),
      );
    } catch (error) {
      toast(errorMessage(error), "danger");
    }
  }

  async function revealRuntimeSecret(name, label) {
    try {
      const response = await protectedRequest(`/settings/secrets/${encodeURIComponent(name)}/actions/reveal`, {});
      showSecretValue(label, response.data.value, "此值已写入审计记录，请勿截图或粘贴到公共位置。");
    } catch (error) {
      toast(errorMessage(error), "danger");
    }
  }

  function showSecretValue(label, value, message, onClose) {
    const control = el("textarea", { class: "uzu-textarea", rows: "5", readonly: true });
    control.value = value || "";
    const dialog = document.querySelector("#action-dialog");
    let closed = false;
    const finish = () => {
      if (closed) return;
      closed = true;
      dialog?.removeEventListener("uzu-dialog-close", handleDialogClose);
      control.value = "";
      document.querySelector("#action-content")?.replaceChildren();
      onClose?.();
    };
    const handleDialogClose = (event) => {
      if (event.target === dialog) finish();
    };
    dialog?.addEventListener("uzu-dialog-close", handleDialogClose);
    const content = div("uzu-stack", [
      el("div", { class: "uzu-alert uzu-alert-warning", role: "alert", text: message }),
      control,
      div("uzu-dialog-actions", [
        button("复制", async () => {
          try {
            await copyText(control.value);
            toast("已复制到剪贴板", "success");
          } catch {
            toast("复制失败，请手动选择并复制", "danger");
          }
        }, "primary"),
        button("关闭", () => {
          closeActionDialog();
          finish();
        }),
      ]),
    ]);
    openActionDialog(label, "敏感值仅在当前对话框中显示。", content);
    control.focus();
    control.select();
  }

  async function refreshSettingsAfterSecret() {
    try {
      await renderSettings();
    } catch (error) {
      renderRouteError(error, () => void refreshSettingsAfterSecret());
    }
  }

  async function copyText(value) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
    const fallback = el("textarea", { readonly: true });
    fallback.value = value;
    fallback.style.position = "fixed";
    fallback.style.opacity = "0";
    document.body.append(fallback);
    fallback.select();
    const copied = document.execCommand("copy");
    fallback.remove();
    if (!copied) throw new Error("copy failed");
  }

  function checkedOf(selector) {
    const control = document.querySelector(selector);
    return control instanceof HTMLInputElement && control.checked;
  }

  function renderSecurity() {
    setDocumentTitle("安全");
    const passwordForm = el("form", { class: "uzu-form", id: "password-form" }, [
      passwordField("当前密码", "current-password", "current-password"),
      passwordField("新密码", "new-password", "new-password", 12),
      passwordField("确认新密码", "confirm-password", "new-password", 12),
      button("修改密码并退出", null, "primary", "submit"),
    ]);
    passwordForm.addEventListener("submit", (event) => void changePassword(event));
    const revoke = button("撤销全部会话", () => void revokeAllSessions(), "danger");
    renderMain(
      pageHeader("安全", "管理员凭据与当前会话状态。"),
      div("perpay-detail-grid", [
        detailBlock("当前会话", facts([
          ["用户名", state.session?.username || "-"],
          ["空闲到期", formatTime(state.session?.idle_expires_at)],
          ["绝对到期", formatTime(state.session?.absolute_expires_at)],
          ["近期验证", state.session?.step_up_active ? "有效" : "未激活"],
        ])),
        detailBlock("会话控制", div("perpay-security-action", [
          el("h2", { text: "撤销访问" }),
          el("p", { text: "立即使所有管理员会话失效，包括当前浏览器。" }),
          revoke,
        ])),
      ]),
      section("修改密码", passwordForm),
    );
  }

  async function changePassword(event) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!(form instanceof HTMLFormElement) || !form.reportValidity()) return;
    const current = valueOf("#current-password");
    const next = valueOf("#new-password");
    const confirm = valueOf("#confirm-password");
    if (next !== confirm) {
      toast("两次输入的新密码不一致", "danger");
      document.querySelector("#confirm-password")?.focus();
      return;
    }
    const submit = form.querySelector("button[type=submit]");
    setBusy(submit, true, "正在修改");
    try {
      await protectedRequest("/password", { current_password: current, new_password: next });
      location.replace("/admin/login");
    } catch (error) {
      toast(errorMessage(error), "danger");
    } finally {
      setBusy(submit, false, "修改密码并退出");
    }
  }

  async function revokeAllSessions() {
    const confirmed = await confirmAction("撤销全部会话", "所有浏览器都需要重新登录。", "撤销会话");
    if (!confirmed) return;
    try {
      await protectedRequest("/sessions/revoke-all");
      location.replace("/admin/login");
    } catch (error) {
      toast(errorMessage(error), "danger");
    }
  }

  function openFinancialDecision(kind, exception, ledger) {
    const operationId = crypto.randomUUID();
    const isRefund = kind === "refund";
    if ((isRefund && !isRefundLedgerEligible(ledger)) || (!isRefund && !isManualLedgerEligible(ledger))) {
      toast("该流水当前不符合此资金操作的条件，请刷新异常证据。", "danger");
      return;
    }
    const selected = { orderId: null, merchantOrderNo: null };
    let searchVersion = 0;
    const searchInput = input({ id: "decision-order-search", required: true, placeholder: "完整商户订单号" });
    const selectedRegion = el("div", { class: "uzu-form-message", role: "status" });
    if (exception.order_id) selectedRegion.textContent = `异常当前关联订单：${exception.order_id}。请按商户订单号重新查找确认。`;
    searchInput.addEventListener("input", () => {
      searchVersion += 1;
      selected.orderId = null;
      selected.merchantOrderNo = null;
      selectedRegion.textContent = searchInput.value.trim() ? "订单号已更改，请重新查找。" : "";
      setBusy(searchButton, false, "查找订单");
    });
    const searchButton = button("查找订单", async () => {
      const merchantNo = searchInput.value.trim();
      if (!merchantNo) return;
      const requestVersion = ++searchVersion;
      selected.orderId = null;
      selected.merchantOrderNo = null;
      selectedRegion.textContent = "正在查找订单...";
      setBusy(searchButton, true, "正在查找");
      try {
        const response = await api(`/orders/by-merchant-no/${encodeURIComponent(merchantNo)}`);
        if (requestVersion !== searchVersion || searchInput.value.trim() !== merchantNo) return;
        const order = response.data.order || response.data;
        selected.orderId = order.order_id;
        selected.merchantOrderNo = merchantNo;
        selectedRegion.textContent = `已选择 ${order.merchant_order_no}，应付 ${formatMoney(order.payable_amount_cents, order.currency)}`;
      } catch (error) {
        if (requestVersion !== searchVersion) return;
        selected.orderId = null;
        selected.merchantOrderNo = null;
        selectedRegion.textContent = errorMessage(error);
      } finally {
        if (requestVersion === searchVersion) setBusy(searchButton, false, "查找订单");
      }
    });
    const reason = textarea("处理理由", "decision-reason", true);
    const form = el("form", { class: "uzu-form", novalidate: true }, [
      el("div", { class: "uzu-alert uzu-alert-warning", role: "status" }, [
        el("strong", { text: isRefund ? "登记退款流水" : "建立人工付款关联" }),
        document.createTextNode(isRefund ? "。退款只更新退款状态，不会撤销原付款事实。" : "。此操作会确认订单并发送付款成功通知。"),
      ]),
      field("商户订单号", searchInput, "使用精确订单号查找，不需要输入内部 UUID。"),
      div("uzu-flex uzu-wrap uzu-gap-2 perpay-action-bar", [searchButton]),
      selectedRegion,
      field("流水 ID", input({ value: exception.ledger_entry_id || "", readOnly: true, className: "perpay-code" })),
      reason,
      el("p", { class: "perpay-operation-key", text: `操作编号 ${operationId}` }),
      div("uzu-dialog-actions", [
        button("取消", () => closeActionDialog()),
        button(isRefund ? "登记退款" : "确认人工认领", null, isRefund ? "danger" : "primary", "submit"),
      ]),
    ]);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      if (!selected.orderId || selected.merchantOrderNo !== searchInput.value.trim()) {
        selected.orderId = null;
        selected.merchantOrderNo = null;
        selectedRegion.textContent = "请先按商户订单号选择订单。";
        searchInput.focus();
        return;
      }
      if (!exception.ledger_entry_id) return;
      const submit = form.querySelector("button[type=submit]");
      setBusy(submit, true, "正在提交");
      const body = {
        financial_operation_id: operationId,
        order_id: selected.orderId,
        ledger_entry_id: exception.ledger_entry_id,
        reason: valueOf("#decision-reason").trim(),
      };
      try {
        await protectedRequest(isRefund ? "/reconciliation/refunds" : "/reconciliation/settlements/manual", body);
        toast(isRefund ? "退款流水已登记" : "订单已人工认领", "success");
        closeActionDialog();
        location.reload();
      } catch (error) {
        toast(errorMessage(error), "danger");
        setBusy(submit, false, isRefund ? "登记退款" : "确认人工认领");
      }
    });
    openActionDialog(isRefund ? "登记退款" : "人工认领异常", ledger ? `${formatMoney(ledger.amount_cents, ledger.currency)} · ${formatTime(ledger.occurred_at)}` : "选择正确订单并记录理由。", form);
  }

  function openReverseSettlement(match) {
    const operationId = crypto.randomUUID();
    const reason = textarea("撤销理由", "reverse-reason", true);
    const form = el("form", { class: "uzu-form", novalidate: true }, [
      el("div", { class: "uzu-alert uzu-alert-danger", role: "alert", text: "撤销后订单进入争议状态，并向已配置的回调地址发送争议通知。" }),
      reason,
      el("p", { class: "perpay-operation-key", text: `操作编号 ${operationId}` }),
      div("uzu-dialog-actions", [button("取消", closeActionDialog), button("撤销关联", null, "danger", "submit")]),
    ]);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      const submit = form.querySelector("button[type=submit]");
      setBusy(submit, true, "正在撤销");
      const body = { financial_operation_id: operationId, reason: valueOf("#reverse-reason").trim() };
      try {
        await protectedRequest(`/reconciliation/matches/${encodeURIComponent(match.payment_match_id)}/actions/reverse`, body);
        toast("关联已撤销，订单已进入争议状态", "success");
        closeActionDialog();
        location.reload();
      } catch (error) {
        toast(errorMessage(error), "danger");
        setBusy(submit, false, "撤销关联");
      }
    });
    openActionDialog("撤销付款关联", `订单 ${match.order?.merchant_order_no || short(match.order_id)}`, form);
  }

  function openConflictResolution(conflict) {
    const operationId = crypto.randomUUID();
    const action = conflictResolutionAction(conflict.conflict_type);
    if (!action) {
      toast("此类原始页变体不能由管理员手工处置。", "danger");
      return;
    }
    const reason = textarea("处理理由", "conflict-reason", true);
    const form = el("form", { class: "uzu-form", novalidate: true }, [
      el("div", { class: "uzu-alert uzu-alert-warning", role: "status", text: action === "KEEP_EXISTING"
        ? "将保留已经入账的流水事实，并关闭重复外部流水号冲突。"
        : "将确认该记录保持隔离，不把无效证据写入账本。" }),
      reason,
      el("p", { class: "perpay-operation-key", text: `操作编号 ${operationId}` }),
      div("uzu-dialog-actions", [button("取消", closeActionDialog), button("提交处理", null, "primary", "submit")]),
    ]);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      const submit = form.querySelector("button[type=submit]");
      setBusy(submit, true, "正在提交");
      const body = {
        conflict_operation_id: operationId,
        action,
        reason: valueOf("#conflict-reason").trim(),
      };
      try {
        await protectedRequest(`/ledger/conflicts/${encodeURIComponent(conflict.conflict_id)}/actions/resolve`, body);
        toast("账务冲突已处理", "success");
        closeActionDialog();
        location.reload();
      } catch (error) {
        toast(errorMessage(error), "danger");
        setBusy(submit, false, "提交处理");
      }
    });
    openActionDialog("处理账务冲突", statusText(conflict.conflict_type), form);
  }

  function openRedelivery(delivery) {
    const operationId = crypto.randomUUID();
    const reason = textarea("补发理由", "redelivery-reason", true);
    const form = el("form", { class: "uzu-form", novalidate: true }, [
      el("div", { class: "uzu-alert uzu-alert-warning", role: "status", text: "补发会创建新的投递代次；接收端仍应按 event_id 幂等处理。" }),
      reason,
      el("p", { class: "perpay-operation-key", text: `补发编号 ${operationId}` }),
      div("uzu-dialog-actions", [button("取消", closeActionDialog), button("创建补发", null, "primary", "submit")]),
    ]);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      const submit = form.querySelector("button[type=submit]");
      setBusy(submit, true, "正在创建");
      const body = { redelivery_id: operationId, reason: valueOf("#redelivery-reason").trim() };
      try {
        const response = await protectedRequest(`/webhooks/deliveries/${encodeURIComponent(delivery.delivery_id)}/actions/redeliver`, body);
        toast(response.data.replayed ? "已恢复既有补发请求" : "补发任务已创建", "success");
        closeActionDialog();
        location.href = `/admin/notifications?id=${encodeURIComponent(response.data.delivery.delivery_id)}`;
      } catch (error) {
        toast(errorMessage(error), "danger");
        setBusy(submit, false, "创建补发");
      }
    });
    openActionDialog("重新投递通知", `原投递 ${short(delivery.delivery_id)}`, form);
  }

  async function protectedRequest(path, body, method = "POST") {
    try {
      return await api(path, { method, body });
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== "step_up_required") throw error;
      await requireStepUp();
      return api(path, { method, body });
    }
  }

  function requireStepUp() {
    if (state.stepUpPromise) return state.stepUpPromise.promise;
    let resolvePromise;
    let rejectPromise;
    const promise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    state.stepUpPromise = {
      promise,
      resolve: resolvePromise,
      reject: rejectPromise,
      cancelled: false,
      controller: null,
    };
    const error = document.querySelector("#step-up-error");
    if (error) error.hidden = true;
    const password = document.querySelector("#step-up-password");
    if (password instanceof HTMLInputElement) password.value = "";
    setBusy(document.querySelector("#step-up-submit"), false, "验证");
    openDialog("#step-up-dialog");
    setTimeout(() => password?.focus(), 0);
    return promise;
  }

  async function submitStepUp(event) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!(form instanceof HTMLFormElement) || !form.reportValidity()) return;
    const pending = state.stepUpPromise;
    if (!pending || pending.cancelled || pending.controller) return;
    const controller = new AbortController();
    pending.controller = controller;
    const submit = document.querySelector("#step-up-submit");
    setBusy(submit, true, "正在验证");
    const errorRegion = document.querySelector("#step-up-error");
    try {
      const response = await api("/session/step-up", {
        method: "POST",
        body: { password: valueOf("#step-up-password") },
        signal: controller.signal,
      });
      const dialog = document.querySelector("#step-up-dialog");
      if (
        state.stepUpPromise !== pending ||
        pending.cancelled ||
        controller.signal.aborted ||
        !isOpenDialog(dialog)
      ) return;
      state.csrfToken = response.data.csrf_token;
      if (state.session) state.session.step_up_active = true;
      state.stepUpPromise = null;
      pending.controller = null;
      closeDialog("#step-up-dialog");
      pending.resolve();
    } catch (error) {
      if (
        controller.signal.aborted ||
        pending.cancelled ||
        state.stepUpPromise !== pending ||
        error?.name === "AbortError"
      ) return;
      if (errorRegion) {
        errorRegion.textContent = errorMessage(error);
        errorRegion.hidden = false;
      }
    } finally {
      if (pending.controller === controller) pending.controller = null;
      if (state.stepUpPromise === pending || state.stepUpPromise === null) {
        setBusy(submit, false, "验证");
      }
    }
  }

  function cancelStepUp() {
    const pending = state.stepUpPromise;
    if (!pending) return;
    pending.cancelled = true;
    pending.controller?.abort();
    state.stepUpPromise = null;
    pending.reject(new Error("已取消身份验证"));
  }

  function isOpenDialog(dialog) {
    return dialog instanceof HTMLElement && !dialog.hidden && dialog.classList.contains("is-open");
  }

  async function api(path, options = {}) {
    const method = options.method || "GET";
    const headers = new Headers({ Accept: "application/json" });
    const init = { method, headers, credentials: "same-origin" };
    if (options.signal) init.signal = options.signal;
    if (options.body !== undefined) {
      headers.set("content-type", "application/json");
      init.body = JSON.stringify(options.body);
    }
    if (method !== "GET" && method !== "HEAD") {
      state.csrfToken = readCsrfCookie();
      if (state.csrfToken) headers.set("x-csrf-token", state.csrfToken);
    }
    const response = await fetch(`${API_ROOT}${path}`, init);
    const contentType = response.headers.get("content-type") || "";
    let body = null;
    if (contentType.includes("application/json")) {
      try { body = await response.json(); } catch { body = null; }
    }
    if (!response.ok) {
      const error = new ApiError(response.status, body, response.headers.get("retry-after"));
      if (response.status === 401 && options.redirectOnUnauthorized !== false) {
        const returnTo = encodeURIComponent(`${location.pathname}${location.search}`);
        location.replace(`/admin/login?return_to=${returnTo}`);
      }
      throw error;
    }
    return body;
  }

  function renderMain(...children) {
    const main = document.querySelector("#admin-main");
    if (!main) return;
    main.replaceChildren(...children.filter(Boolean));
    main.focus({ preventScroll: true });
  }

  function renderRouteError(error, retry) {
    updateGlobalStatus("error");
    renderMain(
      pageHeader("无法读取页面", "服务器返回了错误，现有资金状态不会由浏览器推断。"),
      div("uzu-error-state", [
        el("h2", { text: errorMessage(error) }),
        error instanceof ApiError && error.requestId ? el("p", { class: "perpay-code", text: `请求编号 ${error.requestId}` }) : null,
        button("重试", retry, "primary"),
      ].filter(Boolean)),
    );
  }

  function renderNotFound() {
    setDocumentTitle("页面不存在");
    renderMain(
      div("uzu-error-page uzu-error-page-screen", [
        el("p", { class: "uzu-error-page-code", text: "404" }),
        el("h1", { text: "管理页面不存在" }),
        el("p", { text: "该地址不属于当前管理后台。" }),
        div("uzu-error-page-actions", [linkButton("返回系统状态", "/admin", "primary")]),
      ]),
    );
  }

  function pageHeader(title, description, actions = []) {
    return el("header", { class: "perpay-page-head" }, [
      div("uzu-title-pair", [el("h1", { text: title }), el("p", { text: description })]),
      actions.length ? div("uzu-flex uzu-wrap uzu-gap-2 perpay-action-bar", actions) : null,
    ].filter(Boolean));
  }

  function section(title, content) {
    return el("section", { class: "perpay-section" }, [
      el("header", { class: "perpay-section-head" }, el("h2", { text: title })),
      content,
    ]);
  }

  function detailBlock(title, content) {
    return el("section", { class: "uzu-card perpay-detail-block" }, [el("h2", { text: title }), content]);
  }

  function healthStrip(cells) {
    return div("perpay-health-strip", cells);
  }

  function healthCell(label, value, tone, note) {
    return div("perpay-health-cell", [
      el("span", { class: "perpay-health-label" }, [el("span", { class: "perpay-status-dot", "data-tone": tone }), document.createTextNode(label)]),
      el("strong", { text: value }),
      el("small", { text: note || "-" }),
    ]);
  }

  function metricGrid(items) {
    return el("dl", { class: "uzu-grid uzu-grid-auto perpay-metric-grid" }, items.map(([label, value]) =>
      el("div", { class: "uzu-stat" }, [
        el("dt", { class: "uzu-stat-label", text: label }),
        el("dd", { class: "uzu-stat-value", text: String(value) }),
      ]),
    ));
  }

  function facts(items) {
    const list = el("dl", { class: "perpay-facts" });
    for (const [label, value, kind] of items) {
      list.append(el("dt", { text: label }));
      const dd = el("dd");
      if (value instanceof Node) dd.append(value);
      else {
        dd.textContent = value === null || value === undefined || value === "" ? "-" : String(value);
        if (kind === "code") dd.classList.add("uzu-mono", "uzu-break-anywhere", "perpay-code");
      }
      list.append(dd);
    }
    return list;
  }

  function tableRegion(label, columns, rows) {
    const table = el("table", { class: "uzu-table perpay-table" });
    table.append(el("caption", { class: "uzu-sr-only", text: label }));
    const head = el("thead");
    head.append(el("tr", {}, columns.map(([name]) => el("th", { scope: "col", text: name }))));
    const body = el("tbody");
    for (const row of rows) {
      const tr = el("tr");
      columns.forEach(([, render], index) => {
        const cell = el(index === 0 ? "th" : "td", index === 0 ? { scope: "row" } : {});
        appendValue(cell, render(row));
        tr.append(cell);
      });
      body.append(tr);
    }
    table.append(head, body);
    return el("div", { class: "uzu-table-wrap uzu-scroll perpay-data-region" }, table);
  }

  function filterBar(children) {
    return div("uzu-flex uzu-wrap uzu-gap-3 perpay-filter-bar", children);
  }

  function orderSearchForm(value) {
    const search = input({ id: "order-search", name: "merchant_order_no", value, placeholder: "例如 ORDER-20260818-001", required: true });
    const form = el("form", { class: "uzu-flex uzu-wrap uzu-gap-3 perpay-filter-bar", action: "/admin/orders", method: "get" }, [
      field("精确商户订单号", search),
      button("查找", null, "primary", "submit"),
      value ? linkButton("返回列表", "/admin/orders") : null,
    ].filter(Boolean));
    return form;
  }

  function selectField(label, name, selected, values, formatter) {
    const control = select(values, selected, formatter);
    control.name = name;
    control.id = `filter-${name}`;
    return field(label, control);
  }

  function selectedProviderGeneration(query, generations) {
    const requested = query.get("provider_account_key");
    if (requested) return requested;
    return generations.find((generation) => generation.active)?.provider_account_key ||
      generations[0]?.provider_account_key || "";
  }

  function providerGenerationLabel(providerAccountKey, generations) {
    const generation = generations.find(
      (candidate) => candidate.provider_account_key === providerAccountKey,
    );
    if (!generation) return providerAccountKey;
    const environment = generation.environment === "SANDBOX" ? "沙箱" : "生产";
    return `${generation.app_id} · ${environment}${generation.active ? " · 当前" : " · 已归档"}`;
  }

  function providerGenerationFilter(generations, selected, names) {
    if (generations.length === 0) return null;
    return filterBar([
      selectField(
        "采集应用",
        "provider_account_key",
        selected,
        generations.map((generation) => generation.provider_account_key),
        (value) => providerGenerationLabel(value, generations),
      ),
      button("应用筛选", () => applyFilters(names, true), "primary"),
    ]);
  }

  function providerGenerationHistory(generations) {
    if (generations.length === 0) return null;
    return section("采集应用历史", tableRegion("采集应用代际", [
      ["应用 ID", (row) => code(row.app_id)],
      ["环境", (row) => row.environment === "SANDBOX" ? "沙箱" : "生产"],
      ["状态", (row) => stateLabel(row.active ? "当前" : "已归档", row.active ? "success" : "neutral")],
      ["激活时间", (row) => formatTime(row.activated_at)],
      ["异常", (row) => el("a", {
        class: "uzu-text-link",
        href: `/admin/exceptions?provider_account_key=${encodeURIComponent(row.provider_account_key)}`,
        text: "查看",
      })],
      ["冲突", (row) => el("a", {
        class: "uzu-text-link",
        href: `/admin/ledger-conflicts?provider_account_key=${encodeURIComponent(row.provider_account_key)}`,
        text: "查看",
      })],
    ], generations));
  }

  function applyFilters(names, preserveAll = false) {
    const url = new URL(location.href);
    url.search = "";
    for (const name of names) {
      const control = document.querySelector(`#filter-${CSS.escape(name)}`);
      if (control instanceof HTMLSelectElement && (preserveAll || control.value !== "ALL")) {
        url.searchParams.set(name, control.value);
      }
    }
    location.assign(url);
  }

  function readEnumQuery(source, name, values, fallback) {
    const value = source.get(name);
    return value !== null && values.includes(value) ? value : fallback;
  }

  function cursorNavigation(nextCursor) {
    const current = new URL(location.href);
    const hasCursor = current.searchParams.has("cursor");
    if (!nextCursor && !hasCursor) return null;
    const row = div("uzu-pagination perpay-pagination-row");
    if (hasCursor) {
      const first = new URL(current);
      first.searchParams.delete("cursor");
      const storedParent = readCursorParents()[relativeUrl(current)];
      const knownParent = isAdminRelativeUrl(storedParent) ? storedParent : null;
      row.append(linkButton(knownParent ? "上一页" : "返回第一页", knownParent || relativeUrl(first)));
    }
    if (nextCursor) {
      const url = new URL(current);
      url.searchParams.set("cursor", nextCursor);
      const next = linkButton("下一页", relativeUrl(url));
      next.addEventListener("click", () => rememberCursorParent(relativeUrl(url), relativeUrl(current)));
      row.append(next);
    }
    return row;
  }

  function relativeUrl(url) {
    return `${url.pathname}${url.search}`;
  }

  function isAdminRelativeUrl(value) {
    return typeof value === "string" && value.startsWith("/admin") && !value.startsWith("//");
  }

  function readCursorParents() {
    try {
      const value = JSON.parse(sessionStorage.getItem(CURSOR_PARENT_STORAGE_KEY) || "{}");
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch {
      return {};
    }
  }

  function rememberCursorParent(child, parent) {
    const parents = readCursorParents();
    delete parents[child];
    parents[child] = parent;
    const entries = Object.entries(parents).slice(-100);
    try {
      sessionStorage.setItem(CURSOR_PARENT_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
    } catch {
      // Pagination remains usable through the deterministic first-page fallback.
    }
  }

  function emptyState(title, message, compact = false) {
    return div(compact ? "uzu-title-pair" : "uzu-empty-state", [el("h2", { text: title }), el("p", { text: message })]);
  }

  function unavailableState(title, error) {
    return el("div", { class: "uzu-error-state", role: "alert" }, [
      el("h2", { text: title }),
      el("p", { text: errorMessage(error) }),
      button("重试", () => location.reload(), "primary"),
    ]);
  }

  function isManualLedgerEligible(ledger) {
    return ledger?.direction === "CREDIT" && ["UNALLOCATED", "CANDIDATE", "CONFLICT"].includes(ledger.state);
  }

  function isRefundLedgerEligible(ledger) {
    return ledger?.direction === "DEBIT" && ["UNALLOCATED", "CONFLICT"].includes(ledger.state);
  }

  function conflictResolutionAction(conflictType) {
    if (conflictType === "DUPLICATE_EXTERNAL_ID") return "KEEP_EXISTING";
    if (["MISSING_EXTERNAL_ID", "INVALID_AMOUNT", "INVALID_TIMESTAMP", "INVALID_DIRECTION", "INVALID_SHAPE"].includes(conflictType)) {
      return "ACKNOWLEDGE_ISOLATED";
    }
    return null;
  }

  function jsonBlock(value) {
    return el("pre", { class: "uzu-code-block-body perpay-json", text: safeJson(value) });
  }

  function jsonDisclosure(value) {
    const details = el("details");
    details.append(el("summary", { text: "查看" }), jsonBlock(value));
    return details;
  }

  function processStep(text, complete, active = false) {
    const tone = typeof active === "string" ? active : null;
    const item = el("li", { class: `uzu-process-step${complete ? " is-complete" : ""}${active === true ? " is-active" : ""}`, text });
    if (tone) item.dataset.tone = tone;
    return item;
  }

  function stateLabel(value, tone) {
    const classes = ["uzu-badge"];
    if (["success", "warning", "danger"].includes(tone)) classes.push(`uzu-badge-${tone}`);
    return el("span", { class: classes.join(" "), text: statusText(value) });
  }

  function money(cents, currency) {
    return el("span", { class: "perpay-money", text: formatMoney(cents, currency) });
  }

  function code(value) {
    return el("span", { class: "uzu-mono uzu-break-anywhere perpay-code", text: value === null || value === undefined ? "-" : String(value) });
  }

  function shortCode(value) {
    return code(value ? short(value) : "-");
  }

  function orderLink(orderId) {
    if (!orderId) return "-";
    return el("a", { class: "uzu-text-link uzu-mono uzu-break-anywhere perpay-code", href: `/admin/orders?id=${encodeURIComponent(orderId)}`, text: short(orderId) });
  }

  function detailLink(route, id, text, className) {
    return el("a", { class: `uzu-text-link${className ? ` ${className}` : ""}`, href: `/admin/${route}?id=${encodeURIComponent(id)}`, text });
  }

  function button(label, handler, tone, type = "button") {
    const classes = ["uzu-button"];
    if (tone === "primary") classes.push("uzu-button-primary");
    if (tone === "danger") classes.push("uzu-button-danger");
    const control = el("button", { class: classes.join(" "), type, text: label });
    if (handler) control.addEventListener("click", handler);
    return control;
  }

  function linkButton(label, href, tone) {
    const classes = ["uzu-button"];
    if (tone === "primary") classes.push("uzu-button-primary");
    return el("a", { class: classes.join(" "), href, text: label });
  }

  function field(label, control, help) {
    const children = [el("span", { class: "uzu-label", text: label }), control];
    if (help) children.push(el("span", { class: "uzu-help", text: help }));
    return el("label", { class: "uzu-field" }, children);
  }

  function passwordField(label, id, autocomplete, minLength) {
    const control = input({ id, type: "password", autocomplete, required: true, minLength });
    control.classList.add("uzu-password-input");
    const wrapper = el("span", { class: "uzu-password", "data-uzu-password": "" }, [
      control,
      el("button", { class: "uzu-icon-button uzu-password-toggle", type: "button", "data-uzu-password-toggle": "", "aria-label": "显示密码" }),
    ]);
    return field(label, wrapper);
  }

  function textarea(label, id, required) {
    const control = el("textarea", { class: "uzu-textarea", id, rows: "4", maxlength: "500" });
    control.required = required;
    return field(label, control, "请记录可审计的业务理由。最多 500 个字符。");
  }

  function input(options = {}) {
    const control = el("input", { class: `uzu-input${options.className ? ` ${options.className}` : ""}` });
    for (const [key, value] of Object.entries(options)) {
      if (key === "className" || value === undefined) continue;
      if (key === "readOnly") control.readOnly = Boolean(value);
      else if (key === "required") control.required = Boolean(value);
      else if (key === "minLength") control.minLength = Number(value);
      else control[key] = value;
    }
    return control;
  }

  function select(values, selected, formatter) {
    const control = el("select", { class: "uzu-input" });
    for (const value of values) {
      const option = el("option", { value, text: formatter(value) });
      option.selected = value === selected;
      control.append(option);
    }
    return control;
  }

  function div(className, children = []) {
    return el("div", { class: className }, children);
  }

  function el(tag, attributes = {}, children = []) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) {
      if (value === null || value === undefined || value === false) continue;
      if (name === "class") node.className = value;
      else if (name === "text") node.textContent = String(value);
      else if (name === "hidden") node.hidden = Boolean(value);
      else if (name in node && !name.includes("-")) {
        try { node[name] = value; } catch { node.setAttribute(name, String(value)); }
      } else node.setAttribute(name, value === true ? "" : String(value));
    }
    const values = Array.isArray(children) ? children : [children];
    for (const child of values.flat(Infinity)) appendValue(node, child);
    return node;
  }

  function appendValue(parent, value) {
    if (value === null || value === undefined || value === false) return;
    parent.append(value instanceof Node ? value : document.createTextNode(String(value)));
  }

  function openActionDialog(title, description, content) {
    const titleNode = document.querySelector("#action-title");
    const descriptionNode = document.querySelector("#action-description");
    const contentNode = document.querySelector("#action-content");
    if (titleNode) titleNode.textContent = title;
    if (descriptionNode) descriptionNode.textContent = description;
    contentNode?.replaceChildren(content);
    openDialog("#action-dialog");
  }

  function closeActionDialog() {
    closeDialog("#action-dialog");
  }

  function openDialog(selector) {
    const dialog = document.querySelector(selector);
    if (!(dialog instanceof HTMLElement)) return;
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const parentDialog = active?.closest("[data-uzu-dialog]");
    const trigger = parentDialog instanceof HTMLElement
      ? state.dialogTriggers.get(parentDialog) || active
      : active;
    if (trigger) state.dialogTriggers.set(dialog, trigger);
    if (window.Usuzumi?.openDialog) window.Usuzumi.openDialog(dialog, trigger);
    else {
      const overlay = dialog.closest("[data-uzu-dialog-overlay]");
      if (overlay instanceof HTMLElement) overlay.hidden = false;
      dialog.focus();
    }
  }

  function closeDialog(selector) {
    const dialog = document.querySelector(selector);
    if (!(dialog instanceof HTMLElement)) return;
    if (window.Usuzumi?.closeDialog) window.Usuzumi.closeDialog(dialog);
    else {
      const overlay = dialog.closest("[data-uzu-dialog-overlay]");
      if (overlay instanceof HTMLElement) overlay.hidden = true;
      const trigger = state.dialogTriggers.get(dialog);
      if (trigger?.isConnected) trigger.focus();
    }
  }

  function confirmAction(title, message, confirmLabel) {
    return new Promise((resolve) => {
      const dialog = document.querySelector("#action-dialog");
      let settled = false;
      const settle = (confirmed) => {
        if (settled) return;
        settled = true;
        dialog?.removeEventListener("uzu-dialog-close", handleClose);
        resolve(confirmed);
      };
      const handleClose = (event) => {
        if (event.target === dialog) settle(false);
      };
      dialog?.addEventListener("uzu-dialog-close", handleClose);
      const cancel = button("取消", () => { settle(false); closeActionDialog(); });
      const confirm = button(confirmLabel, () => { settle(true); closeActionDialog(); }, "danger");
      const content = div("uzu-stack", [
        el("div", { class: "uzu-alert uzu-alert-danger", role: "alert", text: message }),
        div("uzu-dialog-actions", [cancel, confirm]),
      ]);
      openActionDialog(title, "请确认影响范围。", content);
    });
  }

  function toast(message, tone = "info") {
    const stack = document.querySelector("#toast-stack");
    if (!stack) return;
    const item = el("article", { class: "uzu-toast", role: tone === "danger" ? "alert" : "status" }, [
      el("span", { class: "uzu-toast-content", text: message }),
      el("button", { class: "uzu-icon-button", type: "button", "data-uzu-toast-close": "", "aria-label": "关闭通知" }),
    ]);
    if (tone === "danger") item.classList.add("is-danger");
    stack.append(item);
    setTimeout(() => item.remove(), 6000);
  }

  function setBusy(control, busy, label) {
    if (!(control instanceof HTMLElement)) return;
    control.toggleAttribute("disabled", busy);
    control.setAttribute("aria-busy", String(busy));
    control.classList.toggle("is-loading", busy);
    if (label) control.textContent = label;
  }

  function showLoginError(message) {
    const region = document.querySelector("#login-error");
    if (!region) return;
    region.textContent = message;
    region.hidden = !message;
  }

  function showSetupError(message) {
    const region = document.querySelector("#setup-error");
    if (!region) return;
    region.textContent = message;
    region.hidden = !message;
  }

  function renderSessionSummary(session) {
    const username = document.querySelector("#session-username");
    const expiry = document.querySelector("#session-expiry");
    if (username) username.textContent = session.username;
    if (expiry) expiry.textContent = `空闲到期 ${formatTime(session.idle_expires_at)}`;
  }

  function updateGlobalStatus(status) {
    const region = document.querySelector("#global-status");
    if (!region) return;
    region.dataset.state = status;
    const text = region.lastElementChild;
    if (text) text.textContent = statusText(status);
  }

  async function refreshGlobalStatus() {
    try {
      const response = await api("/system/status");
      updateGlobalStatus(response.data.status);
      updateNavigationCounts(response.data);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) updateGlobalStatus("error");
    }
  }

  function updateNavigationCounts(data) {
    updateCount("#nav-exception-count", data.reconciliation?.exceptions?.open);
    updateCount("#nav-conflict-count", data.ledger?.conflicts?.open);
  }

  function updateCount(selector, value) {
    const badge = document.querySelector(selector);
    if (!badge) return;
    const count = Number(value || 0);
    badge.textContent = String(count);
    badge.hidden = count < 1;
  }

  function markCurrentNavigation() {
    const segment = location.pathname.split("/").filter(Boolean)[1] || "overview";
    document.querySelectorAll("[data-admin-nav]").forEach((link) => {
      const active = link.dataset.adminNav === segment;
      link.classList.toggle("is-current", active);
      if (active) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });
  }

  function setDocumentTitle(title) {
    document.title = `${title} - PerPay`;
  }

  function readCsrfCookie() {
    for (const name of ["__Host-perpay_csrf", "perpay_csrf"]) {
      const prefix = `${name}=`;
      const part = document.cookie.split(";").map((value) => value.trim()).find((value) => value.startsWith(prefix));
      if (part) return decodeURIComponent(part.slice(prefix.length));
    }
    return null;
  }

  function valueOf(selector) {
    const control = document.querySelector(selector);
    return control instanceof HTMLInputElement ||
      control instanceof HTMLTextAreaElement ||
      control instanceof HTMLSelectElement
      ? control.value
      : "";
  }

  function pickQuery(source, allowed) {
    const result = new URLSearchParams();
    for (const name of allowed) {
      const value = source.get(name);
      if (value) result.set(name, value);
    }
    return result;
  }

  function short(value) {
    const text = String(value || "");
    return text.length > 13 ? `${text.slice(0, 8)}...${text.slice(-4)}` : text;
  }

  function formatMoney(cents, currency = "CNY") {
    if (!Number.isSafeInteger(cents)) return "-";
    return new Intl.NumberFormat("zh-CN", { style: "currency", currency: currency || "CNY", minimumFractionDigits: 2 }).format(cents / 100);
  }

  function formatTime(value) {
    if (value === null || value === undefined || value === "") return "-";
    const date = typeof value === "number" ? new Date(value) : new Date(String(value));
    if (Number.isNaN(date.getTime())) return "-";
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(date).replaceAll("/", "-");
  }

  function formatDuration(milliseconds) {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return "尚未成功";
    if (milliseconds < 1000) return "刚刚";
    if (milliseconds < 60000) return `${Math.floor(milliseconds / 1000)} 秒前`;
    if (milliseconds < 3600000) return `${Math.floor(milliseconds / 60000)} 分钟前`;
    return `${Math.floor(milliseconds / 3600000)} 小时前`;
  }

  function freshnessText(value) {
    const age = formatDuration(value.last_success_age_milliseconds);
    const maximum = formatDuration(value.maximum_success_age_milliseconds);
    return `${age} · 允许窗口 ${maximum.replace("前", "")}`;
  }

  function formatBoolean(value) {
    if (value === null || value === undefined) return "未知";
    return value ? "是" : "否";
  }

  function healthLabel(health) {
    if (!health.enabled) return "未启用";
    if (health.state === "idle" && !health.last_error_code) return "正常";
    return statusText(health.state);
  }

  function webhookTone(health) {
    if (!health.enabled || health.dead_letters > 0 || health.state === "stopped") return "danger";
    if (health.last_error_code || health.consecutive_failures > 0) return "warning";
    return "success";
  }

  function toneForState(value) {
    const text = String(value || "").toUpperCase();
    if (["READY", "HEALTHY", "CONFIRMED", "SETTLED", "SELECTED", "ALLOCATED", "ACKNOWLEDGED", "RESOLVED", "FULL", "CREDIT", "COMPLETED"].includes(text)) return "success";
    if (["DISPUTED", "REVERSED", "DEAD_LETTER", "FAILED", "STOPPED", "DANGER", "PERMANENT_FAILURE", "OUTCOME_UNKNOWN"].includes(text)) return "danger";
    if (["OPEN", "UNPAID", "ELIGIBLE", "PENDING", "LEASED", "RETRY_WAIT", "PARTIAL", "DEGRADED", "CATCHING_UP", "RETRYABLE_FAILURE"].includes(text)) return "warning";
    return "neutral";
  }

  const STATUS_LABELS = {
    ALL: "全部",
    OPEN: "开放",
    CLOSED: "已关闭",
    EXPIRED: "已过期",
    UNPAID: "未付款",
    CONFIRMED: "已确认",
    DISPUTED: "争议中",
    NONE: "无",
    PARTIAL: "部分退款",
    FULL: "全额退款",
    INFERRED: "唯一金额推断",
    MANUAL: "管理员认领",
    ELIGIBLE: "可匹配",
    SELECTED: "已选中",
    SUPERSEDED: "已失效",
    SETTLED: "有效",
    REVERSED: "已撤销",
    RESOLVED: "已解决",
    IGNORED: "已隔离",
    PENDING: "待投递",
    LEASED: "投递中",
    RETRY_WAIT: "等待重试",
    ACKNOWLEDGED: "已确认送达",
    DEAD_LETTER: "死信",
    CREDIT: "入账",
    DEBIT: "出账",
    ALLOCATED: "已分配",
    CANDIDATE: "待匹配",
    ISOLATED: "已隔离",
    ready: "收款就绪",
    degraded: "降级运行",
    not_ready: "收款暂停",
    error: "连接失败",
    CONFIRM_VARIANT: "确认响应变体",
    KEEP_EXISTING: "保留既有事实",
    ACKNOWLEDGE_ISOLATED: "确认隔离",
    AMOUNT_INFERRED: "唯一金额推断",
    STARTED: "已开始",
    RETRYABLE_FAILURE: "可重试失败",
    PERMANENT_FAILURE: "永久失败",
    OUTCOME_UNKNOWN: "结果未知",
  };

  function statusText(value) {
    if (value === null || value === undefined || value === "") return "-";
    return STATUS_LABELS[value] || String(value).replaceAll("_", " ");
  }

  function evidenceText(value) {
    if (value === "INFERRED" || value === "AMOUNT_INFERRED") return "唯一金额推断";
    if (value === "MANUAL" || value === "MANUAL_ASSIGNMENT") return "管理员认领";
    if (value === "NONE" || !value) return "无";
    return statusText(value);
  }

  function safeJson(value) {
    try {
      const text = JSON.stringify(value, null, 2);
      return text.length > 131072 ? `${text.slice(0, 131072)}\n...内容已截断` : text;
    } catch {
      return "无法显示该数据";
    }
  }

  function errorMessage(error) {
    if (error instanceof ApiError) {
      if (error.status === 429 && error.retryAfter) return `${error.message}，请在 ${error.retryAfter} 秒后重试。`;
      return error.message;
    }
    if (error instanceof TypeError) return "网络连接失败，请检查服务器状态后重试。";
    return error instanceof Error ? error.message : "发生未知错误";
  }
})();
