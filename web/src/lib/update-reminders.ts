import { useCallback, useMemo, useSyncExternalStore } from "react";
import { compareReleaseVersions, isReleaseVersion } from "../../../src/shared/release-version";
import { isUpdateChannel, type UpdateChannel } from "./update-preferences";

export const updatePresentedKeyPrefix = "perpay:update-presented:";
export const updateDismissedKeyPrefix = "perpay:update-dismissed:";

export type UpdateReminder = Readonly<{
  presented: boolean;
  ignored: boolean;
  dismissedVersion: string | null;
}>;

type StoredValue = { value: string | null; memoryOnly: boolean };
const values = new Map<string, StoredValue>();
const listeners = new Set<() => void>();

function read(key: string): string | null {
  const previous = values.get(key);
  if (previous?.memoryOnly) return previous.value;
  try {
    const value = window.localStorage.getItem(key);
    values.set(key, { value, memoryOnly: false });
    return value;
  } catch {
    // A blocked read must not erase a choice already made in this page.
    return previous?.value ?? null;
  }
}

function notify() {
  for (const listener of listeners) listener();
}

function write(key: string, value: string | null) {
  let memoryOnly = false;
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Prefer the user's in-memory choice to an older persisted value.
    memoryOnly = true;
  }
  values.set(key, { value, memoryOnly });
  notify();
}

function isReminderKey(key: string): boolean {
  return key === updateDismissedKeyPrefix + "stable" ||
    key === updateDismissedKeyPrefix + "prerelease" ||
    (key.startsWith(updatePresentedKeyPrefix) && isReleaseVersion(key.slice(updatePresentedKeyPrefix.length)));
}

function storageChanged(event: StorageEvent) {
  if (event.key !== null && !isReminderKey(event.key)) return;
  try {
    if (event.storageArea !== null && event.storageArea !== window.localStorage) return;
  } catch {
    // A known sessionStorage event must never change browser-wide reminders.
    try { if (event.storageArea !== null && event.storageArea === window.sessionStorage) return; }
    catch { return; }
  }
  if (event.key === null) values.clear();
  else values.set(event.key, { value: event.newValue, memoryOnly: false });
  notify();
}

function subscribe(listener: () => void) {
  if (listeners.size === 0) window.addEventListener("storage", storageChanged);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("storage", storageChanged);
  };
}

function dismissedVersion(channel: UpdateChannel): string | null {
  if (!isUpdateChannel(channel)) return null;
  const value = read(updateDismissedKeyPrefix + channel);
  return isReleaseVersion(value) ? value : null;
}

function wasPresented(version?: string): boolean {
  return isReleaseVersion(version) && read(updatePresentedKeyPrefix + version) === "1";
}

function reminder(presented: boolean, dismissed: string | null, version?: string): UpdateReminder {
  return Object.freeze({
    presented,
    dismissedVersion: dismissed,
    ignored: dismissed !== null && isReleaseVersion(version) && compareReleaseVersions(version, dismissed) <= 0,
  });
}

/** Re-read browser storage immediately before deciding whether to open a dialog. */
export function getUpdateReminder(channel: UpdateChannel, version?: string): UpdateReminder {
  return reminder(wasPresented(version), dismissedVersion(channel), version);
}

const notPresented = () => false;
const notDismissed = () => null;

export function useUpdateReminder(channel: UpdateChannel, version?: string): UpdateReminder {
  const presented = useSyncExternalStore(subscribe, useCallback(() => wasPresented(version), [version]), notPresented);
  const dismissed = useSyncExternalStore(subscribe, useCallback(() => dismissedVersion(channel), [channel]), notDismissed);
  return useMemo(() => reminder(presented, dismissed, version), [presented, dismissed, version]);
}

/** Returns whether this page recorded the version for the first time. */
export function markUpdatePresented(version: string): boolean {
  if (!isReleaseVersion(version) || wasPresented(version)) return false;
  write(updatePresentedKeyPrefix + version, "1");
  return true;
}

export function dismissUpdateVersion(channel: UpdateChannel, version: string): void {
  if (!isUpdateChannel(channel) || !isReleaseVersion(version)) return;
  const previous = dismissedVersion(channel);
  // A tab with an older result must not lower a newer tab's dismissal threshold.
  if (previous !== null && compareReleaseVersions(previous, version) >= 0) return;
  write(updateDismissedKeyPrefix + channel, version);
}

export function restoreUpdateReminders(channel: UpdateChannel): void {
  if (isUpdateChannel(channel)) write(updateDismissedKeyPrefix + channel, null);
}
