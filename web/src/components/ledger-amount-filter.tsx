import { useEffect, useId, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { ledgerAmountInput, parseLedgerAmount, validateLedgerAmountRange } from "@/lib/ledger-filters";
import type { ListQueryControl } from "@/lib/list-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/admin-dialog";
import { useListFilterPanel } from "@/components/list-filter-context";

type LedgerAmountFilterProps = { control: ListQueryControl; searchParams?: URLSearchParams };

export function LedgerAmountFilter(props: LedgerAmountFilterProps) {
  const inline = useListFilterPanel();
  return inline ? <InlineLedgerAmountFilter {...props} /> : <LedgerAmountDialogFilter {...props} />;
}

function validateAmounts(minimum: string, maximum: string) {
  let min: number | undefined, max: number | undefined;
  let minError = "", maxError = "";
  try { min = parseLedgerAmount(minimum); }
  catch (reason) { minError = reason instanceof Error ? reason.message : "金额范围无效。"; }
  try { max = parseLedgerAmount(maximum); }
  catch (reason) { maxError = reason instanceof Error ? reason.message : "金额范围无效。"; }
  if (minError || maxError)
    return { min, max, error: minError || maxError, minError, maxError };
  try {
    validateLedgerAmountRange(min, max);
    return { min, max, error: "", minError: "", maxError: "" };
  } catch (reason) {
    const error = reason instanceof Error ? reason.message : "金额范围无效。";
    return { min, max, error, minError: error, maxError: error };
  }
}

function InlineLedgerAmountFilter({ control, searchParams }: LedgerAmountFilterProps) {
  const [urlSearch] = useSearchParams();
  const search = searchParams ?? urlSearch;
  const [minimum, setMinimum] = useState(() => ledgerAmountInput(search.get("min_amount_cents")));
  const [maximum, setMaximum] = useState(() => ledgerAmountInput(search.get("max_amount_cents")));
  const minInput = useRef<HTMLInputElement>(null);
  const maxInput = useRef<HTMLInputElement>(null);
  const id = useId();
  const { error, minError, maxError } = validateAmounts(minimum, maximum);
  useEffect(() => {
    minInput.current?.setCustomValidity(minError);
    maxInput.current?.setCustomValidity(maxError);
  }, [minError, maxError]);

  function stage(nextMinimum: string, nextMaximum: string) {
    const { min, max, error } = validateAmounts(nextMinimum, nextMaximum);
    if (error) return;
    control.update({ min_amount_cents: min === undefined ? null : String(min), max_amount_cents: max === undefined ? null : String(max) });
  }

  return (
    <FieldSet className="min-w-0" data-list-inline-amount>
      <FieldLegend variant="label">金额范围</FieldLegend>
      <FieldDescription id={id + "-description"}>最多两位小数，留空不限。</FieldDescription>
      <FieldGroup>
        <Field data-invalid={!!minError}>
          <FieldLabel htmlFor={id + "-min"}>最低金额（元）</FieldLabel>
          <Input
            ref={minInput}
            id={id + "-min"}
            inputMode="decimal"
            autoComplete="off"
            placeholder="不限"
            value={minimum}
            maxLength={24}
            onChange={event => {
              setMinimum(event.target.value);
              stage(event.target.value, maximum);
            }}
            aria-invalid={!!minError}
            aria-describedby={id + "-description" + (error ? " " + id + "-error" : "")}
          />
        </Field>
        <Field data-invalid={!!maxError}>
          <FieldLabel htmlFor={id + "-max"}>最高金额（元）</FieldLabel>
          <Input
            ref={maxInput}
            id={id + "-max"}
            inputMode="decimal"
            autoComplete="off"
            placeholder="不限"
            value={maximum}
            maxLength={24}
            onChange={event => {
              setMaximum(event.target.value);
              stage(minimum, event.target.value);
            }}
            aria-invalid={!!maxError}
            aria-describedby={id + "-description" + (error ? " " + id + "-error" : "")}
          />
        </Field>
        {error && <FieldError id={id + "-error"}>{error}</FieldError>}
      </FieldGroup>
    </FieldSet>
  );
}

function LedgerAmountDialogFilter({ control, searchParams }: LedgerAmountFilterProps) {
  const [urlSearch] = useSearchParams();
  const search = searchParams ?? urlSearch;
  const [open, setOpen] = useState(false);
  const [minimum, setMinimum] = useState("");
  const [maximum, setMaximum] = useState("");
  const [error, setError] = useState("");
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const active = search.has("min_amount_cents") || search.has("max_amount_cents");
  function changeOpen(value: boolean) {
    if (value) {
      setMinimum(ledgerAmountInput(search.get("min_amount_cents")));
      setMaximum(ledgerAmountInput(search.get("max_amount_cents")));
      setError("");
    }
    setOpen(value);
  }
  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger render={<Button ref={trigger} variant="outline" size="sm" />} aria-label={active ? "金额范围，已筛选" : "金额范围"}>
        金额范围{active ? " · 已筛选" : ""}
      </DialogTrigger>
      <DialogContent finalFocus={trigger}>
        <DialogHeader>
          <DialogTitle>金额范围</DialogTitle>
        </DialogHeader>
        <form className="contents" onSubmit={event => {
          event.preventDefault();
          try {
            const min = parseLedgerAmount(minimum), max = parseLedgerAmount(maximum);
            validateLedgerAmountRange(min, max);
            control.update({ min_amount_cents: min === undefined ? null : String(min), max_amount_cents: max === undefined ? null : String(max) });
            setOpen(false);
          } catch (reason) { setError(reason instanceof Error ? reason.message : "金额范围无效。"); }
        }}>
          <DialogBody>
            <DialogDescription>最多两位小数，留空不限。</DialogDescription>
            <FieldGroup>
              <Field data-invalid={!!error}>
                <FieldLabel htmlFor={id + "-min"}>最低金额（元）</FieldLabel>
                <Input id={id + "-min"} inputMode="decimal" autoComplete="off" placeholder="不限" value={minimum} maxLength={24} onChange={event => { setMinimum(event.target.value); setError(""); }} aria-invalid={!!error} aria-describedby={error ? id + "-error" : undefined} />
              </Field>
              <Field data-invalid={!!error}>
                <FieldLabel htmlFor={id + "-max"}>最高金额（元）</FieldLabel>
                <Input id={id + "-max"} inputMode="decimal" autoComplete="off" placeholder="不限" value={maximum} maxLength={24} onChange={event => { setMaximum(event.target.value); setError(""); }} aria-invalid={!!error} aria-describedby={error ? id + "-error" : undefined} />
              </Field>
              {error && <FieldError id={id + "-error"}>{error}</FieldError>}
            </FieldGroup>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>取消</Button>
            <Button type="submit">应用金额</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
