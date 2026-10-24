import { DialogBody } from "@/components/admin-dialog";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  beijingDate,
  createdDatePreset,
  createdDateRange,
} from "../../../src/shared/created-dates";
import { CREATED_DATE_FIELDS, type ListDateFields, type ListQueryControl } from "@/lib/list-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldError,
  FieldSet,
  FieldLegend,
  FieldDescription,
} from "@/components/ui/field";
import { useListFilterPanel } from "@/components/list-filter-context";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/admin-dialog";
const presets = [
  { value: "all", label: "全部" },
  { value: "today", label: "今天" },
  { value: "yesterday", label: "昨天" },
  { value: "7", label: "近 7 天" },
  { value: "30", label: "近 30 天" },
  { value: "custom", label: "自定义日期" },
];
type CreatedDateFilterProps = {
  control: ListQueryControl;
  children?: ReactNode;
  label?: string;
  fields?: ListDateFields;
};

function selectedPreset(query: ListQueryControl["query"]) {
  let selected = query.createdFrom || query.createdTo ? "custom" : "all";
  for (const value of ["today", "yesterday", "7", "30"]) {
    const dates = createdDatePreset(
      value === "7" ? 7 : value === "30" ? 30 : 1,
      value === "yesterday",
    );
    if (query.createdFrom === dates.from && query.createdTo === dates.to)
      selected = value;
  }
  return selected;
}

function validateDates(from: string, to: string) {
  if (!from || !to) {
    const error = "请同时提供开始和结束日期";
    return { error, fromError: from ? "" : error, toError: to ? "" : error };
  }
  try {
    createdDateRange(from, to);
    return { error: "", fromError: "", toError: "" };
  } catch (reason) {
    const error = reason instanceof Error ? reason.message : "日期无效";
    return { error, fromError: error, toError: error };
  }
}

export function CreatedDateFilter(props: CreatedDateFilterProps) {
  const inline = useListFilterPanel();
  return inline ? <InlineCreatedDateFilter {...props} /> : <CreatedDateDialogFilter {...props} />;
}

function InlineCreatedDateFilter({
  control,
  children,
  label = "创建日期",
  fields = CREATED_DATE_FIELDS,
}: CreatedDateFilterProps) {
  const id = useId();
  const [selected, setSelected] = useState(() => selectedPreset(control.query));
  const [from, setFrom] = useState(() => control.query.createdFrom ?? beijingDate());
  const [to, setTo] = useState(() => control.query.createdTo ?? beijingDate());
  const fromInput = useRef<HTMLInputElement>(null);
  const toInput = useRef<HTMLInputElement>(null);
  const { error, fromError, toError } = selected === "custom"
    ? validateDates(from, to) : { error: "", fromError: "", toError: "" };
  useEffect(() => {
    fromInput.current?.setCustomValidity(fromError);
    toInput.current?.setCustomValidity(toError);
  }, [fromError, toError, selected]);

  function stageCustom(nextFrom: string, nextTo: string) {
    if (!validateDates(nextFrom, nextTo).error)
      control.update({ [fields.from]: nextFrom, [fields.to]: nextTo });
  }

  return (
    <FieldSet className="min-w-0" data-list-inline-date>
      <FieldLegend variant="label">{label}</FieldLegend>
      <FieldDescription id={id + "-description"}>
        北京时间，含起止日期。
      </FieldDescription>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={id + "-preset"} className="sr-only">{label}范围</FieldLabel>
          <Select
            items={presets}
            value={selected}
            onValueChange={value => {
              if (!value) return;
              setSelected(value);
              if (value === "custom") {
                stageCustom(from, to);
                return;
              }
              const dates = value === "all" ? null : createdDatePreset(
                value === "7" ? 7 : value === "30" ? 30 : 1,
                value === "yesterday",
              );
              const today = beijingDate();
              setFrom(dates?.from ?? today);
              setTo(dates?.to ?? today);
              control.update({ [fields.from]: dates?.from ?? null, [fields.to]: dates?.to ?? null });
            }}
          >
            <SelectTrigger id={id + "-preset"} aria-label={label + "范围"} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {presets.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        {selected === "custom" && <>
          <Field data-invalid={!!fromError}>
            <FieldLabel htmlFor={id + "-from"}>开始日期</FieldLabel>
            <Input
              ref={fromInput}
              id={id + "-from"}
              type="date"
              min="1970-01-01"
              required
              value={from}
              onChange={event => {
                setFrom(event.target.value);
                stageCustom(event.target.value, to);
              }}
              aria-invalid={!!fromError}
              aria-describedby={id + "-description" + (error ? " " + id + "-error" : "")}
            />
          </Field>
          <Field data-invalid={!!toError}>
            <FieldLabel htmlFor={id + "-to"}>结束日期</FieldLabel>
            <Input
              ref={toInput}
              id={id + "-to"}
              type="date"
              min="1970-01-01"
              required
              value={to}
              onChange={event => {
                setTo(event.target.value);
                stageCustom(from, event.target.value);
              }}
              aria-invalid={!!toError}
              aria-describedby={id + "-description" + (error ? " " + id + "-error" : "")}
            />
          </Field>
          {error && <FieldError id={id + "-error"}>{error}</FieldError>}
        </>}
      </FieldGroup>
      {children}
    </FieldSet>
  );
}

function CreatedDateDialogFilter({
  control,
  children,
  label = "创建日期",
  fields = CREATED_DATE_FIELDS,
}: CreatedDateFilterProps) {
  const [open, setOpen] = useState(false),
    [from, setFrom] = useState(""),
    [to, setTo] = useState(""),
    [error, setError] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const query = control.query;
  const selected = selectedPreset(query);
  function custom() {
    const today = beijingDate();
    setFrom(query.createdFrom ?? today);
    setTo(query.createdTo ?? today);
    setError("");
    setOpen(true);
  }
  return (
    <div
      className="flex flex-wrap items-center gap-2"
      aria-label={label + "筛选"}
      role="group"
    >
      <span className="text-sm text-muted-foreground">{label}</span>
      <Select
        items={presets}
        value={selected}
        onValueChange={(value) => {
          if (!value) return;
          if (value === "custom") {
            custom();
            return;
          }
          const dates =
            value === "all"
              ? null
              : createdDatePreset(
                  value === "7" ? 7 : value === "30" ? 30 : 1,
                  value === "yesterday",
                );
          control.update({
            [fields.from]: dates?.from ?? null,
            [fields.to]: dates?.to ?? null,
          });
        }}
      >
        <SelectTrigger ref={trigger} aria-label={label + "范围"}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {presets.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      {selected === "custom" && (
        <Button variant="ghost" size="sm" onClick={custom}>
          修改日期
        </Button>
      )}
      <span className="text-xs text-muted-foreground">北京时间</span>
      {children}
      {query.createdFrom && (
        <p className="w-full text-xs text-muted-foreground">
          {query.createdFrom} 至 {query.createdTo ?? "未指定"}
        </p>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent finalFocus={trigger}>
          <DialogHeader>
            <DialogTitle>自定义{label}</DialogTitle>
          </DialogHeader>
          <form
            className="contents"
            onSubmit={(event) => {
              event.preventDefault();
              try {
                createdDateRange(from, to);
                control.update({ [fields.from]: from, [fields.to]: to });
                setOpen(false);
              } catch (error) {
                setError(error instanceof Error ? error.message : "日期无效");
              }
            }}
          >
            <DialogBody>
            <DialogDescription>
              北京时间，含起止日期。
            </DialogDescription>
            <FieldGroup>
              <Field data-invalid={!!error}>
                <FieldLabel htmlFor={id + "-from"}>开始日期</FieldLabel>
                <Input
                  id={id + "-from"}
                  type="date"
                  required
                  value={from}
                  onChange={(event) => {
                    setFrom(event.target.value);
                    setError("");
                  }}
                  aria-invalid={!!error}
                  aria-describedby={error ? id + "-error" : undefined}
                />
              </Field>
              <Field data-invalid={!!error}>
                <FieldLabel htmlFor={id + "-to"}>结束日期</FieldLabel>
                <Input
                  id={id + "-to"}
                  type="date"
                  required
                  value={to}
                  onChange={(event) => {
                    setTo(event.target.value);
                    setError("");
                  }}
                  aria-invalid={!!error}
                  aria-describedby={error ? id + "-error" : undefined}
                />
              </Field>
              {error && <FieldError id={id + "-error"}>{error}</FieldError>}
            </FieldGroup>
            </DialogBody>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setOpen(false)}
              >
                取消
              </Button>
              <Button type="submit">应用日期</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
