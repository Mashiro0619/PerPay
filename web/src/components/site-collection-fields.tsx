import { useId } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  accountChoiceLabel,
  accountState,
  alipayAccountsQuery,
  type AlipayAccount,
  type SiteCollection,
} from "@/lib/alipay-accounts";
import { count } from "@/lib/format";
import { Link } from "@/navigation";
import { ErrorNotice, Loading } from "@/components/request-state";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item";
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
  ["RANDOM", "随机分配"],
  ["WEIGHTED", "按权重分配"],
] as const;

function collectionAvailability(account: AlipayAccount): string {
  if (account.environment !== "PRODUCTION" || !account.enabled || !account.configured) return accountState(account);
  if (!account.health) return "已配置，收款状态待确认";
  return account.health.collection_ready ? "当前可收款" : "暂不可收款";
}

export function SiteCollectionFields({
  value,
  onChange,
  disabled,
  error,
  hideHeading = false,
}: {
  value: SiteCollection;
  onChange: (value: SiteCollection) => void;
  disabled?: boolean;
  error?: string | undefined;
  hideHeading?: boolean;
}) {
  const accounts = useQuery(alipayAccountsQuery);
  const catalog = new Map(accounts.data?.data.map((account) => [account.id, account]) ?? []);
  const current = accounts.isSuccess && !accounts.isFetching && !accounts.isPaused;
  const configured = value.accounts;
  return (
    <FieldSet disabled={disabled}>
      {!hideHeading && (
        <>
          <FieldLegend>收款账号</FieldLegend>
          <FieldDescription>
            每笔新订单按此规则分配账号。已创建订单继续使用原账号和收款码。
          </FieldDescription>
        </>
      )}
      {accounts.isError && (
        <ErrorNotice
          error={accounts.error}
          retry={() => {
            void accounts.refetch();
          }}
          retainedData={configured.length > 0 || !!accounts.data}
        />
      )}
      {accounts.isError && configured.length > 0 && (
        <p className="text-xs text-muted-foreground">
          以下保留已保存的账号分配；当前账号资料与可用状态未确认。
        </p>
      )}
      {accounts.isPending && configured.length === 0 ? (
        <Loading label="正在读取收款账号…" />
      ) : accounts.data ? (
        <CollectionChoices
          accounts={accounts.data.data}
          value={value}
          onChange={onChange}
          disabled={disabled}
          error={error}
        />
      ) : null}
      {configured.length > 0 && (
        <div className="flex min-w-0 flex-col gap-2 pt-1" data-site-collection-summary>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-muted-foreground">当前已分配账号状态</span>
            {accounts.isPaused ? (
              <span role="status" className="text-xs text-muted-foreground">等待网络恢复，账号可用状态未确认。</span>
            ) : accounts.isFetching ? (
              <span role="status" className="text-xs text-muted-foreground">正在同步账号状态…</span>
            ) : null}
          </div>
          <ItemGroup aria-label="已分配收款账号" className="gap-2">
            {configured.map((selected) => {
              const account = catalog.get(selected.account_id);
              const status = !current
                ? "可用状态待确认"
                : account
                  ? collectionAvailability(account)
                  : "账号不存在或已删除，请核对历史配置";
              const ready = status === "当前可收款";
              return (
                <Item key={selected.account_id} size="xs" role="listitem" className="settings-collection-card">
                  <ItemContent className="min-w-0 gap-1">
                    <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                      <ItemTitle className="line-clamp-none wrap-anywhere">
                        {account?.name ?? selected.account_id}
                      </ItemTitle>
                      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                        <Badge variant={ready ? "success" : "outline"}>{status}</Badge>
                        {value.mode === "WEIGHTED" && (
                          <Badge variant="secondary" className="tabular-nums">
                            权重 {count(selected.weight ?? 1)}
                          </Badge>
                        )}
                      </div>
                    </div>
                    {account && (
                      <ItemDescription className="line-clamp-none font-mono text-xs wrap-anywhere">
                        账号 ID：{selected.account_id}
                      </ItemDescription>
                    )}
                  </ItemContent>
                </Item>
              );
            })}
          </ItemGroup>
        </div>
      )}
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
    (account) => account.environment === "PRODUCTION" && account.enabled && account.configured,
  );
  const selected = new Set(value.accounts.map((account) => account.account_id));
  const choices = accounts.filter(
    (account) => selected.has(account.id) || available.includes(account),
  );
  const labels = new Map(choices.map(account => [account.id, accountChoiceLabel(account, choices)]));
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
              label: labels.get(account.id)!,
            }))}
            disabled={disabled}
          >
            <SelectTrigger
              id={id + "-account"}
              className="w-full min-w-0 whitespace-normal data-[size=default]:h-auto data-[size=default]:min-h-8 *:data-[slot=select-value]:line-clamp-none *:data-[slot=select-value]:block"
              aria-invalid={!!error}
            >
              <SelectValue className="min-w-0 whitespace-normal wrap-anywhere" placeholder="请选择收款账号" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {choices.map((account) => (
                  <SelectItem
                    key={account.id}
                    value={account.id}
                    className="*:min-w-0 *:shrink"
                    disabled={!account.enabled || !account.configured}
                  >
                    <span className="min-w-0 whitespace-normal wrap-anywhere">
                      {labels.get(account.id)}
                      {!account.configured
                        ? "（配置未完成）"
                        : !account.enabled
                          ? "（已暂停）"
                          : ""}
                    </span>
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
                      className="min-w-0 wrap-anywhere"
                    >
                      {labels.get(account.id)}
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
                        {labels.get(account.id)}权重
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
                        aria-label={labels.get(account.id) + "分配比例"}
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
