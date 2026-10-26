import { useSyncExternalStore } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { Button } from "./components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "./components/ui/dropdown-menu";
export type ThemePreference = "light" | "dark" | "system";
declare global {
  interface Window {
    perpayTheme?: {
      getPreference: () => ThemePreference;
      setPreference: (value: ThemePreference) => void;
      subscribe: (listener: () => void) => () => void;
    };
  }
}
const subscribe = (listener: () => void) =>
  window.perpayTheme?.subscribe(listener) ?? (() => undefined);
const getPreference = () => window.perpayTheme?.getPreference() ?? "system";
const modes = [
  { value: "light", label: "浅色", icon: Sun },
  { value: "dark", label: "深色", icon: Moon },
  { value: "system", label: "跟随系统", icon: Monitor },
] as const;
export function ThemeControl({ className, submenu = false }: { className?: string; submenu?: boolean }) {
  const preference = useSyncExternalStore(
    subscribe,
    getPreference,
    () => "system",
  );
  const Icon = modes.find((mode) => mode.value === preference)?.icon ?? Monitor;
  const choices = <DropdownMenuRadioGroup value={preference} onValueChange={(value) => window.perpayTheme?.setPreference(value as ThemePreference)}>
    {modes.map((mode) => <DropdownMenuRadioItem key={mode.value} value={mode.value} closeOnClick={submenu}><mode.icon />{mode.label}</DropdownMenuRadioItem>)}
  </DropdownMenuRadioGroup>;
  if (submenu) return <DropdownMenuSub>
    <DropdownMenuSubTrigger aria-label={"外观，当前" + modes.find((mode) => mode.value === preference)?.label}><Icon />外观</DropdownMenuSubTrigger>
    <DropdownMenuSubContent className="w-44 max-w-[calc(100vw-2rem)]">{choices}</DropdownMenuSubContent>
  </DropdownMenuSub>;
  return (
    <div className={className}>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              aria-label={
                "外观，当前" +
                modes.find((mode) => mode.value === preference)?.label
              }
            />
          }
        >
          <Icon data-icon="inline-start" />
          <span className="sr-only sm:not-sr-only">外观</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {choices}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
