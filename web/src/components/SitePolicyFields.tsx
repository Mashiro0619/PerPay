import { useEffect, useRef, useState } from "react";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { useId } from "react";
import type { SitePolicy } from "@/api/client";
import { integerUnits, siteTimeoutError, siteTimeoutSeconds } from "@/lib/site-timeout";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

export function SitePolicyFields({
  value,
  onChange,
  errors = {},
  section,
  disabled = false,
  secondsDraft,
  onSecondsDraftChange,
}: {
  section?: string | undefined;
  disabled?: boolean;
  value: SitePolicy;
  onChange: (value: SitePolicy) => void;
  errors?: Readonly<Record<string, string>>;
  secondsDraft?: string;
  onSecondsDraftChange?: (raw: string) => void;
}) {
  const limitId = useId();
  const timeoutId = useId();
  const timeoutRaw = secondsDraft ?? siteTimeoutSeconds(value.notification_delivery.timeout_milliseconds);
  const timeoutError = siteTimeoutError(timeoutRaw) ??
    errors["configuration.policy.notification_delivery.timeout_milliseconds"] ??
    errors["policy.notification_delivery.timeout_milliseconds"];
  const [advanced, setAdvanced] = useState(false);
  const content = useRef<HTMLDivElement>(null);
  const failedAdvanced = Object.keys(errors).some((key) =>
    key.includes("notification_delivery."),
  );
  useEffect(() => {
    if (failedAdvanced) setAdvanced(true);
  }, [errors, failedAdvanced]);
  useEffect(() => {
    if (advanced && failedAdvanced)
      content.current
        ?.querySelector<HTMLElement>('[aria-invalid="true"]')
        ?.focus();
  }, [advanced, failedAdvanced, errors]);
  const error = (path: string) =>
    errors["configuration.policy." + path] ?? errors["policy." + path];
  const change = (edit: (next: SitePolicy) => void) => {
    if (disabled) return;
    const next = structuredClone(value);
    edit(next);
    onChange(next);
  };
  return (
    <FieldGroup>
      {(!section || section === "orders") && (
        <FieldSet className="settings-fields" disabled={disabled}>
          <FieldLegend className={section ? "sr-only" : undefined}>订单设置</FieldLegend>
          <NumberField
            label="订单有效期（秒）"
            error={error("orders.order_ttl_seconds")}
            value={value.orders.order_ttl_seconds}
            min={60}
            max={1800}
            onChange={(n) =>
              change((p) => {
                p.orders.order_ttl_seconds = n;
              })
            }
          />
          <NumberField
            label="最大尾差（分）"
            error={error("orders.amount_offset_maximum_cents")}
            value={value.orders.amount_offset_maximum_cents}
            min={1}
            max={99}
            onChange={(n) =>
              change((p) => {
                p.orders.amount_offset_maximum_cents = n;
              })
            }
          />
          <NumberField
            label="金额复用冷却（秒）"
            hint="冷却结束后优先复用最小尾差；历史订单期限不变。"
            error={error("orders.amount_reuse_cooldown_seconds")}
            value={value.orders.amount_reuse_cooldown_seconds}
            min={60}
            max={3600}
            onChange={(n) =>
              change((p) => {
                p.orders.amount_reuse_cooldown_seconds = n;
              })
            }
          />

          <Field data-invalid={!!error("orders.pending_order_limit")}>
            <FieldLabel htmlFor={limitId}>待付款订单上限</FieldLabel>
            <Input
              id={limitId}
              aria-invalid={!!error("orders.pending_order_limit")}
              aria-describedby={
                error("orders.pending_order_limit")
                  ? limitId + "-error"
                  : undefined
              }
              aria-label="待付款订单上限"
              type="number"
              min={1}
              step={1}
              value={value.orders.pending_order_limit ?? ""}
              onChange={(e) =>
                change((p) => {
                  p.orders.pending_order_limit =
                    e.target.value === "" ? null : Number(e.target.value);
                })
              }
            />
            <FieldDescription>留空不限。</FieldDescription>
            {error("orders.pending_order_limit") && (
              <FieldError id={limitId + "-error"}>
                {error("orders.pending_order_limit")}
              </FieldError>
            )}
          </Field>
        </FieldSet>
      )}
      {(!section || section === "display") && (
        <FieldSet disabled={disabled}>
          <FieldLegend className={section ? "sr-only" : undefined}>收银台展示</FieldLegend>
          <SiteTextField
            label="收银台名称"
            required
            maxLength={40}
            error={error("display.checkout_name")}
            value={value.display.checkout_name}
            onChange={(text) =>
              change((p) => {
                p.display.checkout_name = text;
              })
            }
          />
          <SiteTextField
            label="帮助链接"
            type="url"
            error={error("display.checkout_help_url")}
            value={value.display.checkout_help_url ?? ""}
            onChange={(text) =>
              change((p) => {
                p.display.checkout_help_url = text || null;
              })
            }
          />
          <Field orientation="horizontal" data-disabled={disabled}>
            <FieldLabel htmlFor="site-show-product">显示商品名称</FieldLabel>
            <Switch
              id="site-show-product"
              disabled={disabled}
              checked={value.display.checkout_show_product_name}
              onCheckedChange={(checked) =>
                change((p) => {
                  p.display.checkout_show_product_name = checked;
                })
              }
            />
          </Field>
        </FieldSet>
      )}
      {(!section || section === "integration") && (
        <Collapsible
          open={advanced}
          onOpenChange={setAdvanced}
          onInvalidCapture={(event) => {
            const target = event.target as HTMLElement;
            setAdvanced(true);
            requestAnimationFrame(() => target.focus());
          }}
        >
          <CollapsibleTrigger
            render={<Button type="button" variant="outline" />}
          >
            高级设置
          </CollapsibleTrigger>
          <CollapsibleContent ref={content} keepMounted>
            <FieldSet className="settings-fields pt-4" disabled={disabled}>
              <FieldLegend className="sr-only">通知投递策略</FieldLegend>
              <Field data-invalid={!!timeoutError}>
                <FieldLabel htmlFor={timeoutId}>通知超时（秒）</FieldLabel>
                <Input
                  id={timeoutId}
                  aria-label="通知超时（秒）"
                  aria-invalid={!!timeoutError}
                  aria-describedby={timeoutError ? timeoutId + "-error" : undefined}
                  type="number"
                  inputMode="decimal"
                  min={1}
                  max={30}
                  step={0.001}
                  required
                  value={timeoutRaw}
                  onChange={(event) => {
                    if (disabled) return;
                    const raw = event.target.value;
                    onSecondsDraftChange?.(raw);
                    if (siteTimeoutError(raw)) return;
                    const milliseconds = integerUnits(raw, 1000)!;
                    change((p) => {
                      p.notification_delivery.timeout_milliseconds = milliseconds;
                    });
                  }}
                />
                {timeoutError && <FieldError id={timeoutId + "-error"}>{timeoutError}</FieldError>}
              </Field>
              <NumberField
                label="最多发送次数"
                error={error("notification_delivery.maximum_attempts")}
                value={value.notification_delivery.maximum_attempts}
                min={1}
                max={100}
                onChange={(n) =>
                  change((p) => {
                    p.notification_delivery.maximum_attempts = n;
                  })
                }
              />
              <NumberField
                label="首次重试间隔（秒）"
                error={error("notification_delivery.retry_base_seconds")}
                value={value.notification_delivery.retry_base_seconds}
                min={1}
                max={3600}
                onChange={(n) =>
                  change((p) => {
                    p.notification_delivery.retry_base_seconds = n;
                  })
                }
              />
              <NumberField
                label="最大重试间隔（秒）"
                error={error("notification_delivery.retry_maximum_seconds")}
                value={value.notification_delivery.retry_maximum_seconds}
                min={1}
                max={86400}
                onChange={(n) =>
                  change((p) => {
                    p.notification_delivery.retry_maximum_seconds = n;
                  })
                }
              />
            </FieldSet>
          </CollapsibleContent>
        </Collapsible>
      )}
    </FieldGroup>
  );
}
function NumberField({
  label,
  value,
  min,
  max,
  onChange,
  error,
  hint,
}: {
  hint?: string;
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  error?: string | undefined;
}) {
  const errorId = useId(),
    inputId = errorId + "-input";
  return (
    <Field data-invalid={!!error}>
      <FieldLabel htmlFor={inputId}>{label}</FieldLabel>
      <Input
        id={inputId}
        aria-describedby={
          [hint && errorId + "-hint", error && errorId]
            .filter(Boolean)
            .join(" ") || undefined
        }
        aria-invalid={!!error}
        aria-label={label}
        required
        type="number"
        min={min}
        max={max}
        step={1}
        value={Number.isFinite(value) ? value : ""}
        onChange={(e) =>
          onChange(e.target.value === "" ? Number.NaN : Number(e.target.value))
        }
      />
      {hint && (
        <FieldDescription id={errorId + "-hint"}>{hint}</FieldDescription>
      )}
      {error && <FieldError id={errorId}>{error}</FieldError>}
    </Field>
  );
}

export function SiteTextField({
  label,
  value,
  onChange,
  error,
  required,
  maxLength,
  type = "text",
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string | undefined;
  required?: boolean;
  maxLength?: number;
  type?: "text" | "url";
  placeholder?: string;
}) {
  const id = useId(),
    errorId = id + "-error";
  return (
    <Field
      className={type === "text" ? "max-w-md" : undefined}
      data-invalid={!!error}
    >
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        aria-label={label}
        aria-invalid={!!error}
        aria-describedby={error ? errorId : undefined}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        type={type}
        required={required}
        maxLength={maxLength}
        placeholder={placeholder}
      />
      {error && <FieldError id={errorId}>{error}</FieldError>}
    </Field>
  );
}
