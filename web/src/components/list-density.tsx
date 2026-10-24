import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Rows3 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Field, FieldLabel } from "@/components/ui/field";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

export type ListDensity = "compact" | "comfortable";
export const LIST_DENSITY_KEY = "perpay:list-density";
const normalize = (value: string | null): ListDensity => value === "comfortable" ? value : "compact";
const DensityContext = createContext<{ density: ListDensity; setDensity: (value: ListDensity) => void } | null>(null);
export function ListDensityProvider({ children }: { children: ReactNode }) {
  const [density, update] = useState<ListDensity>(() => {
    try { return normalize(localStorage.getItem(LIST_DENSITY_KEY)); } catch { return "compact"; }
  });
  useEffect(() => {
    function storage(event: StorageEvent) {
      if (event.key !== null && event.key !== LIST_DENSITY_KEY) return;
      try { if (event.storageArea !== localStorage) return; } catch { return; }
      update(event.key === null ? "compact" : normalize(event.newValue));
    }
    window.addEventListener("storage", storage);
    return () => window.removeEventListener("storage", storage);
  }, []);
  const setDensity = useCallback((value: ListDensity) => {
    update(value);
    try { localStorage.setItem(LIST_DENSITY_KEY, value); } catch { /* The current tab remains usable. */ }
  }, []);
  const value = useMemo(() => ({ density, setDensity }), [density, setDensity]);
  return <DensityContext value={value}>{children}</DensityContext>;
}
export const useListDensity = () => useContext(DensityContext)?.density ?? "compact";
export function ListDensityOptions() {
  const context = useContext(DensityContext);
  if (!context) return null;
  return <Field>
    <FieldLabel>列表密度</FieldLabel>
    <ToggleGroup variant="outline" aria-label="列表密度" value={[context.density]} onValueChange={values => {
      if (values[0] === "compact" || values[0] === "comfortable") context.setDensity(values[0]);
    }}>
      <ToggleGroupItem value="compact" className="flex-1">紧凑</ToggleGroupItem>
      <ToggleGroupItem value="comfortable" className="flex-1">舒适</ToggleGroupItem>
    </ToggleGroup>
  </Field>;
}
export function ListDensityControl({ compact }: { compact: boolean }) {
  const context = useContext(DensityContext);
  if (!context) return null;
  return <DropdownMenu>
    <DropdownMenuTrigger aria-label="列表密度" title="列表密度" render={<Button variant={compact ? "ghost" : "outline"} size={compact ? "icon-sm" : "sm"} />}>
      <Rows3 data-icon="inline-start" />{!compact && "密度"}
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end">
      <DropdownMenuGroup>
        <DropdownMenuLabel>列表密度</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={context.density} onValueChange={value => context.setDensity(normalize(value))}>
          <DropdownMenuRadioItem value="compact" closeOnClick>紧凑</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="comfortable" closeOnClick>舒适</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuGroup>
    </DropdownMenuContent>
  </DropdownMenu>;
}
