(function checkoutApplication() {
  "use strict";

  const root = document.querySelector("[data-checkout-root]");
  if (!(root instanceof HTMLElement)) return;

  const apiUrl = sameOriginUrl(root.dataset.checkoutApiUrl ?? "");
  const qrUrl = root.dataset.checkoutQrUrl
    ? sameOriginUrl(root.dataset.checkoutQrUrl)
    : null;
  const content = root.querySelector("[data-checkout-content]");
  const routeError = root.querySelector("[data-route-error]");
  const retryButton = root.querySelector("[data-checkout-retry]");
  const networkBanner = document.querySelector("[data-network-banner]");
  const qrPanel = root.querySelector("[data-qr-panel]");
  const qrImage = root.querySelector("[data-qr-image]");
  const qrError = root.querySelector("[data-qr-error]");
  const qrActions = root.querySelector(".checkout-code-actions");
  const qrDownload = root.querySelector("[data-qr-download]");
  const qrDialog = document.querySelector("[data-qr-dialog]");
  const qrDialogImage = qrDialog?.querySelector("[data-qr-dialog-image]");
  const countdown = root.querySelector("[data-countdown]");
  const countdownWrap = root.querySelector("[data-countdown-wrap]");
  const manualRefreshButton = root.querySelector("[data-checkout-refresh]");
  const manualRefreshLabel = manualRefreshButton?.querySelector("[data-checkout-refresh-label]");
  const requestTimeoutMilliseconds = 10_000;

  const stateCopy = Object.freeze({
    UNPAID: Object.freeze({
      badge: "等待付款",
      heading: "请支付以下准确金额",
      detail: "付款后请停留在本页，系统确认后会自动更新。请勿重复付款。",
      badgeClass: "",
    }),
    CONFIRMED: Object.freeze({
      badge: "付款已确认",
      heading: "付款已确认",
      detail: "订单已经完成确认，无需再次付款。",
      badgeClass: "is-success",
    }),
    DISPUTED: Object.freeze({
      badge: "付款有争议",
      heading: "付款关联需要处理",
      detail: "这笔付款的关联存在争议，请联系订单提供方处理，勿再次付款。",
      badgeClass: "is-danger",
    }),
    CLOSED: Object.freeze({
      badge: "订单已关闭",
      heading: "订单已关闭",
      detail: "此订单不再收款，请勿扫描或再次付款。",
      badgeClass: "is-warning",
    }),
    EXPIRED: Object.freeze({
      badge: "订单已过期",
      heading: "订单已过期",
      detail: "付款时间已经结束，请返回订单提供方重新创建订单。",
      badgeClass: "is-warning",
    }),
  });

  let timerId;
  let countdownTimerId;
  let activeController;
  let hasCheckoutData = content instanceof HTMLElement && !content.hidden;
  let lastVisualState = root.dataset.initialState ?? "UNPAID";
  let lastRefundStatus = root.dataset.refundStatus ?? "NONE";
  let retryFailures = 0;
  let retryAfterMilliseconds = parseRetryAfterSeconds(root.dataset.retryAfterSeconds) * 1000;
  let retryNotBefore = retryAfterMilliseconds > 0 ? Date.now() + retryAfterMilliseconds : 0;
  let refreshInFlight = false;
  let destroyed = false;

  wireQrControls();
  wireLifecycle();
  startCountdown();
  updateManualRefreshButton();

  if (apiUrl === null) {
    showRouteError("配置错误", "收银台状态地址无效，无法读取订单。", "CONFIG", false);
    return;
  }

  if (lastVisualState !== "NOT_FOUND") {
    scheduleNext(initialDelay());
  }

  function wireLifecycle() {
    retryButton?.addEventListener("click", () => {
      retryFailures = 0;
      retryAfterMilliseconds = 0;
      void refresh();
    });

    manualRefreshButton?.addEventListener("click", () => {
      if (refreshInFlight || Date.now() < retryNotBefore) return;
      void refresh(true);
    });

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        clearScheduledRefresh();
        activeController?.abort();
        stopCountdown();
        updateManualRefreshButton();
        return;
      }
      startCountdown();
      updateManualRefreshButton();
      if (navigator.onLine && initialDelay() !== null) void refresh();
    });

    window.addEventListener("offline", () => {
      clearScheduledRefresh();
      activeController?.abort();
      showNetworkMessage("网络已断开，恢复连接后会继续刷新订单状态。", true);
      updateManualRefreshButton();
    });

    window.addEventListener("online", () => {
      if (initialDelay() === null) return;
      showNetworkMessage("网络已恢复，正在刷新订单状态。", false);
      retryFailures = 0;
      updateManualRefreshButton();
      void refresh();
    });

    window.addEventListener("pagehide", () => {
      destroyed = true;
      clearScheduledRefresh();
      activeController?.abort();
      stopCountdown();
    });

    window.addEventListener("pageshow", (event) => {
      if (!event.persisted) return;
      destroyed = false;
      activeController = undefined;
      startCountdown();
      if (navigator.onLine && initialDelay() !== null) {
        retryFailures = 0;
        void refresh();
      }
    });
  }

  function wireQrControls() {
    const expand = root.querySelector("[data-qr-expand]");
    const close = qrDialog?.querySelector("[data-qr-dialog-close]");
    const reload = root.querySelector("[data-qr-reload]");

    expand?.addEventListener("click", () => {
      if (qrDialog instanceof HTMLDialogElement && !qrDialog.open) qrDialog.showModal();
    });
    close?.addEventListener("click", () => {
      if (qrDialog instanceof HTMLDialogElement) qrDialog.close();
    });
    qrDialog?.addEventListener("click", (event) => {
      if (event.target === qrDialog && qrDialog instanceof HTMLDialogElement) qrDialog.close();
    });

    if (qrImage instanceof HTMLImageElement) {
      qrImage.addEventListener("load", () => setQrLoadError(false));
      qrImage.addEventListener("error", () => setQrLoadError(true));
      if (qrImage.complete && qrImage.hasAttribute("src") && qrImage.naturalWidth === 0) {
        setQrLoadError(true);
      }
    }
    reload?.addEventListener("click", () => {
      if (!(qrImage instanceof HTMLImageElement)) return;
      const originalSource = resolveQrSource();
      const retryUrl = originalSource === null ? null : sameOriginUrl(originalSource);
      if (retryUrl === null) return;
      retryUrl.searchParams.set("retry", String(Date.now()));
      setQrLoadError(false);
      const retrySource = retryUrl.pathname + retryUrl.search;
      qrImage.src = retrySource;
      if (qrDialogImage instanceof HTMLImageElement) qrDialogImage.src = retrySource;
    });
  }

  async function refresh(manual = false) {
    if (refreshInFlight || destroyed || document.hidden || !navigator.onLine || apiUrl === null) return false;
    if (manual && Date.now() < retryNotBefore) {
      showUpdateMessage("请等待冷却时间结束后再检查。", "warning");
      updateManualRefreshButton();
      return false;
    }
    const previousState = lastVisualState;
    refreshInFlight = true;
    setManualRefreshBusy(manual);
    updateManualRefreshButton();
    clearScheduledRefresh();
    const controller = new AbortController();
    activeController = controller;
    let timedOut = false;
    const timeoutId = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, requestTimeoutMilliseconds);

    try {
      const response = await fetch(apiUrl, {
        method: "GET",
        headers: { accept: "application/json" },
        cache: "no-store",
        credentials: "same-origin",
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) {
        await handleHttpError(response);
        return false;
      }
      const payload = await response.json();
      const checkout = readCheckoutPayload(payload);
      applyCheckout(checkout);
      retryFailures = 0;
      retryAfterMilliseconds = 0;
      retryNotBefore = 0;
      hideNetworkMessage();
      scheduleNext(intervalForState(lastVisualState));
      if (manual && previousState === lastVisualState && hasCheckoutData) {
        showUpdateMessage("已检查，暂未确认付款。", "info");
      }
      return true;
    } catch (error) {
      if (controller.signal.aborted && (!timedOut || destroyed || document.hidden)) return false;
      retryFailures += 1;
      if (!hasCheckoutData) {
        showRouteError(
          timedOut ? "连接收银台超时" : "无法连接到收银台",
          timedOut
            ? "服务器未在预期时间内响应，请稍后重试。付款前请等待订单状态恢复。"
            : "请检查网络连接后重试。订单状态尚未读取成功。",
          timedOut ? "TIMEOUT" : "NETWORK",
          true,
        );
      } else {
        showNetworkMessage(
          timedOut
            ? "订单状态刷新超时，当前显示的是上次获取的结果。页面会自动重试。"
            : "订单状态暂时无法刷新，当前显示的是上次获取的结果。",
          true,
        );
      }
      scheduleNext(backoffMilliseconds());
      return false;
    } finally {
      window.clearTimeout(timeoutId);
      if (activeController === controller) activeController = undefined;
      refreshInFlight = false;
      setManualRefreshBusy(false);
      updateManualRefreshButton();
    }
  }

  async function handleHttpError(response) {
    const errorPayload = await readErrorPayload(response);
    if (response.status === 404) {
      lastVisualState = "NOT_FOUND";
      showRouteError(
        "找不到这个订单",
        "链接可能不完整、已经失效，或订单的查询期限已经结束。",
        errorPayload.code ?? "checkout_not_found",
        false,
      );
      return;
    }

    if (response.status === 429) {
      retryAfterMilliseconds = readRetryAfter(response.headers.get("retry-after"), 1_000);
      retryNotBefore = Date.now() + retryAfterMilliseconds;
      if (!hasCheckoutData) {
        showRouteError(
          "请求过于频繁",
          "页面会在稍后自动重新获取订单状态，也可以手动重试。",
          errorPayload.code ?? "public_checkout_rate_limited",
          true,
        );
      } else {
        showUpdateMessage("刷新过于频繁，页面会在稍后继续获取订单状态。", "warning");
      }
      scheduleNext(retryAfterMilliseconds);
      return;
    }

    if (response.status === 503) {
      retryFailures += 1;
      lastVisualState = "UNAVAILABLE";
      setStatus("UNAVAILABLE", {
        badge: "收款暂不可用",
        heading: "暂时无法确认付款",
        detail: "自动确认服务尚未就绪，请暂勿付款。页面会自动重试。",
        badgeClass: "is-warning",
      });
      const qrDialogWasOpen = deactivateQr();
      setHidden(qrPanel, true);
      setHidden(root.querySelector("[data-payment-guidance]"), true);
      setHidden(root.querySelector("[data-service-alert]"), false);
      if (!hasCheckoutData) {
        showRouteError(
          "暂时无法确认付款",
          "自动确认服务尚未就绪，请暂勿付款。页面会自动重试。",
          errorPayload.code ?? "reconciliation_not_ready",
          true,
        );
      }
      if (qrDialogWasOpen) focusStatusHeading();
      retryAfterMilliseconds = readRetryAfter(response.headers.get("retry-after"), backoffMilliseconds());
      retryNotBefore = Date.now() + retryAfterMilliseconds;
      setHidden(manualRefreshButton, !hasCheckoutData);
      scheduleNext(retryAfterMilliseconds);
      return;
    }

    retryFailures += 1;
    showNetworkMessage("服务器暂时无法刷新订单状态，页面会自动重试。", true);
    scheduleNext(backoffMilliseconds());
  }

  function applyCheckout(checkout) {
    const visualState = deriveVisualState(checkout);
    const previousState = lastVisualState;
    const previousRefund = lastRefundStatus;
    hasCheckoutData = true;
    lastVisualState = visualState;
    lastRefundStatus = checkout.refund.status;
    const routeErrorHadFocus = routeError instanceof HTMLElement
      && routeError.contains(document.activeElement);

    setHidden(routeError, true);
    setHidden(content, false);
    setHidden(root.querySelector("[data-service-alert]"), true);
    setStatus(visualState, stateCopy[visualState]);

    setText(root.querySelector("[data-merchant-order-no]"), checkout.merchant_order_no);
    setText(root.querySelector("[data-description]"), checkout.description ?? "");
    setHidden(root.querySelector("[data-description-row]"), checkout.description === null);
    setText(
      root.querySelector("[data-requested-amount]"),
      formatMoney(checkout.requested_amount_cents, checkout.currency),
    );

    const instructions = checkout.payment_instructions;
    const displayedAmount = instructions?.payable_amount_cents
      ?? checkout.payment.received_amount_cents
      ?? checkout.requested_amount_cents;
    const amountLabel = instructions !== null
      ? "本次应付"
      : checkout.payment.status === "CONFIRMED" || checkout.payment.status === "DISPUTED"
        ? "已收金额"
        : "订单金额";
    setText(root.querySelector("[data-amount-label]"), amountLabel);
    setText(root.querySelector("[data-payable-amount]"), formatCents(displayedAmount));
    const formattedAmount = formatCents(displayedAmount);
    const amount = root.querySelector(".checkout-amount");
    setText(root.querySelector("[data-amount-accessible]"), `${amountLabel} ${formattedAmount} 元`);
    if (amount instanceof HTMLElement) {
      amount.classList.toggle("is-long", formattedAmount.length >= 10 && formattedAmount.length < 13);
      amount.classList.toggle("is-very-long", formattedAmount.length >= 13);
    }

    const qrCanBeShown = visualState === "UNPAID" && instructions !== null && ensureQrSource();
    const qrDialogWasOpen = qrCanBeShown ? false : deactivateQr();
    setHidden(qrPanel, !qrCanBeShown);
    setHidden(root.querySelector("[data-payment-guidance]"), !qrCanBeShown);
    const manualWasFocused = manualRefreshButton instanceof HTMLElement && manualRefreshButton === document.activeElement;
    setHidden(manualRefreshButton, !["UNPAID", "UNAVAILABLE"].includes(visualState));
    setHidden(countdownWrap, visualState !== "UNPAID");
    root.dataset.expiresAt = checkout.checkout.expires_at;
    if (countdown instanceof HTMLTimeElement) countdown.dateTime = checkout.checkout.expires_at;
    updateCountdown();
    updateRefund(checkout.refund.status);
    updateEvidence(checkout, visualState);

    root.dataset.initialState = visualState;
    root.dataset.checkoutStatus = checkout.checkout.status;
    root.dataset.paymentStatus = checkout.payment.status;
    root.dataset.paymentBasis = checkout.payment.basis;
    root.dataset.refundStatus = checkout.refund.status;
    document.title = `${checkout.merchant_order_no} | PerPay 收银台`;

    if (routeErrorHadFocus || qrDialogWasOpen || (manualWasFocused && manualRefreshButton instanceof HTMLElement && manualRefreshButton.hidden)) focusStatusHeading();

    if (previousState !== visualState) {
      showUpdateMessage(stateCopy[visualState].detail, visualState === "DISPUTED" ? "danger" : "success");
    } else if (previousRefund !== checkout.refund.status) {
      showUpdateMessage(
        checkout.refund.status === "FULL" ? "此订单已更新为全额退款。" : "此订单的退款状态已更新。",
        "info",
      );
    } else {
      hideUpdateMessage();
    }
  }

  function setStatus(visualState, copy) {
    if (copy === undefined) return;
    const badge = root.querySelector("[data-status-badge]");
    if (badge instanceof HTMLElement) {
      badge.textContent = copy.badge;
      badge.classList.remove("is-success", "is-warning", "is-danger");
      if (copy.badgeClass) badge.classList.add(copy.badgeClass);
    }
    setText(root.querySelector("[data-status-heading]"), copy.heading);
    setText(root.querySelector("[data-status-detail]"), copy.detail);
    if (content instanceof HTMLElement) content.dataset.state = visualState;
  }

  function updateRefund(refundStatus) {
    const refundMessage = root.querySelector("[data-refund-message]");
    if (!(refundMessage instanceof HTMLElement)) return;
    refundMessage.classList.remove("checkout-alert--info");
    if (refundStatus === "NONE") {
      refundMessage.hidden = true;
      return;
    }
    refundMessage.hidden = false;
    refundMessage.classList.add("checkout-alert--info");
    setText(
      refundMessage.querySelector("[data-refund-title]"),
      refundStatus === "FULL" ? "款项已全额退款" : "款项已部分退款",
    );
    setText(
      refundMessage.querySelector("[data-refund-detail]"),
      refundStatus === "FULL"
        ? "此订单的已收款项已登记为全额退款。"
        : "此订单已有部分退款，具体金额请联系订单提供方确认。",
    );
  }

  function updateEvidence(checkout, visualState) {
    let steps;
    if (visualState === "CONFIRMED") {
      steps = {
        payment: ["complete", "付款已到账"],
        ledger: ["complete", "流水已核对"],
        confirmation: [
          "complete",
          checkout.payment.basis === "INFERRED" ? "已自动确认" : "订单已确认",
        ],
      };
    } else if (visualState === "DISPUTED") {
      steps = {
        payment: ["complete", "已有付款记录"],
        ledger: ["complete", "已有流水关联"],
        confirmation: ["danger", "关联存在争议"],
      };
    } else if (visualState === "CLOSED" || visualState === "EXPIRED") {
      steps = {
        payment: ["stopped", visualState === "CLOSED" ? "订单已关闭" : "付款时间已结束"],
        ledger: ["pending", "未进入核对"],
        confirmation: ["pending", "未确认"],
      };
    } else {
      steps = {
        payment: ["current", "等待付款"],
        ledger: ["pending", "等待流水"],
        confirmation: ["pending", "匹配后自动确认"],
      };
    }

    for (const [name, values] of Object.entries(steps)) {
      const step = root.querySelector(`[data-evidence-step="${name}"]`);
      if (!(step instanceof HTMLElement)) continue;
      step.classList.remove("is-complete", "is-current", "is-pending", "is-danger", "is-stopped");
      step.classList.add(`is-${values[0]}`);
      step.dataset.stepState = values[0];
      setText(step.querySelector("[data-evidence-detail]"), values[1]);
    }
  }

  function startCountdown() {
    stopCountdown();
    updateCountdown();
    countdownTimerId = window.setInterval(updateCountdown, 1_000);
  }

  function stopCountdown() {
    if (countdownTimerId !== undefined) window.clearInterval(countdownTimerId);
    countdownTimerId = undefined;
  }

  function updateCountdown() {
    if (!(countdown instanceof HTMLTimeElement) || countdownWrap?.hasAttribute("hidden")) return;
    const expiresAt = Date.parse(root.dataset.expiresAt ?? "");
    if (!Number.isFinite(expiresAt)) {
      countdown.textContent = "等待更新";
      return;
    }
    const remaining = Math.max(0, expiresAt - Date.now());
    if (remaining === 0) {
      countdown.textContent = "等待更新";
      return;
    }
    const totalSeconds = Math.ceil(remaining / 1_000);
    const hours = Math.floor(totalSeconds / 3_600);
    const minutes = Math.floor((totalSeconds % 3_600) / 60);
    const seconds = totalSeconds % 60;
    const visible = hours > 0
      ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
      : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    countdown.textContent = visible;
  }

  function showRouteError(title, message, code, retryable) {
    const shouldMoveFocus = routeError instanceof HTMLElement && routeError.hidden;
    deactivateQr();
    setHidden(manualRefreshButton, true);
    setHidden(content, true);
    setHidden(routeError, false);
    setText(routeError?.querySelector("[data-route-error-title]"), title);
    setText(routeError?.querySelector("[data-route-error-message]"), message);
    setText(routeError?.querySelector("[data-route-error-code]"), code === "checkout_not_found" ? "404" : "");
    setText(routeError?.querySelector("[data-request-reference] .checkout-mono"), code);
    setHidden(routeError?.querySelector("[data-request-reference]"), !code);
    setHidden(retryButton, !retryable);
    if (shouldMoveFocus) {
      window.requestAnimationFrame(() => {
        const heading = routeError?.querySelector("[data-route-error-title]");
        if (routeError instanceof HTMLElement && !routeError.hidden && heading instanceof HTMLElement) {
          heading.focus();
        }
      });
    }
  }

  function showNetworkMessage(message, danger) {
    if (!(networkBanner instanceof HTMLElement)) return;
    networkBanner.hidden = false;
    networkBanner.textContent = message;
    networkBanner.classList.toggle("checkout-alert--danger", danger);
    networkBanner.classList.toggle("checkout-alert--warning", !danger);
  }

  function hideNetworkMessage() {
    if (!(networkBanner instanceof HTMLElement)) return;
    networkBanner.hidden = true;
    networkBanner.textContent = "";
    networkBanner.classList.remove("checkout-alert--danger");
    networkBanner.classList.add("checkout-alert--warning");
  }

  function showUpdateMessage(message, tone) {
    const update = root.querySelector("[data-update-message]");
    if (!(update instanceof HTMLElement)) return;
    update.classList.remove(
      "checkout-alert--success",
      "checkout-alert--warning",
      "checkout-alert--danger",
      "checkout-alert--info",
    );
    const toneClass = {
      success: "checkout-alert--success",
      warning: "checkout-alert--warning",
      danger: "checkout-alert--danger",
      info: "checkout-alert--info",
    }[tone];
    if (toneClass) update.classList.add(toneClass);
    update.textContent = message;
    update.hidden = false;
  }

  function hideUpdateMessage() {
    setHidden(root.querySelector("[data-update-message]"), true);
  }

  function setQrLoadError(failed) {
    const qrDialogWasOpen = failed ? clearQrDialog() : false;
    setHidden(qrImage, failed);
    setHidden(qrError, !failed);
    setHidden(qrActions, failed);
    if (qrDialogWasOpen) {
      window.requestAnimationFrame(() => {
        const reload = root.querySelector("[data-qr-reload]");
        if (reload instanceof HTMLElement && !reload.hidden) reload.focus();
      });
    }
  }

  function ensureQrSource() {
    if (!(qrImage instanceof HTMLImageElement)) return false;
    const originalSource = resolveQrSource();
    if (originalSource === null) return false;
    if (!qrImage.hasAttribute("src")) qrImage.src = originalSource;
    if (qrDialogImage instanceof HTMLImageElement && !qrDialogImage.hasAttribute("src")) {
      qrDialogImage.src = originalSource;
    }
    if (qrDownload instanceof HTMLAnchorElement && !qrDownload.hasAttribute("href")) {
      qrDownload.href = originalSource;
    }
    return true;
  }

  function resolveQrSource() {
    if (!(qrImage instanceof HTMLImageElement)) return null;
    const configuredSource = qrImage.dataset.originalSrc;
    if (configuredSource) return sameOriginUrl(configuredSource) === null ? null : configuredSource;
    if (qrUrl === null) return null;
    const recoveredSource = qrUrl.pathname + qrUrl.search;
    qrImage.dataset.originalSrc = recoveredSource;
    if (qrDialogImage instanceof HTMLImageElement) {
      qrDialogImage.dataset.originalSrc = recoveredSource;
    }
    return recoveredSource;
  }

  function deactivateQr() {
    const qrDialogWasOpen = clearQrDialog();
    setQrLoadError(false);
    return qrDialogWasOpen;
  }

  function clearQrDialog() {
    const wasOpen = qrDialog instanceof HTMLDialogElement && qrDialog.open;
    if (wasOpen) qrDialog.close();
    if (qrDialogImage instanceof HTMLImageElement) qrDialogImage.removeAttribute("src");
    return wasOpen;
  }

  function focusStatusHeading() {
    window.requestAnimationFrame(() => {
      const heading = root.querySelector("[data-status-heading]");
      if (content instanceof HTMLElement && !content.hidden && heading instanceof HTMLElement) {
        heading.focus();
      }
    });
  }

  function scheduleNext(delay) {
    clearScheduledRefresh();
    if (destroyed || delay === null || document.hidden || !navigator.onLine) return;
    timerId = window.setTimeout(() => void refresh(), Math.max(250, delay));
  }

  function setManualRefreshBusy(busy) {
    if (!(manualRefreshButton instanceof HTMLElement)) return;
    manualRefreshButton.disabled = busy || Date.now() < retryNotBefore;
    manualRefreshButton.setAttribute("aria-busy", String(busy));
    if (manualRefreshLabel instanceof HTMLElement) {
      manualRefreshLabel.textContent = busy ? "正在检查" : "立即检查支付状态";
    }
    manualRefreshButton.toggleAttribute("data-loading", busy);
  }

  function updateManualRefreshButton() {
    if (!(manualRefreshButton instanceof HTMLElement)) return;
    const terminal = !["UNPAID", "UNAVAILABLE"].includes(lastVisualState);
    setHidden(manualRefreshButton, terminal || !hasCheckoutData);
    manualRefreshButton.disabled = refreshInFlight || destroyed || document.hidden || !navigator.onLine || Date.now() < retryNotBefore;
    if (!refreshInFlight && manualRefreshLabel instanceof HTMLElement) manualRefreshLabel.textContent = "立即检查支付状态";
  }

  function clearScheduledRefresh() {
    if (timerId !== undefined) window.clearTimeout(timerId);
    timerId = undefined;
  }

  function initialDelay() {
    if (lastVisualState === "RATE_LIMITED" || lastVisualState === "UNAVAILABLE") {
      return retryAfterMilliseconds || 2_500;
    }
    if (lastVisualState === "CONFIRMED" || lastVisualState === "DISPUTED") return 30_000;
    if (lastVisualState === "CLOSED" || lastVisualState === "EXPIRED" || lastVisualState === "NOT_FOUND") {
      return null;
    }
    return 1_500;
  }

  function intervalForState(state) {
    if (state === "UNPAID") return 2_500;
    if (state === "CONFIRMED" || state === "DISPUTED") return 30_000;
    return null;
  }

  function backoffMilliseconds() {
    const exponent = Math.min(retryFailures, 5);
    return Math.min(30_000, 1_000 * (2 ** exponent));
  }

  function deriveVisualState(checkout) {
    if (checkout.payment.status === "DISPUTED") return "DISPUTED";
    if (checkout.payment.status === "CONFIRMED") return "CONFIRMED";
    if (checkout.checkout.status === "CLOSED") return "CLOSED";
    if (checkout.checkout.status === "EXPIRED") return "EXPIRED";
    return "UNPAID";
  }

  function readCheckoutPayload(payload) {
    const checkout = payload && typeof payload === "object" ? payload.data : undefined;
    if (!isCheckout(checkout)) throw new TypeError("checkout response is invalid");
    return checkout;
  }

  function isCheckout(value) {
    if (!value || typeof value !== "object") return false;
    if (typeof value.merchant_order_no !== "string" || value.merchant_order_no.length === 0) return false;
    if (!isAmount(value.requested_amount_cents) || value.currency !== "CNY") return false;
    if (value.description !== null && typeof value.description !== "string") return false;
    if (!value.checkout || !["OPEN", "CLOSED", "EXPIRED"].includes(value.checkout.status)) return false;
    if (typeof value.checkout.expires_at !== "string" || !Number.isFinite(Date.parse(value.checkout.expires_at))) return false;
    if (!value.payment || !["UNPAID", "CONFIRMED", "DISPUTED"].includes(value.payment.status)) return false;
    if (!["NONE", "INFERRED", "MANUAL"].includes(value.payment.basis)) return false;
    if (value.payment.received_amount_cents !== null && !isAmount(value.payment.received_amount_cents)) return false;
    if (!value.refund || !["NONE", "PARTIAL", "FULL"].includes(value.refund.status)) return false;
    if (value.payment_instructions !== null) {
      if (!value.payment_instructions || typeof value.payment_instructions !== "object") return false;
      if (!isAmount(value.payment_instructions.payable_amount_cents)) return false;
      if (value.payment_instructions.currency !== "CNY") return false;
    }
    return true;
  }

  function isAmount(value) {
    return Number.isSafeInteger(value) && value >= 0;
  }

  async function readErrorPayload(response) {
    try {
      const payload = await response.json();
      const code = payload?.error?.code;
      return { code: typeof code === "string" ? code : null };
    } catch {
      return { code: null };
    }
  }

  function sameOriginUrl(value) {
    if (typeof value !== "string" || value.trim().length === 0) return null;
    try {
      const url = new URL(value, window.location.origin);
      return url.origin === window.location.origin ? url : null;
    } catch {
      return null;
    }
  }

  function readRetryAfter(value, fallback) {
    if (value === null) return fallback;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(60_000, Math.max(250, seconds * 1_000));
    }
    const date = Date.parse(value);
    if (Number.isFinite(date)) return Math.min(60_000, Math.max(250, date - Date.now()));
    return fallback;
  }

  function parseRetryAfterSeconds(value) {
    const seconds = Number(value);
    return Number.isFinite(seconds) && seconds >= 0 ? Math.min(60, seconds) : 0;
  }

  function formatCents(cents) {
    const whole = Math.floor(cents / 100).toLocaleString("zh-CN");
    return `${whole}.${String(cents % 100).padStart(2, "0")}`;
  }

  function formatMoney(cents, currency) {
    return `${currency === "CNY" ? "¥" : currency} ${formatCents(cents)}`;
  }

  function setText(node, value) {
    if (node instanceof HTMLElement) node.textContent = value;
  }

  function setHidden(node, hidden) {
    if (node instanceof HTMLElement) node.hidden = hidden;
  }
})();
