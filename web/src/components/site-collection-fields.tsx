import { useId } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  alipayAccountsQuery,
  type AlipayAccount,
  type SiteCollection,
} from "@/lib/alipay-accounts";
import { Link } from "@/navigation";
import { QueryView } from "@/components/request-state";
import { buttonVariants } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const modes = [
  ["FIXED", "指定账号"],
  ["RANDOM", "随机"],
  ["WEIGHTED", "按权重"],
] as const;

export function SiteCollectionFields({
  value,
  onChange,
  disabled,
  error,
}: {
  value: SiteCollection;
  onChange: (value: SiteCollection) => void;
  disabled?: boolean;
  error?: string | undefined;
}) {
  const accounts = useQuery(alipayAccountsQuery);
  return (
    <FieldSet disabled={disabled}>
      <FieldLegend>收款账号</FieldLegend>
      <FieldDescription>
        每笔新订单按此规则分配账号。已创建订单继续使用原账号和收款码。
      </FieldDescription>
      <QueryView query={accounts}>
        {({ data }) => (
          <CollectionChoices
            accounts={data}
            value={value}
            onChange={onChange}
            disabled={disabled}
            error={error}
          />
        )}
      </QueryView>
    </FieldSet>
  );
}

export function CollectionChoices({
  accounts,
  value,
  onChange,
  disabled,
  error,
}: {
  accounts: readonly AlipayAccount[];
  value: SiteCollection;
  onChange: (value: SiteCollection) => void;
  disabled?: boolean;
  error?: string | undefined;
}) {
  const id = useId();
  const available = accounts.filter(
    (account) => account.enabled && account.configured,
  );
  const selected = new Set(value.accounts.map((account) => account.account_id));
  const choices = accounts.filter(
    (account) => selected.has(account.id) || available.includes(account),
  );
  const total = value.accounts.reduce(
    (sum, account) => sum + (account.weight ?? 1),
    0,
  );
  function setMode(mode: SiteCollection["mode"]) {
    onChange({
      mode,
      accounts:
        mode === "FIXED"
          ? value.accounts
              .slice(0, 1)
              .map((account) => ({ ...account, weight: 1 }))
          : value.accounts,
    });
  }
  return (
    <FieldGroup>
      <Field data-invalid={!!error}>
        <FieldLabel id={id + "-mode"}>分配方式</FieldLabel>
        <ToggleGroup
          value={[value.mode]}
          onValueChange={(values) => {
            const next = values[0];
            if (next === "FIXED" || next === "RANDOM" || next === "WEIGHTED")
              setMode(next);
          }}
          variant="outline"
          disabled={disabled}
          aria-labelledby={id + "-mode"}
        >
          {modes.map(([mode, label]) => (
            <ToggleGroupItem key={mode} value={mode}>
              {label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <FieldDescription>
          {value.mode === "FIXED"
            ? "仅使用指定账号，暂不可用时不会切换。"
            : value.mode === "RANDOM"
              ? "从选中且可用的账号中等概率分配。"
              : "权重越大，分配新订单的机会越多。暂不可用的账号会跳过。"}
        </FieldDescription>
        {error && <FieldError>{error}</FieldError>}
      </Field>
      {value.mode === "FIXED" ? (
        <Field>
          <FieldLabel htmlFor={id + "-account"}>支付宝账号</FieldLabel>
          <Select
            value={value.accounts[0]?.account_id ?? ""}
            onValueChange={(accountId) =>
              onChange({
                ...value,
                accounts: accountId
                  ? [{ account_id: accountId, weight: 1 }]
                  : [],
              })
            }
            items={choices.map((account) => ({
              value: account.id,
              label: account.name,
            }))}
            disabled={disabled}
          >
            <SelectTrigger
              id={id + "-account"}
              className="w-full"
              aria-invalid={!!error}
            >
              <SelectValue placeholder="请选择收款账号" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {choices.map((account) => (
                  <SelectItem
                    key={account.id}
                    value={account.id}
                    disabled={!account.enabled || !account.configured}
                  >
                    {account.name}
                    {!account.configured
                      ? "（配置未完成）"
                      : !account.enabled
                        ? "（已暂停）"
                        : ""}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
      ) : (
        <FieldSet>
          <FieldLegend variant="label">参与分配的账号</FieldLegend>
          <div className="flex flex-col divide-y rounded-lg border px-3">
            {choices.map((account) => {
              const candidate = value.accounts.find(
                (item) => item.account_id === account.id,
              );
              const checkboxId = id + "-" + account.id;
              const percent =
                candidate && total > 0
                  ? ((candidate.weight ?? 1) / total) * 100
                  : 0;
              return (
                <div
                  key={account.id}
                  className="flex min-w-0 flex-wrap items-center gap-3 py-3"
                >
                  <Field orientation="horizontal" className="min-w-0 flex-1">
                    <Checkbox
                      id={checkboxId}
                      checked={selected.has(account.id)}
                      disabled={
                        disabled ||
                        (!selected.has(account.id) &&
                          (!account.enabled || !account.configured))
                      }
                      onCheckedChange={(checked) =>
                        onChange({
                          ...value,
                          accounts: checked
                            ? [
                                ...value.accounts,
                                { account_id: account.id, weight: 1 },
                              ]
                            : value.accounts.filter(
                                (item) => item.account_id !== account.id,
                              ),
                        })
                      }
                    />
                    <FieldLabel
                      htmlFor={checkboxId}
                      className="min-w-0 break-words"
                    >
                      {account.name}
                      {!account.enabled
                        ? "（已暂停）"
                        : !account.configured
                          ? "（配置未完成）"
                          : ""}
                    </FieldLabel>
                  </Field>
                  {candidate && value.mode === "WEIGHTED" && (
                    <Field orientation="horizontal" className="w-auto">
                      <FieldLabel
                        htmlFor={checkboxId + "-weight"}
                        className="sr-only"
                      >
                        {account.name}权重
                      </FieldLabel>
                      <Input
                        id={checkboxId + "-weight"}
                        className="w-20"
                        type="number"
                        inputMode="numeric"
                        min={1}
                        max={1_000_000}
                        step={1}
                        required
                        value={candidate.weight ?? 1}
                        disabled={disabled}
                        onChange={(event) =>
                          onChange({
                            ...value,
                            accounts: value.accounts.map((item) =>
                              item.account_id === account.id
                                ? {
                                    ...item,
                                    weight: Number(event.currentTarget.value),
                                  }
                                : item,
                            ),
                          })
                        }
                      />
                      <span
                        className="w-14 text-right text-sm text-muted-foreground tabular-nums"
                        aria-label={account.name + "分配比例"}
                      >
                        {percent.toFixed(1)}%
                      </span>
                    </Field>
                  )}
                </div>
              );
            })}
          </div>
        </FieldSet>
      )}
      {available.length === 0 && (
        <FieldDescription>
          还没有可用于新订单的账号。先完成账号配置并启用，再分配给网站。
        </FieldDescription>
      )}
      <div>
        <Link
          to="/settings/accounts"
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          管理支付宝账号
        </Link>
      </div>
    </FieldGroup>
  );
}
