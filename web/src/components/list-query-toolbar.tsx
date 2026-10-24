import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "cn";
import { ChevronDown, Columns3, Search, X } from "lucide-react";
import { normalizeKeyword, type ListQueryControl } from "@/lib/list-query";
import { useCompactList } from "@/hooks/use-compact-list";
import { ListColumnsSlot, useListSummary } from "@/components/list-columns";
import { ListDensityControl, ListDensityOptions } from "@/components/list-density";
import { ListActionsMenu, ListActionsProvider } from "@/components/list-actions-menu";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { ErrorNotice } from "@/components/request-state";
import { Field, FieldGroup, FieldError } from "@/components/ui/field";
import {
  InputGroup,
  InputGroupInput,
  InputGroupAddon,
  InputGroupButton,
} from "@/components/ui/input-group";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import {
  ListFilterSheet,
  type ListFilter,
  type ListFilterDraftControl,
} from "@/components/list-filter-sheet";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetFooter, SheetClose } from "@/components/ui/sheet";
import { Separator } from "@/components/ui/separator";
export type { ListFilter, ListFilterDraftControl } from "@/components/list-filter-sheet";

export type ListQueryLookup = {
  context?: (mode: string) => ReactNode;
  modes: readonly {
    value: string;
    label: string;
    placeholder: string;
    pattern?: string;
  }[];
  inputLabel: string;
  inputName: string;
  maxLength?: number;
  pending?: boolean;
  error?: unknown;
  onSubmit: (mode: string, value: string) => void;
  onReset?: () => void;
};

export function ListQueryToolbar({
  control,
  sorts,
  children,
  disabled = false,
  label = "关键词搜索",
  filters = [],
  lookup,
  mobileLeading,
  mobileActions,
  desktopFilters,
  desktopActions,
  desktopFilterContent,
  mobileFilterContent,
  mobileFilterSummary = [],
  mobileFilterReset,
}: {
  control: ListQueryControl;
  sorts: readonly { value: string; label: string }[];
  children?: ReactNode;
  disabled?: boolean;
  label?: string;
  filters?: readonly ListFilter[];
  lookup?: ListQueryLookup | undefined;
  mobileLeading?: ReactNode;
  mobileActions?: ReactNode;
  desktopFilters?: ReactNode;
  desktopActions?: ReactNode;
  desktopFilterContent?: ReactNode;
  mobileFilterContent?: (control: ListFilterDraftControl) => ReactNode;
  mobileFilterSummary?: readonly string[];
  mobileFilterReset?: Record<string, string | null>;
}) {
  const compactViewport = useCompactList();
  const summary = useListSummary();
  const compact = compactViewport || summary;
  const [draft, setDraft] = useState(control.query.q);
  const [lookupDraft, setLookupDraft] = useState("");
  const [mode, setMode] = useState("");
  const [error, setError] = useState("");
  const [displayOpen, setDisplayOpen] = useState(false);
  const actionsTrigger = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!compact) setDisplayOpen(false);
  }, [compact]);
  useEffect(() => {
    setDraft(control.query.q);
    setError("");
  }, [control.query.q]);
  const selectedMode = lookup?.modes.find((item) => item.value === mode);
  const busy = disabled || !!lookup?.pending;
  const activeFilters = filters.filter(
    (filter) => filter.value !== (filter.defaultValue ?? ""),
  );
  const summaries = [
    ...(control.query.q ? ["关键词：" + control.query.q] : []),
    ...activeFilters.map(
      (filter) =>
        filter.label +
        "：" +
        (filter.options.find((option) => option.value === filter.value)
          ?.label ?? filter.value),
    ),
    ...mobileFilterSummary,
  ];
  return (
    <div
      className="list-query-toolbar min-w-0"
      data-list-query-toolbar
      data-compact={compact}
    >
      <div
        className="list-toolbar-row flex min-w-0 flex-wrap items-start gap-x-4 gap-y-3"
        data-list-toolbar-row
      >
        {selectedMode && lookup?.context?.(selectedMode.value)}
        <form
          className={cn(
            "min-w-0",
            compact
              ? "w-full"
              : "min-w-[min(100%,20rem)] max-w-lg flex-[1_1_20rem]",
          )}
          role="search"
          aria-label={selectedMode ? lookup!.inputLabel + "精确查询" : label}
          onSubmit={(event) => {
            event.preventDefault();
            if (busy) return;
            if (selectedMode && lookup) {
              if (lookupDraft.trim())
                lookup.onSubmit(selectedMode.value, lookupDraft.trim());
              return;
            }
            try {
              const q = normalizeKeyword(draft);
              setError("");
              setDraft(q);
              control.setKeyword(q);
            } catch {
              setError("关键词最多 100 个字符。");
            }
          }}
        >
          <FieldGroup className="flex-row items-center gap-2">
            <Field
              className="min-w-0 flex-1"
              data-invalid={!!error}
              data-disabled={busy}
            >
              <InputGroup>
                <InputGroupInput
                  type="search"
                  aria-label={selectedMode ? lookup!.inputLabel : label}
                  name={selectedMode ? lookup!.inputName : "q"}
                  placeholder={
                    selectedMode?.placeholder ??
                    (compact ? "输入关键词" : "输入关键词，按 Enter 搜索")
                  }
                  value={selectedMode ? lookupDraft : draft}
                  required={!!selectedMode}
                  maxLength={selectedMode ? lookup?.maxLength : undefined}
                  pattern={selectedMode?.pattern}
                  autoComplete={selectedMode ? "off" : undefined}
                  disabled={busy}
                  aria-invalid={!!error}
                  onChange={(event) => {
                    if (selectedMode) {
                      setLookupDraft(event.target.value);
                      lookup?.onReset?.();
                    } else setDraft(event.target.value);
                    setError("");
                  }}
                />
                <InputGroupAddon>
                  {lookup ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <InputGroupButton
                            size={compact ? "icon-xs" : "xs"}
                            disabled={busy}
                          />
                        }
                        aria-label={
                          "查询方式：" + (selectedMode?.label ?? "关键词")
                        }
                        title={"查询方式：" + (selectedMode?.label ?? "关键词")}
                      >
                        {compact ? (
                          <Search />
                        ) : (
                          (selectedMode?.label ?? "关键词")
                        )}
                        <ChevronDown data-icon="inline-end" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" className="w-max max-w-[calc(100vw-2rem)]">
                        <DropdownMenuGroup>
                          <DropdownMenuRadioGroup
                            value={mode}
                            onValueChange={(value) => {
                              setMode(value);
                              setError("");
                              lookup.onReset?.();
                            }}
                          >
                            <DropdownMenuRadioItem value="">
                              关键词
                            </DropdownMenuRadioItem>
                            {lookup.modes.map((item) => (
                              <DropdownMenuRadioItem
                                key={item.value}
                                value={item.value}
                              >
                                {item.label}
                              </DropdownMenuRadioItem>
                            ))}
                          </DropdownMenuRadioGroup>
                        </DropdownMenuGroup>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : (
                    <Search />
                  )}
                </InputGroupAddon>
              </InputGroup>
              {error && <FieldError>{error}</FieldError>}
            </Field>
            <Button
              type="submit"
              variant="outline"
              disabled={busy || (!!selectedMode && !lookupDraft.trim())}
            >
              {lookup?.pending && <Spinner data-icon="inline-start" />}
              {selectedMode ? "查找" : "搜索"}
            </Button>
          </FieldGroup>
        </form>
        {!compact && (
          <>
            {desktopFilters && (
              <div
                className="flex shrink-0 items-center gap-2"
                data-list-desktop-filters
              >
                {desktopFilters}
              </div>
            )}
            {control.query.q && (
              <Button
                type="button"
                variant="ghost"
                disabled={disabled}
                onClick={() => control.setKeyword("")}
              >
                清除搜索
              </Button>
            )}
            {desktopActions && (
              <div
                className="ml-auto flex shrink-0 items-center gap-2"
                data-list-desktop-actions
              >
                {desktopActions}
              </div>
            )}
          </>
        )}
      </div>
      {!compact && <ListColumnsSlot><ListDensityControl compact={false} /></ListColumnsSlot>}
      {selectedMode && (
        <div className="list-toolbar-detail empty:hidden">
          <ErrorNotice error={lookup?.error} />
        </div>
      )}
      {compact && (
        <>
          {mobileLeading && <div className="list-toolbar-detail flex min-w-0 flex-wrap items-center gap-2" data-list-mobile-leading>{mobileLeading}</div>}
          <div
            className="list-toolbar-detail flex min-w-0 items-center justify-between gap-2"
            data-list-mobile-actions
          >
            <ListFilterSheet
              control={control}
              sorts={sorts}
              filters={filters}
              disabled={busy}
              content={mobileFilterContent}
              activeContentCount={mobileFilterSummary.length}
            />
            <ListActionsProvider triggerRef={actionsTrigger} items={<DropdownMenuItem onClick={() => setDisplayOpen(true)}><Columns3 />列表显示</DropdownMenuItem>}>
              {mobileActions ?? <ListActionsMenu label="更多列表操作" disabled={busy} />}
            </ListActionsProvider>
          </div>
          <Sheet open={displayOpen} onOpenChange={setDisplayOpen}>
            <SheetContent side="bottom" finalFocus={actionsTrigger} className="max-h-[calc(100dvh-2rem)] gap-0 overflow-hidden" data-list-display-sheet>
              <SheetHeader className="shrink-0 pr-[calc(max(1.75rem,44px)+1.5rem)]">
                <SheetTitle>列表显示</SheetTitle>
              </SheetHeader>
              <div className="flex min-h-0 flex-col gap-4 overflow-y-auto overscroll-contain" data-list-display-scroll>
                <SheetDescription className="shrink-0 px-4">调整密度和显示字段，设置会自动保存。</SheetDescription>
                <div className="flex shrink-0 flex-col gap-4 px-4 pb-1" data-list-display-body>
                  <ListDensityOptions />
                  <Separator />
                  <ListColumnsSlot display />
                </div>
                <SheetFooter className="shrink-0 pb-[max(1rem,env(safe-area-inset-bottom))]">
                  <SheetClose render={<Button type="button" />}>完成</SheetClose>
                </SheetFooter>
              </div>
            </SheetContent>
          </Sheet>
          {summaries.length > 0 && (
            <div
              className="list-toolbar-detail flex min-w-0 items-center gap-2"
              aria-label="当前查询条件"
            >
              <div
                className="flex min-w-0 flex-1 flex-wrap gap-1"
                role="status"
              >
                {summaries.map((text) => (
                  <Badge
                    key={text}
                    variant="secondary"
                    className="max-w-full"
                    title={text}
                  >
                    <span className="truncate">{text}</span>
                  </Badge>
                ))}
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={busy}
                aria-label="清除搜索和筛选"
                onClick={() =>
                  control.update({
                    q: null,
                    ...mobileFilterReset,
                    ...Object.fromEntries(
                      filters.map((filter) => [
                        filter.key,
                        filter.defaultValue ?? null,
                      ]),
                    ),
                  })
                }
              >
                <X />
              </Button>
            </div>
          )}
        </>
      )}
      {!compact && desktopFilterContent && <div className="list-toolbar-detail flex min-w-0 flex-wrap items-center gap-2">{desktopFilterContent}</div>}
      {children && (
        <div className="list-toolbar-detail flex flex-wrap items-center gap-2">
          {children}
        </div>
      )}
      {!compact && control.query.q && (
        <p className="list-toolbar-detail text-xs break-all text-muted-foreground">
          当前关键词：{control.query.q} · 搜索全部匹配记录，不仅当前页
        </p>
      )}
    </div>
  );
}
