import { DialogBody } from "@/components/admin-dialog";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { UNSAFE_LocationContext, useBlocker, type Location } from "react-router";
import { actualPageAddress } from "@/lib/navigation-selection";
import { overlayBackground, overlayOwner, readOverlayTarget } from "@/lib/overlay-navigation";
import { OverlayNavigationGuardContext, useOverlayContext } from "@/lib/overlay-context";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/admin-dialog";
const DraftContext = createContext({
  setDirty: (_id: string, _dirty: boolean, _owner?: string) => undefined as void,
  requestDiscard: (action: () => void) => action(),
  setDialogFinalFocus: (_element: HTMLElement | null) => undefined as void,
});
type NavigationCheck = () => boolean;
function backgroundOwner(location: Pick<Location, "pathname" | "search" | "hash">) {
  return "page:" + actualPageAddress(overlayBackground(location));
}
function retainedOwners(location: Pick<Location, "pathname" | "search" | "hash">) {
  const target = readOverlayTarget(location.search);
  return new Set([backgroundOwner(location), ...(target ? [overlayOwner(target)] : [])]);
}
function useDraftOwner() {
  const location = useContext(UNSAFE_LocationContext)?.location;
  const overlay = useOverlayContext();
  return overlay ? overlayOwner(overlay.target) : location ? backgroundOwner(location) : "*";
}
const OperationNavigationContext = createContext({
  setProtection: (_id: string, _check: NavigationCheck | null, _owner?: string) =>
    undefined as void,
  blockedId: null as string | null,
  hasDrafts: false,
  stay: () => undefined as void,
  proceed: (_onLeave: () => void) => undefined as void,
});
export function DraftProvider({ children }: { children: ReactNode }) {
  const drafts = useRef(new Map<string, string>());
  const protections = useRef(new Map<string, { check: NavigationCheck; owner: string }>());
  const dismissalGuards = useRef(new Map<string, { check: NavigationCheck; owner: string }>());
  const operationWasBlocked = useRef(false);
  const dismissalWasBlocked = useRef(false);
  const [protectionVersion, setProtectionVersion] = useState(0);
  const [dirty, setHasDrafts] = useState(false);
  const [action, setAction] = useState<(() => void) | null>(null);
  const dialogFinalFocus = useRef<HTMLElement | null>(null);
  const hasLeavingDrafts = (next: Location) => {
    const retained = retainedOwners(next);
    return [...drafts.current.values()].some(owner => !retained.has(owner));
  };
  const protectedOperation = (next: Location) => {
    const retained = retainedOwners(next);
    return [...protections.current].reverse().find(([, protection]) => !retained.has(protection.owner) && protection.check())?.[0] ?? null;
  };
  // React Router supports one blocker. Keep submitted operations and drafts
  // in the same arbiter rather than letting either guard replace the other.
  const blocker = useBlocker(({ currentLocation, nextLocation }) => {
    if (actualPageAddress(currentLocation) === actualPageAddress(nextLocation))
      return false;
    const retained = retainedOwners(nextLocation);
    dismissalWasBlocked.current = [...dismissalGuards.current.values()].some(guard => !retained.has(guard.owner) && guard.check());
    if (dismissalWasBlocked.current) return true;
    operationWasBlocked.current = protectedOperation(nextLocation) !== null;
    return operationWasBlocked.current || hasLeavingDrafts(nextLocation);
  });
  const blockedId = blocker.state === "blocked" && !dismissalWasBlocked.current ? protectedOperation(blocker.location) : null;
  const leavingDrafts = blocker.state === "blocked" && hasLeavingDrafts(blocker.location);
  const setProtection = useCallback(
    (id: string, check: NavigationCheck | null, owner = "*") => {
      if (check) protections.current.set(id, { check, owner });
      else protections.current.delete(id);
      setProtectionVersion((version) => version + 1);
    },
    [],
  );
  const setDirty = useCallback((id: string, value: boolean, owner = "*") => {
    if (value) drafts.current.set(id, owner);
    else drafts.current.delete(id);
    setHasDrafts(drafts.current.size > 0);
  }, []);
  const setDismissalGuard = useCallback((id: string, check: NavigationCheck | null, owner: string) => {
    if (check) dismissalGuards.current.set(id, { check, owner });
    else dismissalGuards.current.delete(id);
  }, []);
  const requestDiscard = (pendingAction: () => void) => {
    if (drafts.current.size > 0) setAction(() => pendingAction);
    else pendingAction();
  };
  const setDialogFinalFocus = useCallback((element: HTMLElement | null) => {
    dialogFinalFocus.current = element;
  }, []);
  const clearDialogFinalFocus = () => {
    const target = dialogFinalFocus.current;
    // Base UI reads finalFocus during the close cycle; clear it after that
    // cycle so a later unrelated confirmation cannot reuse this target.
    window.setTimeout(() => {
      if (dialogFinalFocus.current === target) dialogFinalFocus.current = null;
    }, 0);
  };
  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);
  useEffect(() => {
    if (blocker.state === "blocked" && dismissalWasBlocked.current) {
      dismissalWasBlocked.current = false;
      operationWasBlocked.current = false;
      blocker.reset();
      return;
    }
    // If the operation completes while the user is choosing, honor their
    // requested navigation without presenting a now-irrelevant warning.
    if (
      blocker.state === "blocked" &&
      operationWasBlocked.current &&
      !blockedId &&
      !leavingDrafts
    ) {
      operationWasBlocked.current = false;
      blocker.proceed();
    }
  }, [blocker, blockedId, leavingDrafts, protectionVersion]);
  function cancel() {
    operationWasBlocked.current = false;
    if (blocker.state === "blocked") blocker.reset();
    setAction(null);
    clearDialogFinalFocus();
  }
  function proceedOperation(onLeave: () => void) {
    if (blocker.state !== "blocked") return;
    operationWasBlocked.current = false;
    onLeave();
    blocker.proceed();
  }
  return (
    <DraftContext value={{ setDirty, requestDiscard, setDialogFinalFocus }}>
      <OperationNavigationContext
        value={{
          setProtection,
          blockedId,
          hasDrafts: blocker.state === "blocked" ? leavingDrafts : dirty,
          stay: cancel,
          proceed: proceedOperation,
        }}
      >
        <OverlayNavigationGuardContext value={setDismissalGuard}>{children}</OverlayNavigationGuardContext>
      </OperationNavigationContext>
      <AlertDialog
        open={
          (blocker.state === "blocked" && !dismissalWasBlocked.current && blockedId === null && leavingDrafts) ||
          action !== null
        }
        onOpenChange={(open) => {
          if (!open) cancel();
        }}
      >
        <AlertDialogContent
          finalFocus={dialogFinalFocus.current ? () => dialogFinalFocus.current : undefined}
          className="max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] overflow-y-auto"
        >
          <AlertDialogHeader>
            <AlertDialogTitle>放弃未保存的修改？</AlertDialogTitle>
          </AlertDialogHeader>
          <DialogBody><AlertDialogDescription>
              已提交的保存可能仍在执行，请重新读取后核对结果。
            </AlertDialogDescription></DialogBody>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => {
                const target = dialogFinalFocus.current;
                window.setTimeout(() => {
                  if (target?.isConnected) target.focus({ preventScroll: true });
                }, 0);
              }}
            >
              继续编辑
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const pendingAction = action;
                setAction(null);
                clearDialogFinalFocus();
                if (blocker.state === "blocked") blocker.proceed();
                else pendingAction?.();
              }}
            >
              放弃修改并继续
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DraftContext>
  );
}

export function useOperationNavigation(
  active: boolean,
  check: NavigationCheck,
) {
  const id = useId();
  const owner = useDraftOwner();
  const latest = useRef(check);
  latest.current = check;
  const { setProtection, blockedId, hasDrafts, stay, proceed } = useContext(
    OperationNavigationContext,
  );
  useLayoutEffect(() => {
    // Register a live check even before the first send so a same-event
    // navigation observes the synchronous sending ref, not a stale render.
    setProtection(id, () => latest.current(), owner);
  }, [id, active, setProtection, owner]);
  useLayoutEffect(() => () => setProtection(id, null), [id, setProtection]);
  return { blocked: blockedId === id, hasDrafts, stay, proceed };
}
export const useDraftGuard = () => useContext(DraftContext);
export const useHasDirtyDrafts = () => useContext(OperationNavigationContext).hasDrafts;
export function useDirtyDraft(dirty: boolean) {
  const id = useId();
  const owner = useDraftOwner();
  const { setDirty } = useDraftGuard();
  useEffect(() => {
    setDirty(id, dirty, owner);
  }, [id, dirty, setDirty, owner]);
  useEffect(() => () => setDirty(id, false), [id, setDirty]);
  return () => setDirty(id, false);
}
export function useFormDraft() {
  const form = useRef<HTMLFormElement>(null);
  const baseline = useRef("");
  const [dirty, setDirty] = useState(false);
  const clearGuard = useDirtyDraft(dirty);
  const snapshot = () =>
    form.current
      ? JSON.stringify([...new FormData(form.current).entries()])
      : "";
  useLayoutEffect(() => {
    baseline.current = snapshot();
  }, []);
  return {
    form,
    dirty,
    onChange: () => setDirty(snapshot() !== baseline.current),
    markSaved: (submitted: FormData) => {
      // The fieldset may still be disabled while its save resolves; use the submitted snapshot.
      baseline.current = JSON.stringify([...submitted.entries()]);
      setDirty(false);
      clearGuard();
    },
  };
}
