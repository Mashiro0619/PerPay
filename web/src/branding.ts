import { useSyncExternalStore } from "react";
import { DEFAULT_SYSTEM_NAME } from "../../src/shared/branding";

const event = "perpay:system-name-changed";
export function getSystemName(): string {
  const name = typeof document === "undefined" ? null : document.querySelector('meta[name="perpay-system-name"]')?.getAttribute("content");
  return name || DEFAULT_SYSTEM_NAME;
}
export function setSystemName(name: string): void {
  if (!name || name === getSystemName()) return;
  let meta = document.querySelector<HTMLMetaElement>('meta[name="perpay-system-name"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "perpay-system-name";
    document.head.append(meta);
  }
  meta.content = name;
  window.dispatchEvent(new Event(event));
}
function subscribe(listener: () => void) {
  window.addEventListener(event, listener);
  return () => window.removeEventListener(event, listener);
}
export function useSystemName(): string {
  return useSyncExternalStore(subscribe, getSystemName, () => DEFAULT_SYSTEM_NAME);
}
