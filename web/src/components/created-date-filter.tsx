import { DialogBody } from "@/components/admin-dialog";
import { useId, useRef, useState, type ReactNode } from "react";
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
} from "@/components/ui/field";
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
export function CreatedDateFilter({
  control,
  children,
  label = "创建日期",
  fields = CREATED_DATE_FIELDS,
}: {
  control: ListQueryControl;
  children?: ReactNode;
  label?: string;
  fields?: ListDateFields;
}) {
  const [open, setOpen] = useState(false),
    [from, setFrom] = useState(""),
    [to, setTo] = useState(""),
    [error, setError] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const query = control.query;
  let selected = query.createdFrom || query.createdTo ? "custom" : "all";
  for (const value of ["today", "yesterday", "7", "30"]) {
    const dates = createdDatePreset(
      value === "7" ? 7 : value === "30" ? 30 : 1,
      value === "yesterday",
    );
    if (query.createdFrom === dates.from && query.createdTo === dates.to)
      selected = value;
  }
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
              按北京时间，包含开始和结束两天。
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
