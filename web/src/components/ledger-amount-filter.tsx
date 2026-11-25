import { useEffect, useId, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { ledgerAmountInput, parseLedgerAmount, validateLedgerAmountRange } from "@/lib/ledger-filters";
import type { ListQueryControl } from "@/lib/list-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { useListFilterPanel } from "@/components/list-filter-context";

type LedgerAmountFilterProps = { control: ListQueryControl; searchParams?: URLSearchParams };

export function LedgerAmountFilter(props: LedgerAmountFilterProps) {
  const inline = useListFilterPanel();
  return inline ? <InlineLedgerAmountFilter {...props} /> : <LedgerAmountDialogFilter {...props} />;
}

function validateAmounts(minimum: string, maximum: string) {
  let min: number | undefined, max: number | undefined;
  let minFieldError = "", maxFieldError = "";
  try { min = parseLedgerAmount(minimum); }
  catch (reason) { minFieldError = reason instanceof Error ? reason.message : "金额范围无效。"; }
  try { max = parseLedgerAmount(maximum); }
  catch (reason) { maxFieldError = reason instanceof Error ? reason.message : "金额范围无效。"; }
  if (minFieldError || maxFieldError)
    return {
      min,
      max,
      error: minFieldError || maxFieldError,
      minFieldError,
      maxFieldError,
      rangeError: "",
    };
  try {
    validateLedgerAmountRange(min, max);
    return { min, max, error: "", minFieldError: "", maxFieldError: "", rangeError: "" };
  } catch (reason) {
    const error = reason instanceof Error ? reason.message : "金额范围无效。";
    return { min, max, error, minFieldError: "", maxFieldError: "", rangeError: error };
  }
}

function InlineLedgerAmountFilter({ control, searchParams }: LedgerAmountFilterProps) {
  const [urlSearch] = useSearchParams();
  const search = searchParams ?? urlSearch;
  const [minimum, setMinimum] = useState(() => ledgerAmountInput(search.get("min_amount_cents")));
  const [maximum, setMaximum] = useState(() => ledgerAmountInput(search.get("max_amount_cents")));
  const [touched, setTouched] = useState({ min: false, max: false });
  const [submitted, setSubmitted] = useState(false);
  const minInput = useRef<HTMLInputElement>(null);
  const maxInput = useRef<HTMLInputElement>(null);
  const id = useId();
  const raw = validateAmounts(minimum, maximum);
  const showRangeError = Boolean(raw.rangeError) && ((touched.min && touched.max) || submitted);
  const minError = (touched.min ? raw.minFieldError : "") || (showRangeError ? raw.rangeError : "");
  const maxError = (touched.max ? raw.maxFieldError : "") || (showRangeError ? raw.rangeError : "");
  const error = minError || maxError;
  useEffect(() => {
    minInput.current?.setCustomValidity(raw.minFieldError || raw.rangeError);
    maxInput.current?.setCustomValidity(raw.maxFieldError || raw.rangeError);
  }, [raw.minFieldError, raw.maxFieldError, raw.rangeError]);

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
            name="min_amount"
            inputMode="decimal"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="不限"
            value={minimum}
            maxLength={24}
            onBlur={() => setTouched(current => ({ ...current, min: true }))}
            onInvalid={() => {
              setSubmitted(true);
              setTouched({ min: true, max: true });
            }}
            onChange={event => {
              const next = event.target.value;
              setMinimum(next);
              const nextValidation = validateAmounts(next, maximum);
              if (!nextValidation.error) setSubmitted(false);
              if (!nextValidation.minFieldError && !nextValidation.rangeError) {
                setTouched(current => ({ ...current, min: false }));
              }
              stage(next, maximum);
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
            name="max_amount"
            inputMode="decimal"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="不限"
            value={maximum}
            maxLength={24}
            onBlur={() => setTouched(current => ({ ...current, max: true }))}
            onInvalid={() => {
              setSubmitted(true);
              setTouched({ min: true, max: true });
            }}
            onChange={event => {
              const next = event.target.value;
              setMaximum(next);
              const nextValidation = validateAmounts(minimum, next);
              if (!nextValidation.error) setSubmitted(false);
              if (!nextValidation.maxFieldError && !nextValidation.rangeError) {
                setTouched(current => ({ ...current, max: false }));
              }
              stage(minimum, next);
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
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger render={<Button ref={trigger} variant="outline" size="sm" />} aria-label={active ? "金额范围，已筛选" : "金额范围"}>
        金额范围{active ? " · 已筛选" : ""}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-72 max-w-[calc(100dvw-2rem)] max-h-[min(28rem,var(--available-height,calc(100dvh-2rem)))] overflow-y-auto overscroll-contain gap-3"
        finalFocus={trigger}
      >
        <PopoverHeader>
          <PopoverTitle>金额范围</PopoverTitle>
          <PopoverDescription>最多两位小数，留空不限。</PopoverDescription>
        </PopoverHeader>
        <form className="flex flex-col gap-3" onSubmit={event => {
          event.preventDefault();
          try {
            const min = parseLedgerAmount(minimum), max = parseLedgerAmount(maximum);
            validateLedgerAmountRange(min, max);
            control.update({ min_amount_cents: min === undefined ? null : String(min), max_amount_cents: max === undefined ? null : String(max) });
            setOpen(false);
          } catch (reason) { setError(reason instanceof Error ? reason.message : "金额范围无效。"); }
        }}>
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
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)}>取消</Button>
            <Button type="submit" size="sm">应用金额</Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}
