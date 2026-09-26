import { useId, useState } from "react";
import { ArrowDown, ArrowUp, SlidersHorizontal } from "lucide-react";
import type { ListQueryControl, SortOrder } from "@/lib/list-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Sheet,
  SheetTrigger,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
  SheetClose,
} from "@/components/ui/sheet";

export type ListFilter = {
  key: string;
  label: string;
  value: string;
  defaultValue?: string;
  options: readonly { value: string; label: string }[];
};

export function ListFilterSheet({
  control,
  sorts,
  filters,
  disabled,
  compact = false,
}: {
  control: ListQueryControl;
  sorts: readonly { value: string; label: string }[];
  filters: readonly ListFilter[];
  disabled: boolean;
  compact?: boolean;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [sortBy, setSortBy] = useState(control.query.sortBy);
  const [sortOrder, setSortOrder] = useState<SortOrder>(
    control.query.sortOrder,
  );
  const count = filters.filter(
    (filter) => filter.value !== (filter.defaultValue ?? ""),
  ).length;
  function changeOpen(next: boolean) {
    if (next) {
      setDraft(
        Object.fromEntries(filters.map((filter) => [filter.key, filter.value])),
      );
      setSortBy(control.query.sortBy);
      setSortOrder(control.query.sortOrder);
    }
    setOpen(next);
  }
  return (
    <Sheet open={open} onOpenChange={changeOpen}>
      <SheetTrigger
        render={
          <Button
            variant="outline"
            size={compact ? "icon" : "default"}
            disabled={disabled}
          />
        }
        aria-label={count ? "筛选与排序，已选 " + count + " 项" : "筛选与排序"}
        data-list-filter-trigger
      >
        <SlidersHorizontal data-icon="inline-start" />
        {!compact && (
          <>
            筛选与排序{count > 0 && <Badge variant="secondary">{count}</Badge>}
          </>
        )}
      </SheetTrigger>
      <SheetContent side="bottom" className="max-h-[calc(100dvh-2rem)]">
        <SheetHeader className="shrink-0 pr-16">
          <SheetTitle>筛选与排序</SheetTitle>
          <SheetDescription>
            点击应用后更新结果；取消不会更改当前条件。
          </SheetDescription>
        </SheetHeader>
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            if (disabled) return;
            setOpen(false);
            const changed =
              sortBy !== control.query.sortBy ||
              sortOrder !== control.query.sortOrder ||
              filters.some(
                (filter) =>
                  (draft[filter.key] ?? filter.value) !== filter.value,
              );
            if (!changed) return;
            // One URL update preserves both filter and sort changes and resets the cursor once.
            control.update({
              ...Object.fromEntries(
                filters.map((filter) => [
                  filter.key,
                  draft[filter.key] ?? filter.value,
                ]),
              ),
              sort_by: sortBy,
              sort_order: sortOrder,
            });
          }}
        >
          <FieldGroup className="min-h-0 overflow-y-auto px-4 pb-1">
            {filters.map((filter) => (
              <Field key={filter.key}>
                <FieldLabel htmlFor={id + filter.key}>
                  {filter.label}
                </FieldLabel>
                <Select
                  items={filter.options}
                  value={draft[filter.key] ?? filter.value}
                  disabled={disabled}
                  onValueChange={(value) => {
                    if (value !== null)
                      setDraft((current) => ({
                        ...current,
                        [filter.key]: value,
                      }));
                  }}
                >
                  <SelectTrigger
                    id={id + filter.key}
                    aria-label={filter.label}
                    className="w-full"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {filter.options.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            ))}
            <Field>
              <FieldLabel htmlFor={id + "sort"}>排序字段</FieldLabel>
              <Select
                items={sorts}
                value={sortBy}
                disabled={disabled}
                onValueChange={(value) => {
                  if (value) setSortBy(value);
                }}
              >
                <SelectTrigger
                  id={id + "sort"}
                  aria-label="排序字段"
                  className="w-full"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {sorts.map((sort) => (
                      <SelectItem key={sort.value} value={sort.value}>
                        {sort.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel>排序方向</FieldLabel>
              <ToggleGroup
                variant="outline"
                aria-label="排序方向"
                value={[sortOrder]}
                disabled={disabled}
                onValueChange={(values) => {
                  if (values[0] === "asc" || values[0] === "desc")
                    setSortOrder(values[0]);
                }}
              >
                <ToggleGroupItem value="asc">
                  <ArrowUp data-icon="inline-start" />
                  升序
                </ToggleGroupItem>
                <ToggleGroupItem value="desc">
                  <ArrowDown data-icon="inline-start" />
                  降序
                </ToggleGroupItem>
              </ToggleGroup>
            </Field>
          </FieldGroup>
          <SheetFooter className="shrink-0 flex-row justify-end pb-[max(1rem,env(safe-area-inset-bottom))]">
            <SheetClose render={<Button type="button" variant="outline" />}>
              取消
            </SheetClose>
            <Button type="submit" disabled={disabled}>
              应用
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
