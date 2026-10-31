import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useState } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invalidateSessionRequests, queryClient, sessionKey, type OfficialUpdate } from "../src/api/client";
import { UpdateDialog, type UpdateDialogRequest } from "../src/components/update-dialog";
import { DraftProvider, useDirtyDraft } from "../src/drafts";
import { WorkspaceSwitchingContext } from "../src/lib/workspace-navigation-state";
import { type UpdateChannel } from "../src/lib/update-preferences";
import { dismissUpdateVersion, getUpdateReminder, restoreUpdateReminders, updatePresentedKeyPrefix, updateDismissedKeyPrefix } from "../src/lib/update-reminders";

const update: OfficialUpdate = {
  status: "update_available", current_version: "0.2.0", latest_version: "0.3.0-rc.1",
  release_url: "https://github.com/Mashiro0619/PerPay/releases/tag/v0.3.0-rc.1",
  checked_at: "2026-10-31T03:00:00Z", published_at: "2026-10-30T03:00:00Z",
};
const upgradeGuide = "https://github.com/Mashiro0619/PerPay/blob/main/README.md#更新";
const lockDescriptor = Object.getOwnPropertyDescriptor(navigator, "locks");
let focus: ReturnType<typeof vi.spyOn>;

interface FixtureState {
  channel: UpdateChannel;
  candidate: OfficialUpdate | undefined;
  selection: object;
  request: UpdateDialogRequest | null;
  dirty: boolean;
  switching: boolean;
}

function mount(initial: Partial<FixtureState> = {}, strict = false) {
  let configure!: (patch: Partial<FixtureState>) => void;
  const handled = vi.fn();
  function Harness() {
    const [state, setState] = useState<FixtureState>({
      channel: "prerelease", candidate: update, selection: {}, request: null,
      dirty: false, switching: false, ...initial,
    });
    configure = patch => setState(previous => ({ ...previous, ...patch }));
    useDirtyDraft(state.dirty);
    return <WorkspaceSwitchingContext value={state.switching}>
      <main id="main-content" tabIndex={-1}><button>原来的操作</button></main>
      <UpdateDialog {...state} upgradeGuide={upgradeGuide} onRequestHandled={(request) => {
        handled(request);
        setState(previous => previous.request === request ? { ...previous, request: null } : previous);
      }} />
    </WorkspaceSwitchingContext>;
  }
  const router = createMemoryRouter([{ path: "/", element: <DraftProvider><Harness /></DraftProvider> }]);
  const content = <RouterProvider router={router} />;
  const view = render(strict ? <StrictMode>{content}</StrictMode> : content);
  return { ...view, handled, configure: (patch: Partial<FixtureState>) => act(() => configure(patch)) };
}

function clearReminderStorage() {
  const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index));
  for (const key of keys) if (key?.startsWith(updatePresentedKeyPrefix) || key?.startsWith(updateDismissedKeyPrefix)) localStorage.removeItem(key);
  window.dispatchEvent(new StorageEvent("storage", { key: null, newValue: null, storageArea: localStorage }));
}

beforeEach(() => {
  clearReminderStorage();
  queryClient.setQueryData(sessionKey, { authenticated: true });
  focus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
});
afterEach(() => {
  focus.mockRestore();
  if (lockDescriptor) Object.defineProperty(navigator, "locks", lockDescriptor);
  else Reflect.deleteProperty(navigator, "locks");
  document.querySelectorAll("[data-test-update-overlay]").forEach(element => element.remove());
});

async function acknowledge() {
  await userEvent.setup().click(within(screen.getByRole("dialog", { name: "发现新版本" })).getByRole("button", { name: "知道了" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "发现新版本" })).not.toBeInTheDocument());
}

describe("official update dialog", () => {
  it("presents a version once across remounts and channels, including StrictMode", async () => {
    const stable = { ...update, latest_version: "0.3.0", release_url: "https://github.com/Mashiro0619/PerPay/releases/tag/v0.3.0" };
    const view = mount({ candidate: stable }, true);
    const dialog = await screen.findByRole("dialog", { name: "发现新版本" });
    expect(within(dialog).getByText("v0.2.0")).toBeVisible();
    expect(within(dialog).getByText("v0.3.0")).toBeVisible();
    expect(within(dialog).getByRole("link", { name: "查看发布说明" })).toHaveAttribute("href", stable.release_url);
    expect(within(dialog).getByRole("link", { name: "更新方法" })).toHaveAttribute("rel", "noopener noreferrer");
    expect(getUpdateReminder("prerelease", stable.latest_version).presented).toBe(true);
    await acknowledge();
    view.configure({ channel: "stable", selection: {}, candidate: { ...stable } });
    expect(screen.queryByRole("dialog", { name: "发现新版本" })).not.toBeInTheDocument();
    view.unmount();
    mount({ channel: "stable", candidate: stable });
    await act(async () => { fireEvent(window, new Event("focus")); });
    expect(screen.queryByRole("dialog", { name: "发现新版本" })).not.toBeInTheDocument();
  });

  it("waits for a focused visible page without consuming the version", async () => {
    focus.mockReturnValue(false);
    mount();
    expect(getUpdateReminder("prerelease", update.latest_version).presented).toBe(false);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    act(() => { focus.mockReturnValue(true); fireEvent(window, new Event("focus")); });
    const dialog = await screen.findByRole("dialog", { name: "发现新版本" });
    expect(within(dialog).getByText("预发布")).toBeVisible();
    expect(getUpdateReminder("prerelease", update.latest_version).presented).toBe(true);
  });

  it.each(["dirty", "switching"] as const)("defers while %s without marking a version as presented", async gate => {
    const view = mount({ candidate: undefined, [gate]: true });
    await act(async () => {});
    view.configure({ candidate: update });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(getUpdateReminder("prerelease", update.latest_version).presented).toBe(false);
    view.configure({ [gate]: false });
    await screen.findByRole("dialog", { name: "发现新版本" });
  });

  it.each(["dialog-content", "alert-dialog-content", "sheet-content", "sidebar"])("waits until %s is removed after its closing animation", async slot => {
    const blocker = document.createElement("div");
    blocker.dataset.slot = slot;
    if (slot === "sidebar") blocker.dataset.overlayViewport = "sheet";
    blocker.dataset.testUpdateOverlay = "";
    document.body.append(blocker);
    mount();
    expect(screen.queryByRole("dialog", { name: "发现新版本" })).not.toBeInTheDocument();
    await act(async () => { blocker.dataset.closed = ""; blocker.style.opacity = "0"; });
    expect(getUpdateReminder("prerelease", update.latest_version).presented).toBe(false);
    await act(async () => blocker.remove());
    await screen.findByRole("dialog", { name: "发现新版本" });
  });

  it("does not treat a toast with the dialog role as a blocking modal", async () => {
    const toast = document.createElement("div");
    toast.setAttribute("role", "dialog");
    toast.dataset.slot = "toast";
    toast.dataset.testUpdateOverlay = "";
    document.body.append(toast);
    mount();
    await screen.findByRole("dialog", { name: "发现新版本" });
  });

  it("keeps manual viewing available for every request, including ignored versions", async () => {
    dismissUpdateVersion("prerelease", update.latest_version);
    const view = mount();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const request = { channel: "prerelease" as const, data: update, returnFocus: screen.getByRole("button", { name: "原来的操作" }) };
    view.configure({ request });
    await screen.findByRole("dialog", { name: "发现新版本" });
    await acknowledge();
    expect(request.returnFocus).toHaveFocus();
    expect(getUpdateReminder("prerelease", update.latest_version).ignored).toBe(true);
    view.configure({ request: { ...request } });
    await screen.findByRole("dialog", { name: "发现新版本" });
    expect(view.handled).toHaveBeenCalledTimes(2);
  });

  it.each(["disabled", "aria-disabled", "hidden"])("returns focus to the main content when its trigger is %s", async unavailable => {
    const view = mount({ candidate: undefined });
    const target = screen.getByRole("button", { name: "原来的操作" });
    if (unavailable === "hidden") target.style.display = "none";
    else target.setAttribute(unavailable, "true");
    view.configure({ request: { channel: "prerelease", data: update, returnFocus: target } });
    const popup = await screen.findByRole("dialog", { name: "发现新版本" });
    await waitFor(() => expect(within(popup).getByRole("heading", { name: "发现新版本" })).toHaveFocus());
    await acknowledge();
    expect(document.getElementById("main-content")).toHaveFocus();
  });

  it("dismisses the displayed snapshot and restoring reminders keeps its seen record", async () => {
    const view = mount();
    const dialog = await screen.findByRole("dialog", { name: "发现新版本" });
    const newer = { ...update, latest_version: "0.3.0", release_url: "https://github.com/Mashiro0619/PerPay/releases/tag/v0.3.0" };
    view.configure({ candidate: newer });
    expect(within(dialog).getByText("v0.3.0-rc.1")).toBeVisible();
    await userEvent.setup().click(within(dialog).getByRole("button", { name: "忽略此版本" }));
    expect(getUpdateReminder("prerelease").dismissedVersion).toBe(update.latest_version);
    await screen.findByText("v0.3.0");
    await acknowledge();
    view.configure({ candidate: update });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "发现新版本" })).not.toBeInTheDocument());
    act(() => restoreUpdateReminders("prerelease"));
    expect(getUpdateReminder("prerelease", update.latest_version)).toMatchObject({ presented: true, ignored: false });
    expect(screen.queryByRole("dialog", { name: "发现新版本" })).not.toBeInTheDocument();
  });

  it("drops a delayed claim when its channel changes before it can be displayed", async () => {
    const claims: Array<() => Promise<void>> = [];
    const requestLock = vi.fn((_name: string, _options: { signal: AbortSignal }, callback: () => Promise<void>) => new Promise<void>(resolve => {
      claims.push(async () => { await callback(); resolve(); });
    }));
    Object.defineProperty(navigator, "locks", { configurable: true, value: { request: requestLock } });
    const view = mount();
    await waitFor(() => expect(requestLock).toHaveBeenCalledTimes(1));
    view.configure({ selection: {}, channel: "stable", candidate: undefined });
    await act(async () => claims[0]!());
    expect(getUpdateReminder("prerelease", update.latest_version).presented).toBe(false);
    expect(screen.queryByRole("dialog", { name: "发现新版本" })).not.toBeInTheDocument();
  });

  it.each(["channel", "manual"])("cancels an ungranted automatic lock when a %s request replaces it", async replacement => {
    const claims: Array<() => Promise<void>> = [];
    const requestLock = vi.fn((_name: string, _options: { signal: AbortSignal }, callback: () => Promise<void>) => new Promise<void>(resolve => {
      claims.push(async () => { await callback(); resolve(); });
    }));
    Object.defineProperty(navigator, "locks", { configurable: true, value: { request: requestLock } });
    const view = mount();
    await waitFor(() => expect(requestLock).toHaveBeenCalledTimes(1));
    const newer = { ...update, latest_version: "0.3.0", release_url: "https://github.com/Mashiro0619/PerPay/releases/tag/v0.3.0" };
    const channel = replacement === "channel" ? "stable" : "prerelease";
    view.configure({
      ...(replacement === "channel" ? { channel, selection: {} } : {}),
      candidate: newer,
      request: { channel, data: newer, returnFocus: null },
    });
    // The stale lock is deliberately never granted before the manual view opens.
    await screen.findByRole("dialog", { name: "发现新版本" });
    expect(requestLock.mock.calls[0]![1].signal.aborted).toBe(true);
    expect(getUpdateReminder("prerelease", update.latest_version).presented).toBe(false);
    await acknowledge();
    await act(async () => claims[0]!());
    expect(screen.queryByRole("dialog", { name: "发现新版本" })).not.toBeInTheDocument();
  });

  it("does not mark or show a delayed claim after the administrator session expires", async () => {
    let claim!: () => Promise<void>;
    Object.defineProperty(navigator, "locks", { configurable: true, value: {
      request: vi.fn((_name: string, _options: { signal: AbortSignal }, callback: () => Promise<void>) => new Promise<void>(resolve => {
        claim = async () => { await callback(); resolve(); };
      })),
    } });
    mount();
    await waitFor(() => expect(claim).toBeDefined());
    await act(async () => {
      invalidateSessionRequests();
      queryClient.setQueryData(sessionKey, null);
      await claim();
    });
    expect(getUpdateReminder("prerelease", update.latest_version).presented).toBe(false);
    expect(screen.queryByRole("dialog", { name: "发现新版本" })).not.toBeInTheDocument();
  });
});
