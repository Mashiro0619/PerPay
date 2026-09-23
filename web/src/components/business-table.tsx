import { useEffect, useMemo, useState, type ReactNode } from "react";
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
import { ArrowDown, ArrowUp, ArrowUpDown, Columns3 } from "lucide-react";
import { cn } from "cn";
import type { ListQueryControl } from "@/lib/list-query";
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
} from "@/components/ui/dropdown-menu";
const features = tableFeatures({ columnVisibilityFeature, rowSortingFeature });
export type BusinessColumn<T> = {
  id: string;
  label: string;
  cell: (item: T) => ReactNode;
  sortBy?: string;
  hideable?: boolean;
  className?: string;
  headerClassName?: string;
  align?: "right";
};
// FlexRender treats a cell function as a component type. Keep that type stable so
// refreshes do not replace focused links, restore buttons or their pending state.
function renderBusinessCell<T extends RowData>({row,column}:CellContext<typeof features,T>) {
  const meta = column.columnDef.meta as {business:BusinessColumn<T>};
  return meta.business.cell(row.original);
}
export function BusinessTable<T extends RowData>({
  id,
  items,
  columns: specs,
  rowId,
  control,
  columnsMenu = true,
  tableClassName,
}: {
  id: string;
  items: T[];
  columns: BusinessColumn<T>[];
  rowId: (item: T) => string;
  control?: ListQueryControl | undefined;
  columnsMenu?: boolean;
  tableClassName?: string;
}) {
  const storageKey = "perpay.table-columns." + id;
  const [visibility, setVisibility] = useState<ColumnVisibilityState>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
      return Object.fromEntries(
        specs
          .filter((column) => column.hideable !== false)
          .map((column) => [column.id, saved?.[column.id] !== false]),
      );
    } catch {
      return {};
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(visibility));
    } catch {}
  }, [storageKey, visibility]);
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
        meta: {business: spec},
        enableHiding: spec.hideable !== false,
        enableSorting: !!spec.sortBy && !!control,
      })),
    [specs, rowId, !!control],
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
    onColumnVisibilityChange: setVisibility,
    onSortingChange: (update) => {
      const next = typeof update === "function" ? update(sorting) : update;
      const sort = next[0];
      if (sort) control?.setSort(sort.id, sort.desc ? "desc" : "asc");
    },
  });
  return (
    <div className="flex min-w-0 flex-col gap-2" data-business-table={id}>
      {columnsMenu && (
        <div className="flex justify-end">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="outline" size="sm" />}
            >
              <Columns3 data-icon="inline-start" />
              显示列
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuGroup>
                <DropdownMenuLabel>显示列（标识与操作固定）</DropdownMenuLabel>
                {table.getAllLeafColumns().map((column) => (
                  <DropdownMenuCheckboxItem
                    key={column.id}
                    disabled={!column.getCanHide()}
                    checked={column.getIsVisible()}
                    onCheckedChange={(value) =>
                      column.toggleVisibility(!!value)
                    }
                  >
                    {specs.find((spec) => spec.id === column.id)?.label}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
      <div className="min-w-0 overflow-hidden rounded-lg border">
        <Table className={tableClassName}>
          <TableHeader>
            {table.getHeaderGroups().map((group) => (
              <TableRow key={group.id}>
                {group.headers.map((header) => {
                  const spec = specs.find(
                    (column) => column.id === header.column.id,
                  )!;
                  const sorted = header.column.getIsSorted();
                  return (
                    <TableHead
                      key={header.id}
                      className={cn(
                        spec.headerClassName ?? spec.className,
                        spec.align === "right" && "text-right",
                      )}
                      aria-sort={
                        sorted
                          ? sorted === "asc"
                            ? "ascending"
                            : "descending"
                          : undefined
                      }
                    >
                      {header.column.getCanSort() ? (
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
