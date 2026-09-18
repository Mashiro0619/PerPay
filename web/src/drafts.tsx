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
export function DraftProvider({ children }: { children: ReactNode }) {
  const drafts = useRef(new Set<string>());
  const [dirty, setHasDrafts] = useState(false);
  const [action, setAction] = useState<(() => void) | null>(null);
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      drafts.current.size > 0 &&
      (currentLocation.pathname !== nextLocation.pathname ||
        currentLocation.search !== nextLocation.search),
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
  function cancel() {
    if (blocker.state === "blocked") blocker.reset();
    setAction(null);
  }
  return (
    <DraftContext value={{ setDirty, requestDiscard }}>
      {children}
      <AlertDialog
        open={blocker.state === "blocked" || action !== null}
        onOpenChange={(open) => {
          if (!open) cancel();
        }}
      >
        <AlertDialogContent>
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
