import { useId } from "react";
import type { SitePolicy } from "@/api/client";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

export function SitePolicyFields({ value, onChange, errors = {} }: { value: SitePolicy; onChange: (value: SitePolicy) => void; errors?: Readonly<Record<string, string>> }) {
  const error = (path: string) => errors["configuration.policy." + path] ?? errors["policy." + path];
  const change = (edit: (next: SitePolicy) => void) => { const next = structuredClone(value); edit(next); onChange(next); };
  return <FieldGroup>
    <FieldSet><FieldLegend>订单设置</FieldLegend>
      <FieldDescription>以下是 PerPay 的网站订单规则。金额占用仍由整个实例统一管理。</FieldDescription>
      <NumberField label="订单有效期（秒）" error={error("orders.order_ttl_seconds")} value={value.orders.order_ttl_seconds} min={60} max={1800} onChange={n => change(p => { p.orders.order_ttl_seconds = n; })} />
      <NumberField label="最大尾差（分）" error={error("orders.amount_offset_maximum_cents")} value={value.orders.amount_offset_maximum_cents} min={1} max={99} onChange={n => change(p => { p.orders.amount_offset_maximum_cents = n; })} />
      <NumberField label="金额复用冷却（秒）" error={error("orders.amount_reuse_cooldown_seconds")} value={value.orders.amount_reuse_cooldown_seconds} min={60} max={3600} onChange={n => change(p => { p.orders.amount_reuse_cooldown_seconds = n; })} />
      <FieldDescription>冷却结束后可再次分配，系统优先使用最小可用尾差；不修改历史订单的冷却期限。</FieldDescription>
      <Field data-invalid={!!error("orders.pending_order_limit")}><FieldLabel>待付款订单上限<Input aria-invalid={!!error("orders.pending_order_limit")} aria-describedby={error("orders.pending_order_limit") ? "site-order-limit-error" : undefined} aria-label="待付款订单上限" type="number" min={1} step={1} value={value.orders.pending_order_limit ?? ""} onChange={e => change(p => { p.orders.pending_order_limit = e.target.value === "" ? null : Number(e.target.value); })} /></FieldLabel><FieldDescription>留空表示不限。这不是预留金额槽位，也不保证收款容量。</FieldDescription>{error("orders.pending_order_limit") && <FieldError id="site-order-limit-error">{error("orders.pending_order_limit")}</FieldError>}</Field>
    </FieldSet>
    <FieldSet><FieldLegend>收银台展示</FieldLegend>
      <SiteTextField label="收银台名称" required maxLength={40} error={error("display.checkout_name")} value={value.display.checkout_name} onChange={text => change(p => { p.display.checkout_name = text; })} />
      <SiteTextField label="帮助链接" type="url" error={error("display.checkout_help_url")} value={value.display.checkout_help_url ?? ""} onChange={text => change(p => { p.display.checkout_help_url = text || null; })} />
      <Field orientation="horizontal"><FieldLabel htmlFor="site-show-product">显示商品名称</FieldLabel><Switch id="site-show-product" checked={value.display.checkout_show_product_name} onCheckedChange={checked => change(p => { p.display.checkout_show_product_name = checked; })} /></Field>
    </FieldSet>
    <FieldSet><FieldLegend>通知投递策略</FieldLegend>
      <NumberField label="通知超时（毫秒）" error={error("notification_delivery.timeout_milliseconds")} value={value.notification_delivery.timeout_milliseconds} min={1000} max={30000} onChange={n => change(p => { p.notification_delivery.timeout_milliseconds = n; })} />
      <NumberField label="最大投递次数" error={error("notification_delivery.maximum_attempts")} value={value.notification_delivery.maximum_attempts} min={1} max={100} onChange={n => change(p => { p.notification_delivery.maximum_attempts = n; })} />
      <NumberField label="基础重试间隔（秒）" error={error("notification_delivery.retry_base_seconds")} value={value.notification_delivery.retry_base_seconds} min={1} max={3600} onChange={n => change(p => { p.notification_delivery.retry_base_seconds = n; })} />
      <NumberField label="最大重试间隔（秒）" error={error("notification_delivery.retry_maximum_seconds")} value={value.notification_delivery.retry_maximum_seconds} min={1} max={86400} onChange={n => change(p => { p.notification_delivery.retry_maximum_seconds = n; })} />
    </FieldSet>
  </FieldGroup>;
}
function NumberField({ label, value, min, max, onChange, error }: { label: string; value: number; min: number; max: number; onChange: (value: number) => void; error?: string | undefined }) {
  const errorId = useId();
  return <Field data-invalid={!!error}><FieldLabel>{label}<Input aria-describedby={error ? errorId : undefined} aria-invalid={!!error} aria-label={label} required type="number" min={min} max={max} step={1} value={Number.isFinite(value) ? value : ""} onChange={e => onChange(e.target.value === "" ? Number.NaN : Number(e.target.value))} /></FieldLabel>{error && <FieldError id={errorId}>{error}</FieldError>}</Field>;
}

export function SiteTextField({ label, value, onChange, error, required, maxLength, type = "text", placeholder }: {
  label: string; value: string; onChange: (value: string) => void; error?: string | undefined;
  required?: boolean; maxLength?: number; type?: "text" | "url"; placeholder?: string;
}) {
  const id = useId(), errorId = id + "-error";
  return <Field data-invalid={!!error}>
    <FieldLabel htmlFor={id}>{label}</FieldLabel>
    <Input id={id} aria-label={label} aria-invalid={!!error} aria-describedby={error ? errorId : undefined}
      value={value} onChange={event => onChange(event.target.value)} type={type} required={required} maxLength={maxLength} placeholder={placeholder} />
    {error && <FieldError id={errorId}>{error}</FieldError>}
  </Field>;
}
