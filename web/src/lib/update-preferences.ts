import { useSyncExternalStore } from "react";

export type UpdateChannel = "stable" | "prerelease";
export type UpdatePreferences = Readonly<{ automatic: boolean; channel: UpdateChannel }>;
export const updatePreferencesKey = "perpay:update-preferences";
const defaults: UpdatePreferences = { automatic: true, channel: "prerelease" };
let snapshot = defaults;
let rawSnapshot: string | null | undefined;
let memoryOnly = false;
const listeners = new Set<() => void>();

export function isUpdateChannel(value: unknown): value is UpdateChannel {
  return value === "stable" || value === "prerelease";
}

function parse(raw: string | null): UpdatePreferences {
  try {
    const value: unknown = raw === null ? null : JSON.parse(raw);
    if (!value || typeof value !== "object") return defaults;
    const stored = value as Record<string, unknown>;
    return {
      automatic: typeof stored.automatic === "boolean" ? stored.automatic : true,
      channel: isUpdateChannel(stored.channel) ? stored.channel : "prerelease",
    };
  } catch {
    return defaults;
  }
}

function getSnapshot(): UpdatePreferences {
  if (memoryOnly) return snapshot;
  try {
    const raw = window.localStorage.getItem(updatePreferencesKey);
    if (raw !== rawSnapshot) {
      rawSnapshot = raw;
      const next = parse(raw);
      if (next.automatic !== snapshot.automatic || next.channel !== snapshot.channel) snapshot = next;
    }
  } catch {
    // Browser privacy settings can make even reading localStorage throw.
  }
  return snapshot;
}

function storageChanged(event: StorageEvent) {
  if (event.key !== null && event.key !== updatePreferencesKey) return;
  try {
    if (event.storageArea !== null && event.storageArea !== window.localStorage) return;
  } catch { /* A blocked storage object still permits an in-memory fallback. */ }
  memoryOnly = false;
  rawSnapshot = undefined;
  snapshot = parse(event.newValue);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  if (listeners.size === 0) window.addEventListener("storage", storageChanged);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("storage", storageChanged);
  };
}

export function setUpdatePreferences(patch: Partial<UpdatePreferences>) {
  snapshot = { ...getSnapshot(), ...patch };
  const raw = JSON.stringify(snapshot);
  try {
    window.localStorage.setItem(updatePreferencesKey, raw);
    rawSnapshot = raw;
    memoryOnly = false;
  } catch {
    // Keep the user's selection functional even when persistence is unavailable.
    memoryOnly = true;
  }
  for (const listener of listeners) listener();
}

export function useUpdatePreferences() {
  return useSyncExternalStore(subscribe, getSnapshot, () => defaults);
}
