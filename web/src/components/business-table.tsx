import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
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
  updateColumnOverrides,
  type ResponsiveColumn,
  type TableSize,
} from "@/lib/table-columns";
import { useCompactList } from "@/hooks/use-compact-list";
import { LinkedTableRow } from "@/components/LinkedTableRow";
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableCell,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
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
  isColumnVisible: (id: string) => boolean;
  showInSummary: (id: string) => boolean;
  visibleColumnCount: number;
};
export type BusinessColumn<T> = ResponsiveColumn & {
  label: string;
  cell: (item: T, context: BusinessCellContext) => ReactNode;
  sortBy?: string;
  className?: string;
  headerClassName?: string;
  align?: "right";
};
type BusinessTableProps<T> = {
  id: string;
  items: T[];
  columns: BusinessColumn<T>[];
  rowId: (item: T) => string;
  control?: ListQueryControl | undefined;
  columnsMenu?: boolean;
  tableClassName?: string | ((context: BusinessCellContext) => string);
};
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
}: BusinessTableProps<T>) {
  const compact = useCompactList();
  const container = useRef<HTMLDivElement>(null);
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
  const [size, setSize] = useState<TableSize>({
    viewport: 0,
    container: 0,
    rem: 16,
  });
  useLayoutEffect(() => {
    function measure() {
      const viewport = window.innerWidth;
      const width =
        container.current?.getBoundingClientRect().width || viewport;
      const rem =
        Number.parseFloat(
          getComputedStyle(document.documentElement).fontSize,
        ) || 16;
      setSize((previous) =>
        previous.viewport === viewport &&
        previous.container === width &&
        previous.rem === rem
          ? previous
          : { viewport, container: width, rem },
      );
    }
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    if (container.current) observer?.observe(container.current);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(overrides));
    } catch {}
  }, [storageKey, overrides]);
  const visibility = useMemo(
    () => resolveColumnVisibility(specs, overrides, size),
    [specs, overrides, size],
  );
  const context = useMemo<BusinessCellContext>(
    () => ({
      isColumnVisible: (key) => visibility[key] === true,
      showInSummary: (key) =>
        visibility[key] === false && overrides[key] !== false,
      visibleColumnCount: Object.values(visibility).filter(Boolean).length,
    }),
    [visibility, overrides],
  );
  const sorting: SortingState = control
    ? [{ id: control.query.sortBy, desc: control.query.sortOrder === "desc" }]
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
      if (sort) control?.setSort(sort.id, sort.desc ? "desc" : "asc");
    },
  });
  const columnMenu = columnsMenu && (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant={compact ? "ghost" : "outline"}
            size={compact ? "icon-sm" : "sm"}
          />
        }
        aria-label="显示列"
        title="显示列"
        data-list-columns-trigger
      >
        <Columns3 data-icon="inline-start" />
        {!compact && "显示列"}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        <DropdownMenuGroup>
          <DropdownMenuLabel>显示列（标识与操作固定）</DropdownMenuLabel>
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
  );
  return (
    <div
      ref={container}
      className="flex min-w-0 flex-col gap-2"
      data-business-table={id}
    >
      {columnsMenu && !compact && (
        <div className="flex justify-end">{columnMenu}</div>
      )}
      <div className="min-w-0 overflow-hidden rounded-lg border">
        <Table
          className={
            typeof tableClassName === "function"
              ? tableClassName(context)
              : tableClassName
          }
        >
          <TableHeader>
            {table.getHeaderGroups().map((group) => (
              <TableRow key={group.id}>
                {group.headers.map((header, index) => {
                  const spec = specs.find(
                    (column) => column.id === header.column.id,
                  )!;
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
                        compact && columnsMenu && index === 0 && "py-0",
                        spec.align === "right" && "text-right",
                      )}
                      aria-sort={
                        sorted
                          ? sorted === "asc"
                            ? "ascending"
                            : "descending"
                          : undefined
                      }
                      aria-label={
                        compact && columnsMenu && index === 0
                          ? spec.label
                          : undefined
                      }
                    >
                      {compact && columnsMenu && index === 0 ? (
                        <div className="flex items-center gap-2">
                          {label}
                          {columnMenu}
                        </div>
                      ) : (
                        label
                      )}
                    </TableHead>
                  );
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.map((row) => (
              <LinkedTableRow key={row.id}>
                {row.getVisibleCells().map((cell) => {
                  const spec = specs.find(
                    (column) => column.id === cell.column.id,
                  )!;
                  return (
                    <TableCell
                      key={cell.id}
                      className={cn(
                        spec.className,
                        spec.align === "right" && "text-right tabular-nums",
                      )}
                    >
                      <table.FlexRender cell={cell} />
                    </TableCell>
                  );
                })}
              </LinkedTableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
