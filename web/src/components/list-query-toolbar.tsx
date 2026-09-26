import { useEffect, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ChevronDown, Search, X } from "lucide-react";
import { normalizeKeyword, type ListQueryControl } from "@/lib/list-query";
import { useIsMobile } from "@/hooks/use-mobile";
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
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu";
import {
  ListFilterSheet,
  type ListFilter,
} from "@/components/list-filter-sheet";
export type { ListFilter } from "@/components/list-filter-sheet";

export type ListQueryLookup = {
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
}) {
  const isMobile = useIsMobile();
  const [draft, setDraft] = useState(control.query.q);
  const [lookupDraft, setLookupDraft] = useState("");
  const [mode, setMode] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    setDraft(control.query.q);
    setError("");
  }, [control.query.q]);
  const selectedMode = isMobile
    ? lookup?.modes.find((item) => item.value === mode)
    : undefined;
  const busy = disabled || !!(isMobile && lookup?.pending);
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
  ];
  return (
    <div className="flex min-w-0 flex-col gap-2" data-list-query-toolbar>
      <form
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
            setError("关键词最多100个Unicode字符。");
          }
        }}
      >
        <FieldGroup className="flex-row flex-wrap items-start gap-2">
          <Field className="min-w-40 flex-1 md:max-w-sm" data-invalid={!!error}>
            <InputGroup>
              <InputGroupInput
                type="search"
                aria-label={selectedMode ? lookup!.inputLabel : label}
                name={selectedMode ? lookup!.inputName : "q"}
                placeholder={
                  selectedMode?.placeholder ??
                  (isMobile ? "输入关键词" : "输入关键词，按 Enter 搜索")
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
                {isMobile && lookup ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <InputGroupButton size="icon-xs" disabled={busy} />
                      }
                      aria-label={
                        "查询方式：" + (selectedMode?.label ?? "关键词")
                      }
                      title={"查询方式：" + (selectedMode?.label ?? "关键词")}
                    >
                      <Search />
                      <ChevronDown />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
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
            {isMobile && lookup?.pending && (
              <Spinner data-icon="inline-start" />
            )}
            {selectedMode ? "查找" : "搜索"}
          </Button>
          {!isMobile && (
            <>
              <Select
                items={sorts}
                value={control.query.sortBy}
                disabled={disabled}
                onValueChange={(value) => {
                  if (value) control.setSort(value, control.query.sortOrder);
                }}
              >
                <SelectTrigger aria-label="排序字段">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {sorts.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="outline"
                disabled={disabled}
                aria-label={
                  control.query.sortOrder === "asc"
                    ? "当前升序，切换为降序"
                    : "当前降序，切换为升序"
                }
                onClick={() =>
                  control.setSort(
                    control.query.sortBy,
                    control.query.sortOrder === "asc" ? "desc" : "asc",
                  )
                }
              >
                {control.query.sortOrder === "asc" ? (
                  <ArrowUp data-icon="inline-start" />
                ) : (
                  <ArrowDown data-icon="inline-start" />
                )}
                {control.query.sortOrder === "asc" ? "升序" : "降序"}
              </Button>
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
            </>
          )}
        </FieldGroup>
      </form>
      {isMobile && (
        <>
          {selectedMode && <ErrorNotice error={lookup?.error} />}
          <div
            className="flex min-w-0 items-center gap-2"
            data-list-mobile-actions
          >
            {mobileLeading}
            <ListFilterSheet
              control={control}
              sorts={sorts}
              filters={filters}
              disabled={busy}
              compact={!!mobileLeading}
            />
            {mobileActions && (
              <div className="ml-auto flex shrink-0 items-center gap-2">
                {mobileActions}
              </div>
            )}
          </div>
          {summaries.length > 0 && (
            <div
              className="flex min-w-0 items-center gap-2"
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
      {children && (
        <div className="flex flex-wrap items-center gap-2">{children}</div>
      )}
      {!isMobile && control.query.q && (
        <p className="text-xs break-all text-muted-foreground">
          当前关键词：{control.query.q} · 搜索全部匹配记录，不仅当前页
        </p>
      )}
    </div>
  );
}
