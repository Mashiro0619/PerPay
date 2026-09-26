export type ResponsiveColumn = {
  id: string;
  hideable?: boolean;
  /** Tailwind-compatible rem breakpoint used only until a user explicitly chooses. */
  responsive?: { minWidthRem: number; basis?: "viewport" | "container" };
};
export type ColumnOverrides = Record<string, boolean>;
export type TableSize = { viewport: number; container: number; rem: number };

function decode(raw: string | null): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw ?? "null");
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function readColumnOverrides(
  columns: readonly ResponsiveColumn[],
  current: string | null,
  legacy: string | null,
): ColumnOverrides {
  const saved = decode(current);
  const source = saved ?? decode(legacy) ?? {};
  return Object.fromEntries(
    columns.flatMap((column) => {
      const value = source[column.id];
      // Legacy tables wrote true for every default, so only false proves an explicit choice.
      return column.hideable !== false &&
        typeof value === "boolean" &&
        (saved !== null || value === false)
        ? [[column.id, value]]
        : [];
    }),
  );
}

export function resolveColumnVisibility(
  columns: readonly ResponsiveColumn[],
  overrides: ColumnOverrides,
  size: TableSize,
): ColumnOverrides {
  return Object.fromEntries(
    columns.map((column) => [
      column.id,
      column.hideable === false
        ? true
        : (overrides[column.id] ??
          (!column.responsive ||
            size[column.responsive.basis ?? "viewport"] >=
              column.responsive.minWidthRem * size.rem)),
    ]),
  );
}

export function updateColumnOverrides(
  columns: readonly ResponsiveColumn[],
  previous: ColumnOverrides,
  visible: ColumnOverrides,
  next: ColumnOverrides,
): ColumnOverrides {
  const result = { ...previous };
  for (const column of columns) {
    if (
      column.hideable !== false &&
      (next[column.id] ?? true) !== visible[column.id]
    ) {
      result[column.id] = next[column.id] ?? true;
    }
  }
  return result;
}
