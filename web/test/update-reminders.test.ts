import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  dismissUpdateVersion,
  getUpdateReminder,
  markUpdatePresented,
  restoreUpdateReminders,
  updateDismissedKeyPrefix,
  updatePresentedKeyPrefix,
  useUpdateReminder,
} from "../src/lib/update-reminders";
import type { UpdateChannel } from "../src/lib/update-preferences";

function storageEvent(key: string | null, newValue: string | null, area: Storage | null = localStorage) {
  window.dispatchEvent(new StorageEvent("storage", { key, newValue, storageArea: area }));
}

function remoteWrite(key: string, value: string | null) {
  if (value === null) localStorage.removeItem(key);
  else localStorage.setItem(key, value);
  storageEvent(key, value);
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  // A browser storage clear also resets choices retained after a blocked write.
  const view = renderHook(() => useUpdateReminder("prerelease"));
  act(() => storageEvent(null, null));
  view.unmount();
});

describe("browser update reminders", () => {
  it("loads an existing presentation across channels and new mounts", () => {
    localStorage.setItem(updatePresentedKeyPrefix + "1.0.0", "1");
    const view = renderHook(({ channel }: { channel: UpdateChannel }) => useUpdateReminder(channel, "1.0.0"), {
      initialProps: { channel: "stable" },
    });
    expect(view.result.current).toEqual({ presented: true, ignored: false, dismissedVersion: null });
    view.rerender({ channel: "prerelease" });
    expect(view.result.current.presented).toBe(true);
    view.unmount();
    const next = renderHook(() => useUpdateReminder("stable", "1.0.0"));
    expect(next.result.current.presented).toBe(true);
    expect(markUpdatePresented("1.0.0")).toBe(false);
  });

  it("records each exact version independently, including a newer stable release below a seen prerelease", () => {
    expect(markUpdatePresented("2.0.0-alpha.1")).toBe(true);
    expect(markUpdatePresented("1.1.0")).toBe(true);
    expect(getUpdateReminder("stable", "1.1.0").presented).toBe(true);
    expect(getUpdateReminder("prerelease", "2.0.0-alpha.1").presented).toBe(true);
    expect(getUpdateReminder("prerelease", "2.0.0-alpha.2").presented).toBe(false);
    expect(localStorage.getItem(updatePresentedKeyPrefix + "1.1.0")).toBe("1");
    expect(localStorage.getItem(updatePresentedKeyPrefix + "2.0.0-alpha.1")).toBe("1");
  });

  it("uses SemVer precedence for per-channel dismissal and never lowers a newer dismissal", () => {
    dismissUpdateVersion("prerelease", "1.0.0-rc.2");
    expect(getUpdateReminder("prerelease", "1.0.0-rc.1").ignored).toBe(true);
    expect(getUpdateReminder("prerelease", "1.0.0-rc.10").ignored).toBe(false);
    dismissUpdateVersion("prerelease", "1.0.0-rc.10");
    dismissUpdateVersion("prerelease", "1.0.0-rc.2");
    expect(getUpdateReminder("prerelease", "1.0.0-rc.10")).toEqual({
      presented: false, ignored: true, dismissedVersion: "1.0.0-rc.10",
    });
    expect(getUpdateReminder("prerelease", "1.0.0").ignored).toBe(false);
    dismissUpdateVersion("prerelease", "1.0.0");
    expect(getUpdateReminder("prerelease", "1.0.0-rc.10").ignored).toBe(true);
    expect(getUpdateReminder("prerelease", "1.1.0-alpha.1").ignored).toBe(false);
    expect(getUpdateReminder("stable", "1.0.0").ignored).toBe(false);
    expect(localStorage.getItem(updateDismissedKeyPrefix + "prerelease")).toBe("1.0.0");
  });

  it("keeps presentation, dismissal, and existing update preferences independent", () => {
    const preferences = JSON.stringify({ automatic: false, channel: "stable" });
    localStorage.setItem("perpay:update-preferences", preferences);
    dismissUpdateVersion("stable", "1.0.0");
    dismissUpdateVersion("prerelease", "1.1.0-rc.1");
    expect(getUpdateReminder("stable", "1.0.0").presented).toBe(false);
    expect(markUpdatePresented("1.0.0")).toBe(true);
    restoreUpdateReminders("stable");
    expect(getUpdateReminder("stable", "1.0.0")).toEqual({
      presented: true, ignored: false, dismissedVersion: null,
    });
    expect(getUpdateReminder("prerelease", "1.1.0-rc.1").ignored).toBe(true);
    expect(localStorage.getItem("perpay:update-preferences")).toBe(preferences);
  });

  it("does not ignore an absent or invalid candidate but retains the restore-reminder state", () => {
    dismissUpdateVersion("prerelease", "1.0.0");
    expect(getUpdateReminder("prerelease")).toEqual({ presented: false, ignored: false, dismissedVersion: "1.0.0" });
    expect(getUpdateReminder("prerelease", "1.0.0-rc.01").ignored).toBe(false);
  });

  it.each(["v1.0.0", "1.0.0-rc.01", "1.0.0+build", " 1.0.0", "{}", '"1.0.0"'])(
    "ignores malformed stored versions (%s)", (stored) => {
      localStorage.setItem(updateDismissedKeyPrefix + "stable", stored);
      localStorage.setItem(updatePresentedKeyPrefix + "1.0.0", "true");
      const view = renderHook(() => useUpdateReminder("stable", "1.0.0"));
      expect(view.result.current).toEqual({ presented: false, ignored: false, dismissedVersion: null });
      expect(markUpdatePresented(stored)).toBe(false);
      dismissUpdateVersion("stable", stored);
      expect(localStorage.getItem(updateDismissedKeyPrefix + "stable")).toBe(stored);
    },
  );

  it("synchronizes remote presentation, dismissal, restoration, and storage clearing", () => {
    const view = renderHook(() => useUpdateReminder("prerelease", "1.0.0-rc.2"));
    act(() => remoteWrite(updatePresentedKeyPrefix + "1.0.0-rc.2", "1"));
    expect(view.result.current.presented).toBe(true);
    act(() => remoteWrite(updateDismissedKeyPrefix + "prerelease", "1.0.0-rc.10"));
    expect(view.result.current).toEqual({ presented: true, ignored: true, dismissedVersion: "1.0.0-rc.10" });
    act(() => remoteWrite(updateDismissedKeyPrefix + "prerelease", null));
    expect(view.result.current).toEqual({ presented: true, ignored: false, dismissedVersion: null });
    act(() => {
      localStorage.clear();
      storageEvent(null, null);
    });
    expect(view.result.current).toEqual({ presented: false, ignored: false, dismissedVersion: null });
  });

  it("reads the latest stored value when older cross-tab events arrive late", () => {
    const view = renderHook(() => useUpdateReminder("prerelease", "1.0.0"));
    act(() => {
      localStorage.setItem(updateDismissedKeyPrefix + "prerelease", "2.0.0");
      storageEvent(updateDismissedKeyPrefix + "prerelease", "1.0.0");
    });
    expect(view.result.current.dismissedVersion).toBe("2.0.0");
    act(() => dismissUpdateVersion("prerelease", "1.5.0"));
    expect(localStorage.getItem(updateDismissedKeyPrefix + "prerelease")).toBe("2.0.0");
  });

  it("keeps snapshots stable for unrelated keys, another channel, and repeated presentation", () => {
    const view = renderHook(() => useUpdateReminder("stable", "1.0.0"));
    const initial = view.result.current;
    act(() => {
      markUpdatePresented("2.0.0");
      dismissUpdateVersion("prerelease", "2.0.0");
      remoteWrite("unrelated", "value");
    });
    expect(view.result.current).toBe(initial);
    act(() => { expect(markUpdatePresented("1.0.0")).toBe(true); });
    const presented = view.result.current;
    expect(presented.presented).toBe(true);
    act(() => { expect(markUpdatePresented("1.0.0")).toBe(false); });
    expect(view.result.current).toBe(presented);
  });

  it("retains functional in-memory choices when even accessing localStorage throws", () => {
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => { throw new DOMException("blocked", "SecurityError"); });
    const view = renderHook(() => useUpdateReminder("prerelease", "1.0.0"));
    act(() => {
      expect(markUpdatePresented("1.0.0")).toBe(true);
      dismissUpdateVersion("prerelease", "1.0.0");
    });
    expect(view.result.current).toEqual({ presented: true, ignored: true, dismissedVersion: "1.0.0" });
    act(() => restoreUpdateReminders("prerelease"));
    expect(view.result.current).toEqual({ presented: true, ignored: false, dismissedVersion: null });
    expect(markUpdatePresented("1.0.0")).toBe(false);
  });

  it("retains a previously read choice if later reads are blocked", () => {
    localStorage.setItem(updatePresentedKeyPrefix + "1.0.0", "1");
    localStorage.setItem(updateDismissedKeyPrefix + "stable", "1.0.0");
    const view = renderHook(() => useUpdateReminder("stable", "1.0.0"));
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("blocked", "SecurityError"); });
    view.rerender();
    expect(view.result.current).toEqual({ presented: true, ignored: true, dismissedVersion: "1.0.0" });
  });

  it("prefers failed-write memory choices over stale persisted values and supports restoring", () => {
    localStorage.setItem(updateDismissedKeyPrefix + "prerelease", "1.0.0-rc.2");
    const view = renderHook(() => useUpdateReminder("prerelease", "1.0.0-rc.10"));
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("full", "QuotaExceededError"); });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new DOMException("blocked", "SecurityError"); });
    act(() => {
      markUpdatePresented("1.0.0-rc.10");
      dismissUpdateVersion("prerelease", "1.0.0-rc.10");
    });
    expect(view.result.current).toEqual({ presented: true, ignored: true, dismissedVersion: "1.0.0-rc.10" });
    expect(localStorage.getItem(updateDismissedKeyPrefix + "prerelease")).toBe("1.0.0-rc.2");
    act(() => restoreUpdateReminders("prerelease"));
    expect(view.result.current).toEqual({ presented: true, ignored: false, dismissedVersion: null });
    view.unmount();
    const remounted = renderHook(() => useUpdateReminder("prerelease", "1.0.0-rc.10"));
    expect(remounted.result.current).toEqual({ presented: true, ignored: false, dismissedVersion: null });
  });

  it("ignores sessionStorage events even when local writes fell back to memory", () => {
    const view = renderHook(() => useUpdateReminder("stable", "1.0.0"));
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("full", "QuotaExceededError"); });
    act(() => {
      markUpdatePresented("1.0.0");
      dismissUpdateVersion("stable", "1.0.0");
    });
    const initial = view.result.current;
    act(() => {
      storageEvent(updatePresentedKeyPrefix + "1.0.0", null, sessionStorage);
      storageEvent(updateDismissedKeyPrefix + "stable", null, sessionStorage);
      storageEvent(null, null, sessionStorage);
    });
    expect(view.result.current).toBe(initial);
    expect(view.result.current).toEqual({ presented: true, ignored: true, dismissedVersion: "1.0.0" });
  });

  it("accepts a later real storage event after a write failure", () => {
    const view = renderHook(() => useUpdateReminder("stable", "1.0.0"));
    const blocked = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("full", "QuotaExceededError"); });
    act(() => dismissUpdateVersion("stable", "1.0.0"));
    expect(view.result.current.ignored).toBe(true);
    blocked.mockRestore();
    act(() => remoteWrite(updateDismissedKeyPrefix + "stable", "2.0.0"));
    expect(view.result.current.dismissedVersion).toBe("2.0.0");
    act(() => remoteWrite(updateDismissedKeyPrefix + "stable", null));
    expect(view.result.current.ignored).toBe(false);
  });
});
