import {
  useEffect,
  useId,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  columnVisibilityFeature,
  rowSortingFeature,
  tableFeatures,
  useTable,
  type ColumnDef,
  type CellContext,
  type ColumnVisibilityState,
  type SortingState,
  type RowData,
} from "@tanstack/react-table";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Columns3,
  RotateCcw,
} from "lucide-react";
import { cn } from "cn";
import type { ListQueryControl } from "@/lib/list-query";
import {
  readColumnOverrides,
  resolveColumnVisibility,
  resolveSummaryVisibility,
  updateColumnOverrides,
  type ResponsiveColumn,
} from "@/lib/table-columns";
import { useCompactList } from "@/hooks/use-compact-list";
import { useListSize } from "@/hooks/use-list-size";
import { LinkedSummaryRow, LinkedTableRow } from "@/components/LinkedTableRow";
import { ListSummary } from "@/components/list-primitives";
import { ListColumnsMenu, useListDisplay } from "@/components/list-columns";
import { useListDensity } from "@/components/list-density";
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableCell,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { ItemGroup } from "@/components/ui/item";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
const features = tableFeatures({ columnVisibilityFeature, rowSortingFeature });
export type BusinessCellContext = {
  isSummary: boolean;
  isColumnVisible: (id: string) => boolean;
  /** Whether a selected field belongs in the always-visible part of a summary. */
  isSummaryPrimary: (id: string) => boolean;
  showInSummary: (id: string) => boolean;
  visibleColumnCount: number;
};
export type BusinessColumnLayout =
  | "identity"
  | "text"
  | "amount"
  | "status"
  | "datetime"
  | "number"
  | "actions";
export type BusinessColumn<T> = ResponsiveColumn & {
  label: string;
  cell: (item: T, context: BusinessCellContext) => ReactNode;
  sortBy?: string;
  className?: string;
  headerClassName?: string;
  align?: "left" | "center" | "right";
  layout?: BusinessColumnLayout;
  /** Summary placement, independent of the user's selected field preferences. */
  summaryPriority?: "primary" | "details";
};
type BusinessTableProps<T> = {
  id: string;
  items: T[];
  columns: BusinessColumn<T>[];
  rowId: (item: T) => string;
  control?: ListQueryControl | undefined;
  columnsMenu?: boolean;
  tableClassName?: string | ((context: BusinessCellContext) => string);
  renderSummary?: (item: T, context: BusinessCellContext) => ReactNode;
  density?: "default" | "compact" | "comfortable" | undefined;
  embedded?: boolean;
  "aria-label"?: string;
};

function columnLayout<T>(column: BusinessColumn<T>, index: number) {
  return column.layout ?? (index === 0 ? "identity" : "text");
}

function columnAlignment<T>(column: BusinessColumn<T>, index: number) {
  if (column.align) return column.align;
  const layout = columnLayout(column, index);
  return layout === "amount" || layout === "number" || layout === "actions"
    ? "right"
    : "left";
}

function DefaultBusinessSummary<T>({
  item,
  columns,
  context,
}: {
  item: T;
  columns: BusinessColumn<T>[];
  context: BusinessCellContext;
}) {
  const visible = columns.filter((column) => context.isColumnVisible(column.id));
  const identity = visible.find(
    (column) => columnLayout(column, columns.indexOf(column)) === "identity",
  );
  const fields = visible.filter((column) => column !== identity);
  const renderFields = (primary: boolean) => fields
    .filter((column) => context.isSummaryPrimary(column.id) === primary)
    .map((column) => (
      <div
        key={column.id}
        className="business-summary-field"
        data-column-layout={columnLayout(column, columns.indexOf(column))}
        data-column-id={column.id}
      >
        <dt>{column.label}</dt>
        <dd>{column.cell(item, context)}</dd>
      </div>
    ));
  return (
    <ListSummary
      identity={identity && (
        <div
          className="business-summary-identity min-w-0"
          data-column-layout="identity"
          data-column-id={identity.id}
        >
          {identity.cell(item, context)}
        </div>
      )}
      details={renderFields(false)}
    >
      {renderFields(true)}
    </ListSummary>
  );
}
// FlexRender must keep the component type stable across refreshes and column changes.
function renderBusinessCell<T extends RowData>({
  row,
  column,
}: CellContext<typeof features, T>) {
  const meta = column.columnDef.meta as {
    business: BusinessColumn<T>;
    context: BusinessCellContext;
  };
  return meta.business.cell(row.original, meta.context);
}
export function BusinessTable<T extends RowData>(props: BusinessTableProps<T>) {
  return <BusinessTableView key={props.id} {...props} />;
}
function BusinessTableView<T extends RowData>({
  id,
  items,
  columns: specs,
  rowId,
  control,
  columnsMenu = true,
  tableClassName,
  renderSummary,
  density: requestedDensity,
  embedded = false,
  "aria-label": ariaLabel,
}: BusinessTableProps<T>) {
  const compact = useCompactList();
  const inlineColumns = useListDisplay();
  const columnsId = useId();
  const preference = useListDensity();
  const density = !requestedDensity || requestedDensity === "default" ? preference : requestedDensity;
  const { ref: container, size, isSummary } = useListSize();
  const storageKey = "perpay.table-columns.v2." + id;
  const [overrides, setOverrides] = useState<ColumnVisibilityState>(() => {
    try {
      return readColumnOverrides(
        specs,
        localStorage.getItem(storageKey),
        localStorage.getItem("perpay.table-columns." + id),
      );
    } catch {
      return {};
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(overrides));
    } catch {}
  }, [storageKey, overrides]);
  const visibility = useMemo(
    () =>
      isSummary
        ? resolveSummaryVisibility(specs, overrides)
        : resolveColumnVisibility(specs, overrides, size),
    [specs, overrides, size, isSummary],
  );
  const context = useMemo<BusinessCellContext>(
    () => ({
      isSummary,
      isColumnVisible: (key) => visibility[key] === true,
      isSummaryPrimary: (key) => {
        if (!visibility[key]) return false;
        const index = specs.findIndex((column) => column.id === key);
        const column = specs[index];
        if (!column) return false;
        const layout = columnLayout(column, index);
        if (layout === "identity" || layout === "actions") return true;
        return column.summaryPriority
          ? column.summaryPriority === "primary"
          : column.summaryDefault === true;
      },
      showInSummary: (key) =>
        !isSummary && visibility[key] === false && overrides[key] !== false,
      visibleColumnCount: Object.values(visibility).filter(Boolean).length,
    }),
    [visibility, overrides, isSummary, specs],
  );
  const sortColumn = control
    ? specs.find((column) => column.sortBy === control.query.sortBy)
    : undefined;
  const sorting: SortingState =
    sortColumn && control
      ? [{ id: sortColumn.id, desc: control.query.sortOrder === "desc" }]
      : [];
  const columns = useMemo<ColumnDef<typeof features, T>[]>(
    () =>
      specs.map((spec) => ({
        id: spec.id,
        accessorFn: (item: T) => rowId(item),
        header: spec.label,
        cell: renderBusinessCell,
        meta: { business: spec, context },
        enableHiding: spec.hideable !== false,
        enableSorting: !!spec.sortBy && !!control,
      })),
    [specs, rowId, !!control, context],
  );
  const table = useTable({
    features,
    data: items,
    columns,
    getRowId: rowId,
    manualSorting: true,
    enableMultiSort: false,
    enableSortingRemoval: false,
    state: { columnVisibility: visibility, sorting },
    onColumnVisibilityChange: (update) => {
      const next = typeof update === "function" ? update(visibility) : update;
      setOverrides((previous) =>
        updateColumnOverrides(specs, previous, visibility, next),
      );
    },
    onSortingChange: (update) => {
      const next = typeof update === "function" ? update(sorting) : update;
      const sort = next[0];
      const field = specs.find((column) => column.id === sort?.id)?.sortBy;
      if (sort && field) control?.setSort(field, sort.desc ? "desc" : "asc");
    },
  });
  const columnMenu = columnsMenu && (inlineColumns ? (
    <FieldSet data-list-columns-panel>
      <FieldLegend variant="label">
        {isSummary ? "显示信息（标识与操作固定）" : "显示列（标识与操作固定）"}
      </FieldLegend>
      <FieldGroup>
        {table.getAllLeafColumns().map((column) => (
          <Field key={column.id} orientation="horizontal" data-disabled={!column.getCanHide() || undefined}>
            <Checkbox
              id={columnsId + "-" + column.id}
              disabled={!column.getCanHide()}
              checked={column.getIsVisible()}
              onCheckedChange={(value) => column.toggleVisibility(value)}
            />
            <FieldLabel htmlFor={columnsId + "-" + column.id}>
              {specs.find((spec) => spec.id === column.id)?.label}
            </FieldLabel>
          </Field>
        ))}
      </FieldGroup>
      <Button
        type="button"
        variant="outline"
        disabled={Object.keys(overrides).length === 0}
        onClick={() => setOverrides({})}
      >
        <RotateCcw data-icon="inline-start" />
        恢复默认列
      </Button>
    </FieldSet>
  ) : (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant={compact ? "ghost" : "outline"}
            size={compact ? "icon-sm" : "sm"}
          />
        }
        aria-label="显示列"
        title={isSummary ? "显示信息" : "显示列"}
        data-list-columns-trigger
      >
        <Columns3 data-icon="inline-start" />
        {!compact && (isSummary ? "显示信息" : "显示列")}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        <DropdownMenuGroup>
          <DropdownMenuLabel>
            {isSummary
              ? "显示信息（标识与操作固定）"
              : "显示列（标识与操作固定）"}
          </DropdownMenuLabel>
          {table.getAllLeafColumns().map((column) => (
            <DropdownMenuCheckboxItem
              key={column.id}
              disabled={!column.getCanHide()}
              checked={column.getIsVisible()}
              onCheckedChange={(value) => column.toggleVisibility(!!value)}
            >
              {specs.find((spec) => spec.id === column.id)?.label}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem
            disabled={Object.keys(overrides).length === 0}
            onClick={() => setOverrides({})}
          >
            <RotateCcw />
            恢复默认列
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  ));
  return (
    <div
      ref={container}
      className="flex min-w-0 flex-col gap-2"
      data-business-table={id}
      data-list-layout={isSummary ? "summary" : "table"}
      data-density={density}
      data-embedded={embedded}
    >
      {columnMenu && <ListColumnsMenu summary={size.container > 0 ? isSummary : undefined}>{columnMenu}</ListColumnsMenu>}
      <div
        className="business-table-surface min-w-0 overflow-hidden"
        data-density={density}
        data-embedded={embedded}
      >
        {isSummary ? (
          <ItemGroup
            className="business-summary-list"
            aria-label={
              ariaLabel ?? (specs[0]?.label ? specs[0].label + "列表" : undefined)
            }
            data-density={density}
          >
            {table.getRowModel().rows.map((row) => (
              <LinkedSummaryRow key={row.id} rowId={row.id} density={density}>
                {renderSummary ? (
                  renderSummary(row.original, context)
                ) : (
                  <DefaultBusinessSummary
                    item={row.original}
                    columns={specs}
                    context={context}
                  />
                )}
              </LinkedSummaryRow>
            ))}
          </ItemGroup>
        ) : (
          <Table
            className={cn(
              typeof tableClassName === "function"
                ? tableClassName(context)
                : tableClassName,
              "business-table table-fixed",
            )}
            aria-label={ariaLabel}
            data-density={density}
            data-visible-columns={context.visibleColumnCount}
          >
            <colgroup>
              {table.getVisibleLeafColumns().map((column) => {
                const index = specs.findIndex((spec) => spec.id === column.id);
                const spec = specs[index]!;
                return (
                  <col
                    key={column.id}
                    className="business-table-column"
                    data-column-layout={columnLayout(spec, index)}
                    data-column-id={spec.id}
                  />
                );
              })}
            </colgroup>
            <TableHeader>
              {table.getHeaderGroups().map((group) => (
                <TableRow key={group.id}>
                  {group.headers.map((header) => {
                    const index = specs.findIndex(
                      (column) => column.id === header.column.id,
                    );
                    const spec = specs[index]!;
                    const sorted = header.column.getIsSorted();
                    const label = header.column.getCanSort() ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="-mx-2"
                        onClick={header.column.getToggleSortingHandler()}
                      >
                        {spec.label}
                        {sorted === "asc" ? (
                          <ArrowUp data-icon="inline-end" />
                        ) : sorted === "desc" ? (
                          <ArrowDown data-icon="inline-end" />
                        ) : (
                          <ArrowUpDown data-icon="inline-end" />
                        )}
                      </Button>
                    ) : (
                      <table.FlexRender header={header} />
                    );
                    return (
                      <TableHead
                        key={header.id}
                        className={cn(
                          spec.headerClassName,
                          columnAlignment(spec, index) === "right" && "text-right",
                        )}
                        data-column-layout={columnLayout(spec, index)}
                        data-column-id={spec.id}
                        data-column-align={columnAlignment(spec, index)}
                        aria-sort={
                          sorted
                            ? sorted === "asc"
                              ? "ascending"
                              : "descending"
                            : undefined
                        }
                      >
                        {label}
                      </TableHead>
                    );
                  })}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {table.getRowModel().rows.map((row) => (
                <LinkedTableRow key={row.id} rowId={row.id}>
                  {row.getVisibleCells().map((cell) => {
                    const index = specs.findIndex(
                      (column) => column.id === cell.column.id,
                    );
                    const spec = specs[index]!;
                    return (
                      <TableCell
                        key={cell.id}
                        className={cn(
                          spec.className,
                          columnAlignment(spec, index) === "right" && "text-right tabular-nums",
                        )}
                        data-column-layout={columnLayout(spec, index)}
                        data-column-id={spec.id}
                        data-column-align={columnAlignment(spec, index)}
                      >
                        <table.FlexRender cell={cell} />
                      </TableCell>
                    );
                  })}
                </LinkedTableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}
