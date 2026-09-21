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
import { useBlocker } from "react-router";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";
const DraftContext = createContext({
  setDirty: (_id: string, _dirty: boolean) => undefined as void,
  requestDiscard: (action: () => void) => action(),
});
type NavigationCheck = () => boolean;
const OperationNavigationContext = createContext({
  setProtection: (_id: string, _check: NavigationCheck | null) =>
    undefined as void,
  blockedId: null as string | null,
  hasDrafts: false,
  stay: () => undefined as void,
  proceed: (_onLeave: () => void) => undefined as void,
});
export function DraftProvider({ children }: { children: ReactNode }) {
  const drafts = useRef(new Set<string>());
  const protections = useRef(new Map<string, NavigationCheck>());
  const operationWasBlocked = useRef(false);
  const [protectionVersion, setProtectionVersion] = useState(0);
  const [dirty, setHasDrafts] = useState(false);
  const [action, setAction] = useState<(() => void) | null>(null);
  const protectedOperation = () =>
    [...protections.current].reverse().find(([, check]) => check())?.[0] ??
    null;
  // React Router supports one blocker. Keep submitted operations and drafts
  // in the same arbiter rather than letting either guard replace the other.
  const blocker = useBlocker(({ currentLocation, nextLocation }) => {
    if (
      currentLocation.pathname === nextLocation.pathname &&
      currentLocation.search === nextLocation.search
    )
      return false;
    operationWasBlocked.current = protectedOperation() !== null;
    return operationWasBlocked.current || drafts.current.size > 0;
  });
  const blockedId = blocker.state === "blocked" ? protectedOperation() : null;
  const setProtection = useCallback(
    (id: string, check: NavigationCheck | null) => {
      if (check) protections.current.set(id, check);
      else protections.current.delete(id);
      setProtectionVersion((version) => version + 1);
    },
    [],
  );
  const setDirty = useCallback((id: string, value: boolean) => {
    if (value) drafts.current.add(id);
    else drafts.current.delete(id);
    setHasDrafts(drafts.current.size > 0);
  }, []);
  const requestDiscard = (pendingAction: () => void) => {
    if (drafts.current.size > 0) setAction(() => pendingAction);
    else pendingAction();
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
    // If the operation completes while the user is choosing, honor their
    // requested navigation without presenting a now-irrelevant warning.
    if (
      blocker.state === "blocked" &&
      operationWasBlocked.current &&
      !blockedId &&
      !dirty
    ) {
      operationWasBlocked.current = false;
      blocker.proceed();
    }
  }, [blocker, blockedId, dirty, protectionVersion]);
  function cancel() {
    operationWasBlocked.current = false;
    if (blocker.state === "blocked") blocker.reset();
    setAction(null);
  }
  function proceedOperation(onLeave: () => void) {
    if (blocker.state !== "blocked") return;
    operationWasBlocked.current = false;
    onLeave();
    blocker.proceed();
  }
  return (
    <DraftContext value={{ setDirty, requestDiscard }}>
      <OperationNavigationContext
        value={{
          setProtection,
          blockedId,
          hasDrafts: dirty,
          stay: cancel,
          proceed: proceedOperation,
        }}
      >
        {children}
      </OperationNavigationContext>
      <AlertDialog
        open={
          (blocker.state === "blocked" && blockedId === null && dirty) ||
          action !== null
        }
        onOpenChange={(open) => {
          if (!open) cancel();
        }}
      >
        <AlertDialogContent className="max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle>放弃未保存的修改？</AlertDialogTitle>
            <AlertDialogDescription>
              此页面的修改不会保存。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>继续编辑</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const pendingAction = action;
                setAction(null);
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
  const latest = useRef(check);
  latest.current = check;
  const { setProtection, blockedId, hasDrafts, stay, proceed } = useContext(
    OperationNavigationContext,
  );
  useLayoutEffect(() => {
    // Register a live check even before the first send so a same-event
    // navigation observes the synchronous sending ref, not a stale render.
    setProtection(id, () => latest.current());
  }, [id, active, setProtection]);
  useLayoutEffect(() => () => setProtection(id, null), [id, setProtection]);
  return { blocked: blockedId === id, hasDrafts, stay, proceed };
}
export const useDraftGuard = () => useContext(DraftContext);
export function useDirtyDraft(dirty: boolean) {
  const id = useId();
  const { setDirty } = useDraftGuard();
  useEffect(() => {
    setDirty(id, dirty);
  }, [id, dirty, setDirty]);
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
