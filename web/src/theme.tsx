import { useId, useRef, useSyncExternalStore } from "react";
import { Check, Monitor, Moon, Palette, Sun, X } from "lucide-react";
import { Button } from "./components/ui";

export type ThemePreference = "light" | "dark" | "system";
export type PalettePreference = "blue" | "bamboo" | "sand" | "violet" | "graphite";
declare global {
  interface Window {
    perpayTheme?: {
      getPreference: () => ThemePreference;
      getPalette: () => PalettePreference;
      setPreference: (preference: ThemePreference) => void;
      setPalette: (palette: PalettePreference) => void;
      subscribe: (listener: () => void) => () => void;
    };
  }
}
const subscribe = (listener: () => void) => window.perpayTheme?.subscribe(listener) ?? (() => undefined);
const getPreference = () => window.perpayTheme?.getPreference() ?? "system";
const getPalette = () => window.perpayTheme?.getPalette() ?? "blue";
const modes = [{ value: "light", label: "浅色", icon: Sun }, { value: "dark", label: "深色", icon: Moon }, { value: "system", label: "跟随系统", icon: Monitor }] as const;
export const palettes = [{ value: "blue", label: "经典蓝" }, { value: "bamboo", label: "青竹" }, { value: "sand", label: "暖砂" }, { value: "violet", label: "柔紫" }, { value: "graphite", label: "石墨" }] as const;
export function ThemeControl({ className = "" }: { className?: string }) {
  const preference = useSyncExternalStore(subscribe, getPreference);
  const palette = useSyncExternalStore(subscribe, getPalette);
  const id = useId(); const modeId = useId(); const paletteId = useId();
  const popover = useRef<HTMLDivElement>(null); const trigger = useRef<HTMLButtonElement>(null);
  const description = (palettes.find(item => item.value === palette)?.label ?? "经典蓝") + " · " + modes.find(item => item.value === preference)!.label;
  function close() { popover.current?.hidePopover(); trigger.current?.focus(); }
  return <div className={"theme-control " + className}>
    <Button ref={trigger} variant="quiet" className="theme-trigger" popoverTarget={id} aria-label={"外观，当前" + description} title={"外观：" + description}><Palette size={18} aria-hidden="true" /><span>外观</span></Button>
    <div id={id} ref={popover} popover="auto" className="theme-popover" onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); } }}>
      <header className="appearance-heading"><strong>外观</strong><Button className="icon-button" variant="quiet" aria-label="关闭外观面板" onClick={close}><X size={17} /></Button></header>
      <fieldset className="palette-options"><legend>配色</legend>{palettes.map(item => <label key={item.value} className="palette-option">
        <input type="radio" name={paletteId} value={item.value} checked={palette === item.value} onChange={() => window.perpayTheme?.setPalette(item.value)} />
        <span className={"palette-sample palette-sample--" + item.value} aria-hidden="true"><i /><i /><i /></span><span>{item.label}</span>{palette === item.value && <Check size={15} aria-hidden="true" />}
      </label>)}</fieldset>
      <fieldset className="mode-options"><legend>明暗</legend>{modes.map(item => <label className="mode-option" key={item.value}>
        <input type="radio" name={modeId} value={item.value} checked={preference === item.value} onChange={() => window.perpayTheme?.setPreference(item.value)} />
        <item.icon size={16} aria-hidden="true" /><span>{item.label}</span>
      </label>)}</fieldset>
    </div>
  </div>;
}
