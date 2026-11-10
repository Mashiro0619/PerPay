import { useCallback, useEffect, useRef, useState } from "react";
import { getSessionRequestGeneration, queryClient, sessionKey, type OfficialUpdate } from "@/api/client";
import { isPrereleaseVersion } from "../../../src/shared/release-version";
import { useHasDirtyDrafts } from "@/drafts";
import { useWorkspaceSwitching } from "@/lib/workspace-navigation-state";
import { type UpdateChannel } from "@/lib/update-preferences";
import { dismissUpdateVersion, getUpdateReminder, markUpdatePresented, useUpdateReminder } from "@/lib/update-reminders";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/admin-dialog";
import { CopyValue } from "@/components/copy-value";

export interface UpdateDialogRequest {
  readonly channel: UpdateChannel;
  readonly data: OfficialUpdate;
  readonly returnFocus: HTMLElement | null;
}

interface Props {
  channel: UpdateChannel;
  selection: object;
  candidate: OfficialUpdate | undefined;
  request: UpdateDialogRequest | null;
  onRequestHandled: (request: UpdateDialogRequest) => void;
  upgradeGuide: string;
}

interface Presentation extends UpdateDialogRequest {
  readonly selection: object;
  readonly generation: number;
  readonly request: UpdateDialogRequest | null;
  readonly controller: AbortController;
  shown: boolean;
  canceled: boolean;
  release: (() => void) | undefined;
}

function foreground() {
  return document.visibilityState === "visible" && document.hasFocus();
}

function otherOverlayOpen() {
  // Toasts also have role="dialog". Only the app's actual modal surfaces
  // participate, including their closing animation until removal or hiding.
  return Array.from(document.querySelectorAll<HTMLElement>(
    '[data-slot="dialog-content"], [data-slot="alert-dialog-content"], [data-slot="sheet-content"], [data-overlay-viewport="dialog"], [data-overlay-viewport="sheet"]',
  )).some(element => {
    if (element.hasAttribute("data-official-update-dialog") || element.closest("[hidden], [inert]")) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  });
}

function cancelPresentation(presentation: Presentation) {
  presentation.canceled = true;
  presentation.controller.abort();
  presentation.release?.();
}

function returnFocus(target: HTMLElement | null) {
  if (target?.isConnected && !target.matches(':disabled, [aria-disabled="true"]') &&
    !target.closest("[hidden], [inert]") && (target.tabIndex >= 0 || target.hasAttribute("tabindex") || target.isContentEditable)) {
    let visible = true;
    for (let element: HTMLElement | null = target; element; element = element.parentElement) {
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") {
        visible = false;
        break;
      }
    }
    if (visible) return target;
  }
  const content = document.getElementById("main-content");
  // Base UI would pick the first tabbable child of a tabindex=-1 container.
  // Restore the main region itself after the modal's focus trap is released.
  queueMicrotask(() => {
    if (content?.isConnected && !content.closest("[hidden], [inert]")) content.focus({ preventScroll: true });
  });
  return false;
}

function useDialogAvailability() {
  const read = () => ({ foreground: foreground(), blocked: otherOverlayOpen() });
  const [state, setState] = useState(read);
  useEffect(() => {
    const update = () => {
      const next = read();
      setState(previous => previous.foreground === next.foreground && previous.blocked === next.blocked ? previous : next);
    };
    const observer = new MutationObserver(update);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["hidden", "inert", "class", "style", "data-open", "data-closed", "data-ending-style"],
    });
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    document.addEventListener("visibilitychange", update);
    update();
    return () => {
      observer.disconnect();
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  return state;
}

export function UpdateDialog(props: Props) {
  const { channel, selection, candidate, request, onRequestHandled, upgradeGuide } = props;
  const dirty = useHasDirtyDrafts();
  const switching = useWorkspaceSwitching();
  const availability = useDialogAvailability();
  const reminder = useUpdateReminder(channel, candidate?.latest_version);
  const [presentation, setPresentation] = useState<Presentation | null>(null);
  const [open, setOpen] = useState(false);
  const [wake, setWake] = useState(0);
  const pending = useRef<Presentation | null>(null);
  const active = useRef(false);
  const title = useRef<HTMLHeadingElement>(null);
  const latest = useRef({ ...props, dirty, switching });
  latest.current = { ...props, dirty, switching };

  const canPresent = useCallback((next: Presentation) => {
    const current = latest.current;
    if (!active.current || next.canceled || next.selection !== current.selection ||
      next.channel !== current.channel || next.generation !== getSessionRequestGeneration() ||
      queryClient.getQueryData(sessionKey) == null || current.switching || !foreground() || otherOverlayOpen()) return false;
    if (next.request) return current.request === next.request;
    const saved = getUpdateReminder(next.channel, next.data.latest_version);
    return !current.dirty && current.candidate === next.data && !saved.ignored && !saved.presented;
  }, []);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      if (pending.current) {
        cancelPresentation(pending.current);
        pending.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const queued = pending.current;
    if (queued && !queued.shown && (!canPresent(queued) || (!queued.request && request !== null))) {
      // A canceled automatic lock must never hold up a newer channel or an
      // explicit request. Its eventual callback/finally cannot own the new one.
      cancelPresentation(queued);
      if (pending.current === queued) pending.current = null;
      if (presentation === queued) {
        setOpen(false);
        setPresentation(null);
      }
    }
  }, [presentation, candidate, channel, selection, request, canPresent, dirty, switching, availability, reminder.presented, reminder.ignored]);

  useEffect(() => {
    if (!presentation) return;
    if (presentation.selection !== selection || presentation.channel !== channel ||
      (!presentation.shown && !canPresent(presentation))) {
      cancelPresentation(presentation);
      setOpen(false);
      if (!presentation.shown) setPresentation(null);
    } else if (!presentation.request && getUpdateReminder(channel, presentation.data.latest_version).ignored) {
      setOpen(false);
    }
  }, [presentation, channel, selection, canPresent, dirty, switching, availability, reminder.ignored]);

  useEffect(() => {
    if (presentation || pending.current) return;
    const data = request?.data ?? candidate;
    if (!data || data.status !== "update_available") return;
    const focused = document.activeElement;
    const next: Presentation = {
      channel, selection, data, request,
      returnFocus: request?.returnFocus ?? (focused instanceof HTMLElement ? focused : null),
      generation: getSessionRequestGeneration(),
      controller: new AbortController(),
      shown: false, canceled: false, release: undefined,
    };
    if (!canPresent(next)) return;
    pending.current = next;
    const display = () => {
      if (!canPresent(next)) return Promise.resolve();
      // The optional cross-tab lock remains held until the popup is actually
      // mounted, or this candidate is canceled. Queuing never marks it seen.
      return new Promise<void>(resolve => {
        next.release = resolve;
        setPresentation(next);
        setOpen(true);
      });
    };
    let operation: Promise<unknown>;
    try {
      operation = !request && typeof navigator.locks?.request === "function"
        ? navigator.locks.request("perpay:update-dialog:" + data.latest_version, { signal: next.controller.signal }, display)
        : display();
    } catch {
      operation = display();
    }
    void operation.catch(() => next.canceled ? undefined : display()).finally(() => {
      if (pending.current === next) pending.current = null;
      if (active.current) setWake(value => value + 1);
    });
  }, [presentation, candidate, channel, selection, request, canPresent, dirty, switching, availability, reminder.presented, reminder.ignored, wake]);

  const mounted = useCallback((element: HTMLDivElement | null) => {
    if (!element || !presentation || presentation.shown || presentation.canceled) return;
    if (!canPresent(presentation)) {
      cancelPresentation(presentation);
      setOpen(false);
      setPresentation(null);
      return;
    }
    // This ref runs after the visible popup enters the DOM. Mark before
    // releasing the lock, so another tab cannot present the same version.
    presentation.shown = true;
    markUpdatePresented(presentation.data.latest_version);
    if (presentation.request) onRequestHandled(presentation.request);
    presentation.release?.();
  }, [presentation, canPresent, onRequestHandled]);

  if (!presentation) return null;
  const data = presentation.data;
  const close = () => setOpen(false);
  return (
    <Dialog open={open && !presentation.canceled && presentation.selection === selection} onOpenChange={setOpen}
      onOpenChangeComplete={(opened) => {
        if (!opened) {
          presentation.release?.();
          setPresentation(null);
        }
      }}>
      <DialogContent ref={mounted} data-official-update-dialog initialFocus={title}
        finalFocus={() => returnFocus(presentation.returnFocus)}>
        <DialogHeader>
          <DialogTitle ref={title} tabIndex={-1} className="outline-none">发现新版本</DialogTitle>
          <DialogDescription>PerPay 有可用更新，可查看发布说明和更新方法。</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <dl className="grid min-w-0 gap-3">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
              <dt>当前版本</dt>
              <dd className="flex min-w-0 flex-wrap items-center gap-2"><span className="break-all font-mono">v{data.current_version}</span>{isPrereleaseVersion(data.current_version) && <Badge variant="secondary">预发布</Badge>}</dd>
            </div>
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
              <dt>最新版本</dt>
              <dd className="flex min-w-0 flex-wrap items-center gap-2"><span className="break-all font-mono">v{data.latest_version}</span>{isPrereleaseVersion(data.latest_version) && <Badge variant="secondary">预发布</Badge>}</dd>
            </div>
          </dl>
          <div className="flex min-w-0 flex-col gap-2">
            <p>目标镜像</p>
            <CopyValue value={"ghcr.io/mashiro0619/perpay:" + data.latest_version} label="复制目标镜像" />
            <p className="text-sm text-muted-foreground">将部署配置中的 x-perpay-image 改为此标签，再拉取并重启。</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <a data-external-link className={buttonVariants({ variant: "outline", size: "sm" })} href={data.release_url} target="_blank" rel="noopener noreferrer">查看发布说明</a>
            <a data-external-link className={buttonVariants({ variant: "ghost", size: "sm" })} href={upgradeGuide.replace("/blob/main/", "/blob/v" + data.latest_version + "/")} target="_blank" rel="noopener noreferrer">更新方法</a>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => { dismissUpdateVersion(presentation.channel, data.latest_version); close(); }}>忽略此版本</Button>
          <Button onClick={close}>知道了</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
