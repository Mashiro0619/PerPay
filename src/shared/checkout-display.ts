export const CHECKOUT_HELP_LABEL_MAX_LENGTH = 24;
export const CHECKOUT_TEXT_MAX_LENGTH = 200;
export const CHECKOUT_TEXT_PATTERN =
  /^[^\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]+$/u;

export const DEFAULT_CHECKOUT_HELP_LABEL = "商家帮助" as const;

export const DEFAULT_CHECKOUT_COPY = Object.freeze({
  paymentInstructionsDesktop:
    "打开支付宝“扫一扫”，严格按 {amount} 付款，切勿修改金额。",
  paymentInstructionsMobileLaunch:
    "点“打开支付宝”或扫码，严格按 {amount} 付款",
  paymentInstructionsMobileScan:
    "保存二维码后用支付宝扫码，严格按 {amount} 付款",
  adjustmentHintDesktop:
    "为自动核对已微调 +{offset}，请按此金额付款，无需改回原价",
  adjustmentHintMobile: "含核对微调 +{offset}，勿改金额",
  confirmedDetail: "",
  expiredDetail:
    "如已完成付款，请点击下方“刷新付款状态”；若仍未确认，请联系商家，勿重复付款。",
  disputedDetail: "请勿重复付款，联系商家核对付款记录即可。",
  closedDetail: "该订单已关闭，请勿继续付款。",
  notFoundDetail: "链接已失效或不完整，请向商家获取新链接。",
});

export interface SiteCheckoutDisplayDefaults {
  readonly checkout_help_label: string | null;
  readonly checkout_show_merchant_order_no: boolean;
  readonly checkout_show_countdown: boolean;
  readonly checkout_show_amount_adjustment: boolean;
  readonly checkout_show_qr_tools: boolean;
  readonly checkout_show_alipay_launch: boolean;
  readonly checkout_show_theme_toggle: boolean;
  readonly checkout_payment_instructions: string | null;
  readonly checkout_adjustment_hint: string | null;
  readonly checkout_notice: string | null;
  readonly checkout_confirmed_detail: string | null;
  readonly checkout_expired_detail: string | null;
  readonly checkout_disputed_detail: string | null;
  readonly checkout_closed_detail: string | null;
}

export const DEFAULT_SITE_CHECKOUT_DISPLAY_EXTRAS: SiteCheckoutDisplayDefaults =
  Object.freeze({
    checkout_help_label: null,
    checkout_show_merchant_order_no: true,
    checkout_show_countdown: true,
    checkout_show_amount_adjustment: true,
    checkout_show_qr_tools: true,
    checkout_show_alipay_launch: true,
    checkout_show_theme_toggle: true,
    checkout_payment_instructions: null,
    checkout_adjustment_hint: null,
    checkout_notice: null,
    checkout_confirmed_detail: null,
    checkout_expired_detail: null,
    checkout_disputed_detail: null,
    checkout_closed_detail: null,
  });

export interface SiteCheckoutDisplay extends SiteCheckoutDisplayDefaults {
  readonly checkout_name: string;
  readonly checkout_help_url: string | null;
  readonly checkout_show_product_name: boolean;
}

export interface PublicCheckoutDisplay {
  readonly name: string;
  readonly help_url: string | null;
  readonly help_label?: string | null;
  readonly show_product_name: boolean;
  readonly show_merchant_order_no?: boolean;
  readonly show_countdown?: boolean;
  readonly show_amount_adjustment?: boolean;
  readonly show_qr_tools?: boolean;
  readonly show_alipay_launch?: boolean;
  readonly show_theme_toggle?: boolean;
  readonly payment_instructions?: string | null;
  readonly adjustment_hint?: string | null;
  readonly notice?: string | null;
  readonly confirmed_detail?: string | null;
  readonly expired_detail?: string | null;
  readonly disputed_detail?: string | null;
  readonly closed_detail?: string | null;
}

export interface ResolvedCheckoutDisplay {
  readonly name: string;
  readonly help_url: string | null;
  readonly help_label: string;
  readonly show_product_name: boolean;
  readonly show_merchant_order_no: boolean;
  readonly show_countdown: boolean;
  readonly show_amount_adjustment: boolean;
  readonly show_qr_tools: boolean;
  readonly show_alipay_launch: boolean;
  readonly show_theme_toggle: boolean;
  readonly payment_instructions: string | null;
  readonly adjustment_hint: string | null;
  readonly notice: string | null;
  readonly confirmed_detail: string | null;
  readonly expired_detail: string | null;
  readonly disputed_detail: string | null;
  readonly closed_detail: string | null;
}

export function normalizeCheckoutOptionalText(
  value: unknown,
  maxLength = CHECKOUT_TEXT_MAX_LENGTH,
): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (Array.from(trimmed).length > maxLength) return undefined;
  if (!CHECKOUT_TEXT_PATTERN.test(trimmed)) return undefined;
  return trimmed;
}

export function formatCheckoutTemplate(
  template: string,
  variables: { readonly amount?: string; readonly offset?: string },
): string {
  let result = template;
  if (variables.amount !== undefined) {
    result = result.replaceAll("{amount}", variables.amount);
  }
  if (variables.offset !== undefined) {
    result = result.replaceAll("{offset}", variables.offset);
  }
  return result;
}

export function resolveCheckoutDisplay(
  display?: PublicCheckoutDisplay | null,
  fallback?: {
    readonly systemName?: string | undefined;
    readonly helpUrl?: string | null | undefined;
    readonly showProductName?: boolean | undefined;
  },
): ResolvedCheckoutDisplay {
  return {
    name: display?.name ?? fallback?.systemName ?? "PerPay",
    help_url: display ? display.help_url : (fallback?.helpUrl ?? null),
    help_label: display?.help_label ?? DEFAULT_CHECKOUT_HELP_LABEL,
    show_product_name:
      display?.show_product_name ?? (fallback?.showProductName !== false),
    show_merchant_order_no: display?.show_merchant_order_no ?? true,
    show_countdown: display?.show_countdown ?? true,
    show_amount_adjustment: display?.show_amount_adjustment ?? true,
    show_qr_tools: display?.show_qr_tools ?? true,
    show_alipay_launch: display?.show_alipay_launch ?? true,
    show_theme_toggle: display?.show_theme_toggle ?? true,
    payment_instructions: display?.payment_instructions ?? null,
    adjustment_hint: display?.adjustment_hint ?? null,
    notice: display?.notice ?? null,
    confirmed_detail: display?.confirmed_detail ?? null,
    expired_detail: display?.expired_detail ?? null,
    disputed_detail: display?.disputed_detail ?? null,
    closed_detail: display?.closed_detail ?? null,
  };
}

export function siteDisplayToPublic(
  display: SiteCheckoutDisplay,
): PublicCheckoutDisplay {
  return {
    name: display.checkout_name,
    help_url: display.checkout_help_url,
    help_label: display.checkout_help_label,
    show_product_name: display.checkout_show_product_name,
    show_merchant_order_no: display.checkout_show_merchant_order_no,
    show_countdown: display.checkout_show_countdown,
    show_amount_adjustment: display.checkout_show_amount_adjustment,
    show_qr_tools: display.checkout_show_qr_tools,
    show_alipay_launch: display.checkout_show_alipay_launch,
    show_theme_toggle: display.checkout_show_theme_toggle,
    payment_instructions: display.checkout_payment_instructions,
    adjustment_hint: display.checkout_adjustment_hint,
    notice: display.checkout_notice,
    confirmed_detail: display.checkout_confirmed_detail,
    expired_detail: display.checkout_expired_detail,
    disputed_detail: display.checkout_disputed_detail,
    closed_detail: display.checkout_closed_detail,
  };
}
