import type { ReactNode } from "react";
import { encode } from "uqr";
import {
  AlertCircle,
  ArrowLeft,
  Ban,
  CheckCircle2,
  Clock,
  Copy,
  Download,
  ExternalLink,
  Info,
  Maximize,
  Monitor,
  Plus,
  RefreshCw,
  Smartphone,
  WalletCards,
} from "lucide-react";
import type { SitePolicy } from "@/api/client";
import { AlipayLogo } from "@/checkout/AlipayLogo";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import {
  DEFAULT_CHECKOUT_COPY,
  DEFAULT_CHECKOUT_HELP_LABEL,
  formatCheckoutTemplate,
} from "../../../src/shared/checkout-display";
import { checkoutHelpUrl } from "../../../src/shared/checkout-help";

export type CheckoutPreviewState =
  | "UNPAID"
  | "CONFIRMED"
  | "EXPIRED"
  | "DISPUTED"
  | "CLOSED";

export type CheckoutPreviewViewport = "desktop" | "mobile";

export type CheckoutDisplayTarget =
  | "checkout_name"
  | "checkout_help_url"
  | "checkout_help_label"
  | "checkout_show_product_name"
  | "checkout_show_merchant_order_no"
  | "checkout_show_countdown"
  | "checkout_show_amount_adjustment"
  | "checkout_show_qr_tools"
  | "checkout_show_alipay_launch"
  | "checkout_show_theme_toggle"
  | "checkout_payment_instructions"
  | "checkout_adjustment_hint"
  | "checkout_notice"
  | "checkout_confirmed_detail"
  | "checkout_expired_detail"
  | "checkout_disputed_detail"
  | "checkout_closed_detail";

export const CHECKOUT_PREVIEW_STATES: ReadonlyArray<{
  readonly value: CheckoutPreviewState;
  readonly label: string;
}> = [
  { value: "UNPAID", label: "待付款" },
  { value: "CONFIRMED", label: "付款成功" },
  { value: "EXPIRED", label: "已过期" },
  { value: "DISPUTED", label: "待核实" },
  { value: "CLOSED", label: "已关闭" },
];

const PREVIEW_QR = (() => {
  const qr = encode("https://qr.alipay.com/perpay-preview", {
    ecc: "M",
    boostEcc: true,
    border: 3,
  });
  const segments: string[] = [];
  for (let y = 0; y < qr.size; y += 1) {
    const row = qr.data[y];
    if (!row) continue;
    let x = 0;
    while (x < qr.size) {
      if (!row[x]) {
        x += 1;
        continue;
      }
      const start = x;
      while (x < qr.size && row[x]) x += 1;
      segments.push(`M${start} ${y}h${x - start}v1h-${x - start}z`);
    }
  }
  return { size: qr.size, path: segments.join("") };
})();

const SAMPLE_PAYABLE = "¥19.01";
const SAMPLE_REQUESTED = "¥19.00";
const SAMPLE_OFFSET = "¥0.01";
const SAMPLE_PRODUCT = "示例商品 · 专业版年度订阅";
const SAMPLE_ORDER_NO = "DEMO_20261124_001";

function PreviewHotspot({
  target,
  label,
  activeTarget,
  onSelectTarget,
  tagAlign,
  className,
  children,
}: {
  target: CheckoutDisplayTarget;
  label: string;
  activeTarget?: CheckoutDisplayTarget | null;
  onSelectTarget?: (target: CheckoutDisplayTarget) => void;
  tagAlign?: "start" | "end";
  className?: string;
  children: ReactNode;
}) {
  if (!onSelectTarget) {
    return <div className={className}>{children}</div>;
  }
  const active = activeTarget === target;
  return (
    <Button
      type="button"
      variant="ghost"
      className={cn(
        "checkout-preview-hotspot h-auto justify-start whitespace-normal p-0 font-normal hover:bg-transparent dark:hover:bg-transparent",
        className,
      )}
      data-preview-target={target}
      data-active={active || undefined}
      data-tag-align={tagAlign}
      aria-pressed={active}
      aria-label={`定位配置：${label}`}
      onClick={() => onSelectTarget(target)}
    >
      <span className="checkout-preview-hotspot-tag" aria-hidden="true">
        {label}
      </span>
      {children}
    </Button>
  );
}

export function CheckoutDisplayPreview({
  display,
  previewState,
  onPreviewStateChange,
  viewport,
  onViewportChange,
  activeTarget,
  onSelectTarget,
  compact = false,
}: {
  display: SitePolicy["display"];
  previewState: CheckoutPreviewState;
  onPreviewStateChange: (state: CheckoutPreviewState) => void;
  viewport: CheckoutPreviewViewport;
  onViewportChange: (viewport: CheckoutPreviewViewport) => void;
  activeTarget?: CheckoutDisplayTarget | null;
  onSelectTarget?: (target: CheckoutDisplayTarget) => void;
  compact?: boolean;
}) {
  const name = display.checkout_name.trim() || "未命名收银台";
  const showProductName = display.checkout_show_product_name !== false;
  const showMerchantOrderNo = display.checkout_show_merchant_order_no !== false;
  const showCountdown = display.checkout_show_countdown !== false;
  const showAmountAdjustment = display.checkout_show_amount_adjustment !== false;
  const showQrTools = display.checkout_show_qr_tools !== false;
  const showAlipayLaunch = display.checkout_show_alipay_launch !== false;
  const showThemeToggle = display.checkout_show_theme_toggle !== false;
  const helpUrl = checkoutHelpUrl(display.checkout_help_url ?? null);
  const helpLabel = display.checkout_help_label?.trim() || DEFAULT_CHECKOUT_HELP_LABEL;

  const isUnpaid = previewState === "UNPAID";
  const isTerminal = !isUnpaid;
  const isMobile = viewport === "mobile";

  const showAdjustmentDetails = isUnpaid && showAmountAdjustment;
  const customAdjustmentHint =
    showAdjustmentDetails && display.checkout_adjustment_hint?.trim()
      ? formatCheckoutTemplate(display.checkout_adjustment_hint.trim(), {
          amount: SAMPLE_PAYABLE,
          offset: SAMPLE_OFFSET,
        })
      : null;

  const customPaymentInstructions = display.checkout_payment_instructions?.trim()
    ? formatCheckoutTemplate(display.checkout_payment_instructions.trim(), {
        amount: SAMPLE_PAYABLE,
        offset: SAMPLE_OFFSET,
      })
    : null;

  const defaultPaymentInstructions = isMobile
    ? showAlipayLaunch
      ? formatCheckoutTemplate(DEFAULT_CHECKOUT_COPY.paymentInstructionsMobileLaunch, {
          amount: SAMPLE_PAYABLE,
        })
      : formatCheckoutTemplate(DEFAULT_CHECKOUT_COPY.paymentInstructionsMobileScan, {
          amount: SAMPLE_PAYABLE,
        })
    : formatCheckoutTemplate(DEFAULT_CHECKOUT_COPY.paymentInstructionsDesktop, {
        amount: SAMPLE_PAYABLE,
      });

  const paymentInstructionsText =
    customPaymentInstructions ?? defaultPaymentInstructions;

  const terminalMeta = {
    CONFIRMED: {
      heading: "付款成功",
      badge: "已完成",
      badgeVariant: "success" as const,
      tone: "success" as const,
      amountLabel: "实付金额",
      amount: SAMPLE_PAYABLE,
      detail: display.checkout_confirmed_detail?.trim() ?? DEFAULT_CHECKOUT_COPY.confirmedDetail,
      detailTarget: "checkout_confirmed_detail" as const,
      detailLabel: "付款成功说明",
      returnLabel: "返回商家",
      showRefresh: false,
    },
    EXPIRED: {
      heading: "付款时间已过",
      badge: "已过期",
      badgeVariant: "secondary" as const,
      tone: "warning" as const,
      amountLabel: "订单金额",
      amount: SAMPLE_REQUESTED,
      detail: display.checkout_expired_detail?.trim() || DEFAULT_CHECKOUT_COPY.expiredDetail,
      detailTarget: "checkout_expired_detail" as const,
      detailLabel: "付款时间已过说明",
      returnLabel: "返回商家处理",
      showRefresh: true,
    },
    DISPUTED: {
      heading: "付款待商家核实",
      badge: "核实中",
      badgeVariant: "destructive" as const,
      tone: "danger" as const,
      amountLabel: "实付金额",
      amount: SAMPLE_PAYABLE,
      detail: display.checkout_disputed_detail?.trim() || DEFAULT_CHECKOUT_COPY.disputedDetail,
      detailTarget: "checkout_disputed_detail" as const,
      detailLabel: "付款待商家核实说明",
      returnLabel: "返回商家处理",
      showRefresh: false,
    },
    CLOSED: {
      heading: "订单已关闭",
      badge: "已关闭",
      badgeVariant: "secondary" as const,
      tone: "neutral" as const,
      amountLabel: "订单金额",
      amount: SAMPLE_REQUESTED,
      detail: display.checkout_closed_detail?.trim() || DEFAULT_CHECKOUT_COPY.closedDetail,
      detailTarget: "checkout_closed_detail" as const,
      detailLabel: "订单已关闭说明",
      returnLabel: "返回商家处理",
      showRefresh: true,
    },
  };

  const currentTerminal = isTerminal ? terminalMeta[previewState] : null;
  const terminalNoteText = currentTerminal?.detail ?? "";
  const showConfirmedOptionalSlot = Boolean(
    previewState === "CONFIRMED" && !terminalNoteText && onSelectTarget,
  );
  const customNotice = display.checkout_notice?.trim() || null;

  const hasOrderMeta = showProductName || showMerchantOrderNo;
  const hasSummaryBody = hasOrderMeta || showAdjustmentDetails || Boolean(customNotice);
  const hasSummaryPanel =
    hasSummaryBody || Boolean(terminalNoteText) || showConfirmedOptionalSlot;
  const useTwoColumns = !isMobile && hasSummaryPanel;
  const hasRightFooterNote =
    useTwoColumns && (Boolean(terminalNoteText) || showConfirmedOptionalSlot || isUnpaid);

  const badgeNode = (
    <Badge
      className="h-auto min-h-5 max-w-full whitespace-normal"
      variant={isUnpaid ? "secondary" : currentTerminal!.badgeVariant}
    >
      {isUnpaid ? "待付款" : currentTerminal!.badge}
      {isUnpaid && showCountdown && (
        <>
          <span aria-hidden="true">·</span>
          <span className="tabular-nums">04:58</span>
        </>
      )}
    </Badge>
  );

  const statusBadgeElement = isUnpaid ? (
    <PreviewHotspot
      target="checkout_show_countdown"
      label="剩余支付倒计时"
      activeTarget={activeTarget}
      onSelectTarget={onSelectTarget}
      tagAlign="end"
      className="inline-flex rounded-full"
    >
      {badgeNode}
    </PreviewHotspot>
  ) : (
    badgeNode
  );

  const terminalIconNode = currentTerminal ? (
    <div
      className="checkout-preview-state-icon"
      data-tone={currentTerminal.tone}
      data-large={useTwoColumns || undefined}
      aria-hidden="true"
    >
      {previewState === "CONFIRMED" ? (
        <CheckCircle2 />
      ) : previewState === "EXPIRED" ? (
        <Clock />
      ) : previewState === "CLOSED" ? (
        <Ban />
      ) : (
        <AlertCircle />
      )}
    </div>
  ) : null;

  const paymentInstructionsBlock = isUnpaid && (
    <div
      className={cn(
        "checkout-preview-note",
        useTwoColumns
          ? "checkout-preview-note-desktop"
          : "px-4 pt-1 pb-2.5 text-center text-xs",
      )}
      data-preview-instructions
    >
      <div className={cn(useTwoColumns && "border-t border-border/70 pt-3")}>
        <PreviewHotspot
          target="checkout_payment_instructions"
          label="待付款指引文案"
          activeTarget={activeTarget}
          onSelectTarget={onSelectTarget}
          className={cn("w-full rounded-md", useTwoColumns ? "text-left" : "text-center")}
        >
          <p className="text-xs leading-relaxed text-muted-foreground">
            {paymentInstructionsText}
          </p>
        </PreviewHotspot>
      </div>
    </div>
  );

  const terminalNoteBlock = currentTerminal && (terminalNoteText || showConfirmedOptionalSlot) && (
    <div
      className={cn(
        "checkout-preview-note",
        useTwoColumns
          ? "checkout-preview-note-desktop"
          : "px-4 pt-1 pb-2.5 text-center text-xs",
      )}
      data-preview-terminal-note={terminalNoteText ? true : undefined}
      data-preview-confirmed-optional={showConfirmedOptionalSlot || undefined}
    >
      <div className={cn(useTwoColumns && "border-t border-border/70 pt-3")}>
        {terminalNoteText ? (
          <PreviewHotspot
            target={currentTerminal.detailTarget}
            label={currentTerminal.detailLabel}
            activeTarget={activeTarget}
            onSelectTarget={onSelectTarget}
            className={cn("w-full rounded-md", useTwoColumns ? "text-left" : "text-center")}
          >
            <p className="text-xs leading-relaxed text-muted-foreground">
              {terminalNoteText}
            </p>
          </PreviewHotspot>
        ) : (
          <Button
            type="button"
            variant="ghost"
            className={cn(
              "checkout-preview-optional-slot h-auto",
              !useTwoColumns && "justify-center text-center",
            )}
            data-preview-target="checkout_confirmed_detail"
            data-active={activeTarget === "checkout_confirmed_detail" || undefined}
            aria-pressed={activeTarget === "checkout_confirmed_detail"}
            aria-label="启用并编辑付款成功说明（可选，默认关闭无文案）"
            onClick={() => onSelectTarget?.("checkout_confirmed_detail")}
          >
            <Plus className="size-3.5 shrink-0" aria-hidden="true" />
            <span>付款成功说明（默认关闭）</span>
          </Button>
        )}
      </div>
    </div>
  );

  const actionsBlock = (
    <div
      className={cn(
        "checkout-preview-actions flex flex-col gap-2",
        useTwoColumns ? "px-5 pt-0 pb-5" : "px-4 pb-4",
      )}
    >
      {isUnpaid ? (
        isMobile && showAlipayLaunch ? (
          <div className="flex flex-wrap items-stretch gap-2">
            <PreviewHotspot
              target="checkout_show_alipay_launch"
              label="打开支付宝按钮"
              activeTarget={activeTarget}
              onSelectTarget={onSelectTarget}
              className="flex-auto rounded-lg"
            >
              <span
                className={buttonVariants({
                  variant: "default",
                  size: "sm",
                  className: "pointer-events-none h-9 w-full",
                })}
              >
                <ExternalLink aria-hidden="true" data-icon="inline-start" />
                打开支付宝
              </span>
            </PreviewHotspot>
            <span
              className={buttonVariants({
                variant: "outline",
                size: "sm",
                className: "pointer-events-none h-9 min-w-0 flex-[1_1_8.5rem]",
              })}
            >
              <RefreshCw aria-hidden="true" data-icon="inline-start" />
              我已付款，查询状态
            </span>
          </div>
        ) : (
          <span
            className={buttonVariants({
              variant: "default",
              size: "sm",
              className: "pointer-events-none h-9 w-full",
            })}
          >
            <RefreshCw aria-hidden="true" data-icon="inline-start" />
            我已付款，查询状态
          </span>
        )
      ) : (
        <div
          className={cn(
            "flex flex-col gap-2",
            currentTerminal!.showRefresh && !isMobile && "grid grid-cols-2",
          )}
        >
          <span
            className={buttonVariants({
              variant: "default",
              size: "sm",
              className: "pointer-events-none h-9 w-full",
            })}
          >
            <ArrowLeft aria-hidden="true" data-icon="inline-start" />
            {currentTerminal!.returnLabel}
          </span>
          {currentTerminal!.showRefresh && (
            <span
              className={buttonVariants({
                variant: "outline",
                size: "sm",
                className: "pointer-events-none h-9 w-full",
              })}
            >
              <RefreshCw aria-hidden="true" data-icon="inline-start" />
              刷新付款状态
            </span>
          )}
        </div>
      )}
    </div>
  );

  const summarySection = hasSummaryPanel && (
    <div
      className={cn(
        "checkout-preview-summary flex min-w-0 flex-col gap-3",
        useTwoColumns
          ? hasRightFooterNote
            ? "px-5 pt-5 pb-3"
            : "row-span-2 p-5"
          : "px-4 pb-4",
        !useTwoColumns && !hasSummaryBody && "hidden",
      )}
      data-preview-summary
    >
      {useTwoColumns && (
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-semibold tracking-tight text-foreground">
            订单信息
          </span>
          {statusBadgeElement}
        </div>
      )}
      {hasSummaryBody && (
        <div className="flex min-w-0 flex-col gap-3">
          {hasOrderMeta && (
            <div className="flex min-w-0 flex-col gap-2.5 text-xs">
              {showProductName && (
                <PreviewHotspot
                  target="checkout_show_product_name"
                  label="商品名称"
                  activeTarget={activeTarget}
                  onSelectTarget={onSelectTarget}
                  className="w-full rounded-md"
                >
                  <div
                    className={cn(
                      "flex min-w-0",
                      useTwoColumns
                        ? "flex-col items-start gap-0.5 text-left"
                        : "items-baseline justify-between gap-3",
                    )}
                  >
                    <span className="shrink-0 text-[0.6875rem] text-muted-foreground">
                      商品
                    </span>
                    <span
                      className={cn(
                        "min-w-0 font-medium text-foreground wrap-anywhere",
                        !useTwoColumns && "text-right",
                      )}
                      data-preview-product-name
                    >
                      {SAMPLE_PRODUCT}
                    </span>
                  </div>
                </PreviewHotspot>
              )}
              {showMerchantOrderNo && (
                <PreviewHotspot
                  target="checkout_show_merchant_order_no"
                  label="商家订单号"
                  activeTarget={activeTarget}
                  onSelectTarget={onSelectTarget}
                  className="w-full rounded-md"
                >
                  <div
                    className={cn(
                      "flex min-w-0",
                      useTwoColumns
                        ? "flex-col items-start gap-0.5 text-left"
                        : "items-baseline justify-between gap-3",
                    )}
                  >
                    <span className="shrink-0 text-[0.6875rem] text-muted-foreground">
                      商家订单号
                    </span>
                    <span
                      className={cn(
                        "inline-flex min-w-0 items-center gap-1.5 font-mono text-[0.6875rem] text-foreground",
                        !useTwoColumns && "justify-end",
                      )}
                      data-preview-order-no
                    >
                      <span className="truncate">{SAMPLE_ORDER_NO}</span>
                      <Copy className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
                    </span>
                  </div>
                </PreviewHotspot>
              )}
            </div>
          )}
          {showAdjustmentDetails && (
            <div className={cn(hasOrderMeta && "border-t border-border/70 pt-2.5")}>
              <PreviewHotspot
                target="checkout_show_amount_adjustment"
                label="金额微调明细"
                activeTarget={activeTarget}
                onSelectTarget={onSelectTarget}
                className="w-full rounded-md text-left"
              >
                <div className="flex flex-col gap-1.5 text-xs" data-preview-breakdown>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-muted-foreground">商品原价</span>
                    <span className="tabular-nums text-foreground">
                      {SAMPLE_REQUESTED}
                    </span>
                  </div>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-muted-foreground">自动核对微调</span>
                    <span className="tabular-nums text-foreground">
                      +{SAMPLE_OFFSET}
                    </span>
                  </div>
                  <div className="flex items-baseline justify-between gap-2 pt-0.5 font-medium">
                    <span className="text-foreground">实际应付</span>
                    <span className="tabular-nums text-foreground">
                      {SAMPLE_PAYABLE}
                    </span>
                  </div>
                </div>
              </PreviewHotspot>
            </div>
          )}
          {customNotice && (
            <div
              className={cn(
                (hasOrderMeta || showAdjustmentDetails) &&
                  "border-t border-border/70 pt-2.5",
              )}
            >
              <PreviewHotspot
                target="checkout_notice"
                label="收银台自定义公告"
                activeTarget={activeTarget}
                onSelectTarget={onSelectTarget}
                className="w-full rounded-md text-left"
              >
                <div
                  className="flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground"
                  data-preview-notice
                >
                  <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                  <p className="min-w-0 wrap-anywhere">{customNotice}</p>
                </div>
              </PreviewHotspot>
            </div>
          )}
        </div>
      )}
    </div>
  );

  return (
    <div
      className="checkout-preview-shell flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card"
      data-checkout-preview
      data-preview-state={previewState}
      data-preview-viewport={viewport}
    >
      <div className="checkout-preview-toolbar flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/35 px-3 py-2">
        <div
          className="checkout-preview-segmented flex flex-wrap items-center gap-1"
          role="group"
          aria-label="预览订单状态"
        >
          {CHECKOUT_PREVIEW_STATES.map((item) => {
            const selected = previewState === item.value;
            return (
              <Button
                key={item.value}
                type="button"
                variant="ghost"
                size="xs"
                aria-pressed={selected}
                data-active={selected || undefined}
                className="checkout-preview-segment-btn h-auto"
                onClick={() => onPreviewStateChange(item.value)}
              >
                {item.label}
              </Button>
            );
          })}
        </div>
        <div
          className="checkout-preview-segmented inline-flex shrink-0 items-center gap-1"
          role="group"
          aria-label="预览设备尺寸"
        >
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-pressed={viewport === "desktop"}
            data-active={viewport === "desktop" || undefined}
            className="checkout-preview-segment-btn h-auto"
            onClick={() => onViewportChange("desktop")}
          >
            <Monitor className="size-3.5" aria-hidden="true" />
            <span>桌面</span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-pressed={viewport === "mobile"}
            data-active={viewport === "mobile" || undefined}
            className="checkout-preview-segment-btn h-auto"
            onClick={() => onViewportChange("mobile")}
          >
            <Smartphone className="size-3.5" aria-hidden="true" />
            <span>手机</span>
          </Button>
        </div>
      </div>

      <div
        className={cn(
          "checkout-preview-stage flex flex-col justify-between gap-4",
          compact ? "p-3 sm:p-4" : "p-4 sm:p-5",
        )}
      >
        <div
          className={cn(
            "checkout-preview-frame mx-auto flex w-full min-w-0 flex-col gap-3",
            isMobile && "checkout-preview-mobile-frame",
          )}
        >
          <div className="flex min-w-0 items-center justify-between gap-3">
            <PreviewHotspot
              target="checkout_name"
              label="收银台名称"
              activeTarget={activeTarget}
              onSelectTarget={onSelectTarget}
              className="max-w-full rounded-xl"
            >
              <span className="checkout-preview-brand" data-preview-brand-name>
                <span className="checkout-preview-brand-mark" aria-hidden="true">
                  <WalletCards className="size-3.5" />
                </span>
                <span className="truncate text-xs font-semibold tracking-tight text-foreground sm:text-sm">
                  {name}
                </span>
              </span>
            </PreviewHotspot>
            {showThemeToggle && (
              <PreviewHotspot
                target="checkout_show_theme_toggle"
                label="顶部外观切换"
                activeTarget={activeTarget}
                onSelectTarget={onSelectTarget}
                tagAlign="end"
                className="shrink-0 rounded-lg"
              >
                <span
                  className="checkout-preview-theme-pill"
                  data-preview-theme-toggle
                >
                  <Monitor className="size-3.5" aria-hidden="true" />
                  <span>外观</span>
                </span>
              </PreviewHotspot>
            )}
          </div>

          <div
            className={cn(
              "checkout-preview-card mx-auto w-full min-w-0 rounded-2xl border border-border bg-card text-card-foreground",
              useTwoColumns
                ? "checkout-preview-card-two-col"
                : "max-w-[22.5rem]",
              isTerminal && useTwoColumns && "min-h-[15.5rem]",
            )}
            data-preview-two-column={useTwoColumns || undefined}
          >
            <div
              className={cn(
                "flex min-w-0 flex-col gap-3",
                useTwoColumns
                  ? "col-start-1 row-start-1 row-span-2 px-5 pt-5 pb-3"
                  : "px-4 pt-4 pb-2",
                isTerminal && useTwoColumns && "justify-center",
              )}
            >
              {isUnpaid ? (
                <div
                  className={cn(
                    "flex items-center justify-between gap-2",
                    useTwoColumns && "justify-center",
                  )}
                >
                  <div className="flex items-center gap-2 text-base font-semibold tracking-tight">
                    <AlipayLogo />
                    <span>支付宝付款</span>
                  </div>
                  {!useTwoColumns && statusBadgeElement}
                </div>
              ) : (
                <div
                  className={cn(
                    "flex w-full min-w-0 items-center justify-between gap-2",
                    useTwoColumns && "flex-col justify-center gap-2 text-center",
                  )}
                >
                  <div
                    className={cn(
                      "flex min-w-0 items-center gap-2",
                      useTwoColumns && "flex-col gap-2.5",
                    )}
                  >
                    {terminalIconNode}
                    <span
                      className={cn(
                        "font-semibold tracking-tight text-foreground",
                        useTwoColumns ? "text-lg" : "text-base",
                      )}
                    >
                      {currentTerminal!.heading}
                    </span>
                  </div>
                  {!useTwoColumns && statusBadgeElement}
                </div>
              )}

              <div className="flex flex-col items-center gap-1.5">
                <div className="flex flex-wrap items-baseline justify-center gap-1.5">
                  <span className="text-xs text-muted-foreground">
                    {isUnpaid ? "应付金额" : currentTerminal!.amountLabel}
                  </span>
                  <strong className="text-2xl font-semibold tracking-tight tabular-nums text-foreground">
                    {isUnpaid ? SAMPLE_PAYABLE : currentTerminal!.amount}
                  </strong>
                  {isUnpaid && (
                    <Copy
                      className="size-3.5 shrink-0 self-center text-muted-foreground"
                      aria-hidden="true"
                    />
                  )}
                </div>
                {customAdjustmentHint && (
                  <PreviewHotspot
                    target="checkout_adjustment_hint"
                    label="金额微调提示文案"
                    activeTarget={activeTarget}
                    onSelectTarget={onSelectTarget}
                    className="max-w-full rounded-full"
                  >
                    <p
                      className="checkout-preview-offset-pill"
                      data-preview-adjustment-hint
                    >
                      {customAdjustmentHint}
                    </p>
                  </PreviewHotspot>
                )}
              </div>

              {isUnpaid && (
                <div className="flex flex-col items-center gap-2">
                  <div className="checkout-preview-qr-frame">
                    <svg
                      viewBox={`0 0 ${PREVIEW_QR.size} ${PREVIEW_QR.size}`}
                      className={cn(
                        "block bg-white",
                        isMobile ? "size-36" : "size-40",
                      )}
                      role="img"
                      aria-label="示例付款二维码"
                    >
                      <rect
                        width={PREVIEW_QR.size}
                        height={PREVIEW_QR.size}
                        fill="#ffffff"
                      />
                      <path d={PREVIEW_QR.path} fill="#2f2f2c" />
                    </svg>
                  </div>
                  {showQrTools && (
                    <PreviewHotspot
                      target="checkout_show_qr_tools"
                      label="二维码工具栏"
                      activeTarget={activeTarget}
                      onSelectTarget={onSelectTarget}
                      className="rounded-lg"
                    >
                      <div
                        className="flex flex-wrap items-center justify-center gap-1"
                        data-preview-qr-tools
                      >
                        <span
                          className={buttonVariants({
                            variant: "ghost",
                            size: "xs",
                            className: "pointer-events-none text-muted-foreground",
                          })}
                        >
                          <Maximize aria-hidden="true" data-icon="inline-start" />
                          放大二维码
                        </span>
                        <span
                          className={buttonVariants({
                            variant: "ghost",
                            size: "xs",
                            className: "pointer-events-none text-muted-foreground",
                          })}
                        >
                          <Download aria-hidden="true" data-icon="inline-start" />
                          保存二维码
                        </span>
                      </div>
                    </PreviewHotspot>
                  )}
                </div>
              )}
            </div>

            {!useTwoColumns && (isUnpaid ? paymentInstructionsBlock : terminalNoteBlock)}

            {!useTwoColumns && !isTerminal && actionsBlock}

            {useTwoColumns && (
              <>
                <div className="col-start-1 row-start-3">{actionsBlock}</div>
                <Separator
                  orientation="vertical"
                  className="col-start-2 row-start-1 row-span-3"
                />
                <div
                  className={cn(
                    "col-start-3 row-start-1",
                    !hasRightFooterNote && "row-span-3",
                  )}
                >
                  {summarySection}
                </div>
                {hasRightFooterNote && (
                  <div className="col-start-3 row-start-2 self-start px-5 pt-0 pb-5">
                    {isUnpaid ? paymentInstructionsBlock : terminalNoteBlock}
                  </div>
                )}
              </>
            )}

            {!useTwoColumns && hasSummaryBody && (
              <>
                <div className="px-4 py-2">
                  <Separator />
                </div>
                {summarySection}
              </>
            )}

            {!useTwoColumns && isTerminal && actionsBlock}
          </div>

          {helpUrl && (
            <div className="flex justify-end">
              <PreviewHotspot
                target="checkout_help_label"
                label="帮助链接文案"
                activeTarget={activeTarget}
                onSelectTarget={onSelectTarget}
                tagAlign="end"
                className="rounded-md"
              >
                <span
                  className="checkout-preview-help-link text-xs text-muted-foreground"
                  data-preview-help-link
                >
                  {helpLabel}
                </span>
              </PreviewHotspot>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
