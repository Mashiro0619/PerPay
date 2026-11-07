import { Children, Fragment, cloneElement, isValidElement, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { cn } from "cn";
import { ChevronDown, Columns3, Search, X } from "lucide-react";
import { normalizeKeyword, type ListQueryControl } from "@/lib/list-query";
import { useCompactList } from "@/hooks/use-compact-list";
import { ListColumnsSlot, useListSummary } from "@/components/list-columns";
import { ListDensityOptions } from "@/components/list-density";
import { CreatedDateFilter } from "@/components/created-date-filter";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { ListActionsMenu, ListActionsProvider } from "@/components/list-actions-menu";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetFooter, SheetClose } from "@/components/ui/sheet";
import { Separator } from "@/components/ui/separator";
export type { ListFilter, ListFilterDraftControl } from "@/components/list-filter-sheet";

function filterControls(children: ReactNode, prefix: string): ReactNode[] {
  return Children.toArray(children).flatMap((child, index) => {
    const key = prefix + ":" + (isValidElement(child) ? child.key ?? index : index);
    if (isValidElement<{ children?: ReactNode }>(child) && child.type === Fragment) return filterControls(child.props.children, key);
    return [isValidElement(child) ? cloneElement(child, { key }) : child];
  });
}

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
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const advancedId = useId();
  const actionsTrigger = useRef<HTMLButtonElement | null>(null);
  const searchInput = useRef<HTMLInputElement | null>(null);
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
  const controls = filterControls(desktopFilters, "primary");
  const extras = filterControls(desktopFilterContent, "advanced");
  const date = extras.find(child => isValidElement(child) && child.type === CreatedDateFilter);
  const primaryCount = date ? 1 : 2;
  const primaryControls = [...(date ? [date] : []), ...controls.slice(0, primaryCount)];
  const advancedControls = [...controls.slice(primaryCount), ...extras.filter(child => child !== date)];
  const clearFilters = () => control.update({
    q: null,
    ...mobileFilterReset,
    ...Object.fromEntries(filters.map(filter => [filter.key, filter.defaultValue ?? null])),
  });
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
                  ref={searchInput}
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
                            size="xs"
                            disabled={busy}
                          />
                        }
                        aria-label={
                          "查询方式：" + (selectedMode?.label ?? "关键词")
                        }
                        title={"查询方式：" + (selectedMode?.label ?? "关键词")}
                      >
                        {compact ? (
                          <Search data-icon="inline-start" />
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
            {primaryControls.length > 0 && (
              <div
                className="flex shrink-0 items-center gap-2"
                data-list-desktop-filters
              >
                {primaryControls}
              </div>
            )}
            {control.query.q && (
              <Tooltip>
                <TooltipTrigger render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="清除搜索"
                    disabled={disabled}
                    onClick={() => {
                      control.setKeyword("");
                      searchInput.current?.focus({ preventScroll: true });
                    }}
                  />
                }>
                  <X aria-hidden="true" />
                </TooltipTrigger>
                <TooltipContent>清除搜索</TooltipContent>
              </Tooltip>
            )}
            {desktopActions && (
              <div
                className="ml-auto flex shrink-0 items-center gap-2"
                data-list-desktop-actions
              >
                {desktopActions}
              </div>
            )}
            {advancedControls.length > 0 && <Button type="button" variant="outline" disabled={busy}
              aria-expanded={advancedOpen} aria-controls={advancedId} data-list-advanced-trigger
              onClick={() => setAdvancedOpen(open => !open)}>
              高级筛选<ChevronDown className={advancedOpen ? "rotate-180" : undefined} data-icon="inline-end" />
            </Button>}
            <Popover open={displayOpen} onOpenChange={setDisplayOpen}>
              <PopoverTrigger render={<Button type="button" variant="outline" aria-label="列表显示" data-list-display-trigger />}>
                <Columns3 data-icon="inline-start" />显示
              </PopoverTrigger>
              <PopoverContent align="end" className="max-h-[min(36rem,calc(100dvh-2rem))] overflow-y-auto" data-list-display-menu>
                <PopoverTitle>列表显示</PopoverTitle>
                <ListDensityOptions />
                {!summary && <Separator />}
                <ListColumnsSlot display />
              </PopoverContent>
            </Popover>
          </>
        )}
      </div>
      {!compact && advancedOpen && advancedControls.length > 0 && <div id={advancedId}
        className="list-toolbar-detail flex min-w-0 flex-wrap items-end gap-3" data-list-advanced-filters>
        {advancedControls}
      </div>}
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
            <SheetContent side="bottom" finalFocus={actionsTrigger} className="h-dvh max-h-dvh gap-0 overflow-hidden rounded-none border-0" data-list-display-sheet>
              <SheetHeader className="shrink-0 pr-[calc(max(1.75rem,44px)+1.5rem)]">
                <SheetTitle>列表显示</SheetTitle>
              </SheetHeader>
              <div className="flex min-h-0 flex-col gap-4 overflow-y-auto overscroll-contain" data-list-display-scroll>
                <div className="flex shrink-0 flex-col gap-4 px-4 pb-1" data-list-display-body>
                  <ListDensityOptions />
                  {!summary && <Separator />}
                  <ListColumnsSlot display />
                  {summary && <p className="text-sm text-muted-foreground">手机列表展示关键摘要，完整信息可打开详情查看。</p>}
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
                onClick={clearFilters}
              >
                <X />
              </Button>
            </div>
          )}
        </>
      )}
      {!compact && summaries.length > 0 && <div className="list-toolbar-detail flex min-w-0 items-center gap-2" aria-label="当前查询条件" data-list-applied-filters>
        <div className="flex min-w-0 flex-1 flex-wrap gap-1" role="status">{summaries.map(text => <Badge key={text} variant="secondary" className="max-w-full" title={text}><span className="truncate">{text}</span></Badge>)}</div>
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={clearFilters} aria-label="清除搜索和筛选">清除</Button>
      </div>}
      {children && (
        <div className="list-toolbar-detail flex flex-wrap items-center gap-2">
          {children}
        </div>
      )}
    </div>
  );
}
