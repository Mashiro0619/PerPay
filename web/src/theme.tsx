import { useSyncExternalStore } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { Button } from "./components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
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
export function ThemeControl({ className }: { className?: string }) {
  const preference = useSyncExternalStore(
    subscribe,
    getPreference,
    () => "system",
  );
  const Icon = modes.find((mode) => mode.value === preference)?.icon ?? Monitor;
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
          <DropdownMenuRadioGroup
            value={preference}
            onValueChange={(value) =>
              window.perpayTheme?.setPreference(value as ThemePreference)
            }
          >
            {modes.map((mode) => (
              <DropdownMenuRadioItem key={mode.value} value={mode.value}>
                <mode.icon />
                {mode.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
