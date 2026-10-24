import { useId, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { ledgerAmountInput, parseLedgerAmount, validateLedgerAmountRange } from "@/lib/ledger-filters";
import type { ListQueryControl } from "@/lib/list-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/admin-dialog";

export function LedgerAmountFilter({ control, searchParams }: { control: ListQueryControl; searchParams?: URLSearchParams }) {
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
            <DialogDescription>单位为人民币元，最多两位小数；留空表示不限。</DialogDescription>
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
