import { useId, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { ArrowDown, ArrowUp, SlidersHorizontal } from "lucide-react";
import { CREATED_DATE_FIELDS, type ListDateFields, type ListQueryControl, type SortOrder } from "@/lib/list-query";
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
import { ListFilterPanelContext } from "@/components/list-filter-context";
import {
  Sheet,
  SheetTrigger,
  SheetContent,
  SheetHeader,
  SheetTitle,
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

export type ListFilterDraftControl = ListQueryControl & {
  /** Includes dates, amounts and other staged URL conditions. */
  searchParams: URLSearchParams;
  withDates: (fields: ListDateFields) => ListQueryControl;
};

export function ListFilterSheet({
  control,
  sorts,
  filters,
  disabled,
  compact = false,
  content,
  activeContentCount = 0,
}: {
  control: ListQueryControl;
  sorts: readonly { value: string; label: string }[];
  filters: readonly ListFilter[];
  disabled: boolean;
  compact?: boolean;
  content?: (control: ListFilterDraftControl) => ReactNode;
  activeContentCount?: number;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [sortBy, setSortBy] = useState(control.query.sortBy);
  const [sortOrder, setSortOrder] = useState<SortOrder>(
    control.query.sortOrder,
  );
  const [search] = useSearchParams();
  const [initialSearch, setInitialSearch] = useState(() => new URLSearchParams(search));
  const [contentDraft, setContentDraft] = useState<Record<string, string | null>>({});
  const count = filters.filter(
    (filter) => filter.value !== (filter.defaultValue ?? ""),
  ).length + activeContentCount;
  function changeOpen(next: boolean) {
    if (next) {
      setDraft(
        Object.fromEntries(filters.map((filter) => [filter.key, filter.value])),
      );
      setSortBy(control.query.sortBy);
      setSortOrder(control.query.sortOrder);
      setInitialSearch(new URLSearchParams(search));
      setContentDraft({});
    }
    setOpen(next);
  }
  const stagedSearch = new URLSearchParams(initialSearch);
  for (const [key, value] of Object.entries(contentDraft)) {
    if (value) stagedSearch.set(key, value);
    else stagedSearch.delete(key);
  }
  for (const filter of filters) {
    const value = draft[filter.key] ?? filter.value;
    if (value) stagedSearch.set(filter.key, value);
    else stagedSearch.delete(filter.key);
  }
  stagedSearch.set("sort_by", sortBy);
  stagedSearch.set("sort_order", sortOrder);
  function stage(values: Record<string, string | null>) {
    setContentDraft(current => ({ ...current, ...values }));
    setDraft(current => ({ ...current, ...Object.fromEntries(filters.filter(filter => filter.key in values).map(filter => [filter.key, values[filter.key] ?? ""])) }));
    if (values.sort_by) setSortBy(values.sort_by);
    if (values.sort_order === "asc" || values.sort_order === "desc") setSortOrder(values.sort_order);
  }
  function withDates(fields: ListDateFields): ListQueryControl {
    return {
      query: {
        q: stagedSearch.get("q") ?? "",
        sortBy,
        sortOrder,
        ...(stagedSearch.has(fields.from) ? { createdFrom: stagedSearch.get(fields.from)! } : {}),
        ...(stagedSearch.has(fields.to) ? { createdTo: stagedSearch.get(fields.to)! } : {}),
      },
      update: stage,
      setKeyword: q => stage({ q }),
      setSort: (sort_by, sort_order) => stage({ sort_by, sort_order }),
      clear: () => stage({ q: null, sort_by: null, sort_order: null, [fields.from]: null, [fields.to]: null }),
    };
  }
  const contentControl: ListFilterDraftControl = {
    ...withDates(CREATED_DATE_FIELDS),
    searchParams: stagedSearch,
    withDates,
  };
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
      <SheetContent side="bottom" className="max-h-[calc(100dvh-2rem)] gap-0 overflow-hidden">
        <SheetHeader className="shrink-0 pr-16">
          <SheetTitle>筛选与排序</SheetTitle>
        </SheetHeader>
        <form
          className="grid min-h-0 auto-rows-max gap-4 overflow-y-auto overscroll-contain"
          data-list-filter-scroll
          onSubmit={(event) => {
            event.preventDefault();
            if (disabled) return;
            setOpen(false);
            const changed =
              sortBy !== control.query.sortBy ||
              sortOrder !== control.query.sortOrder ||
              Object.entries(contentDraft).some(([key, value]) =>
                (value || null) !== initialSearch.get(key),
              ) ||
              filters.some(
                (filter) =>
                  (draft[filter.key] ?? filter.value) !== filter.value,
              );
            if (!changed) return;
            // One URL update preserves both filter and sort changes and resets the cursor once.
            control.update({
              ...contentDraft,
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
          <FieldGroup className="px-4 py-1" data-list-filter-body>
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
            {content && <ListFilterPanelContext value><div className="flex min-w-0 flex-col gap-4" data-list-filter-content>{content(contentControl)}</div></ListFilterPanelContext>}
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
