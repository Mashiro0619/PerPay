import { useId, useRef, useSyncExternalStore } from "react";
import { Check, Monitor, Moon, Sun } from "lucide-react";

import { Button } from "./components/ui";

export type ThemePreference = "light" | "dark" | "system";

declare global {
  interface Window {
    perpayTheme?: {
      getPreference: () => ThemePreference;
      setPreference: (preference: ThemePreference) => void;
      subscribe: (listener: () => void) => () => void;
    };
  }
}

const subscribe = (listener: () => void) => window.perpayTheme?.subscribe(listener) ?? (() => undefined);
const getPreference = () => window.perpayTheme?.getPreference() ?? "system";
const themes = [
  { value: "light", label: "浅色", icon: Sun },
  { value: "dark", label: "深色", icon: Moon },
  { value: "system", label: "跟随系统", icon: Monitor },
] as const;

export function ThemeControl({ className = "" }: { className?: string }) {
  const preference = useSyncExternalStore(subscribe, getPreference);
  const selected = themes.find((theme) => theme.value === preference)!;
  const triggerLabel = `切换主题，当前${selected.label}`;
  const popoverId = useId();
  const groupId = useId();
  const popover = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  return <div className={`theme-control ${className}`}>
    <Button ref={trigger} variant="quiet" className="theme-trigger icon-button" popoverTarget={popoverId} aria-label={triggerLabel} title={triggerLabel}>
      <selected.icon size={18} aria-hidden="true" />
    </Button>
    <div id={popoverId} ref={popover} popover="auto" className="theme-popover">
      <fieldset aria-label="外观主题">{themes.map((theme) => <label key={theme.value} className="theme-option">
        <input type="radio" name={groupId} value={theme.value} checked={theme.value === preference} onChange={() => {
          window.perpayTheme?.setPreference(theme.value);
          popover.current?.hidePopover();
          trigger.current?.focus();
        }} />
        <theme.icon size={17} aria-hidden="true" /><span>{theme.label}</span>{theme.value === preference && <Check size={16} aria-hidden="true" />}
      </label>)}</fieldset>
    </div>
  </div>;
}
