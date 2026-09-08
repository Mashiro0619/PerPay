import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useBlocker } from "react-router";

import { Button, Dialog } from "./components/ui";

const DraftContext = createContext({
  setDirty: (_id: string, _dirty: boolean) => undefined as void,
  requestDiscard: (action: () => void) => action(),
});

export function DraftProvider({ children }: { children: ReactNode }) {
  const [drafts, setDrafts] = useState<ReadonlySet<string>>(new Set());
  const [action, setAction] = useState<(() => void) | null>(null);
  const dirty = drafts.size > 0;
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty &&
    (currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search));
  const setDirty = useCallback((id: string, value: boolean) => setDrafts((current) => {
    if (current.has(id) === value) return current;
    const next = new Set(current);
    if (value) next.add(id); else next.delete(id);
    return next;
  }), []);
  const requestDiscard = (pendingAction: () => void) => {
    if (dirty) setAction(() => pendingAction); else pendingAction();
  };
  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);
  function cancel() {
    if (blocker.state === "blocked") blocker.reset();
    setAction(null);
  }
  return <DraftContext value={{ setDirty, requestDiscard }}>{children}
    {(blocker.state === "blocked" || action !== null) && <Dialog title="放弃未保存的修改？" description="当前修改尚未保存。继续操作会丢弃这些内容，已保存的配置不受影响。" onClose={cancel}>
      <div className="form-actions"><Button onClick={cancel}>继续编辑</Button><Button variant="danger" onClick={() => {
        const pendingAction = action;
        setAction(null);
        if (blocker.state === "blocked") blocker.proceed(); else pendingAction?.();
      }}>放弃修改并继续</Button></div>
    </Dialog>}
  </DraftContext>;
}

export const useDraftGuard = () => useContext(DraftContext);

export function useDirtyDraft(dirty: boolean) {
  const id = useId();
  const { setDirty } = useDraftGuard();
  useEffect(() => { setDirty(id, dirty); }, [id, dirty, setDirty]);
  useEffect(() => () => setDirty(id, false), [id, setDirty]);
}

export function useFormDraft() {
  const form = useRef<HTMLFormElement>(null);
  const baseline = useRef("");
  const [dirty, setDirty] = useState(false);
  useDirtyDraft(dirty);
  const snapshot = () => form.current ? JSON.stringify([...new FormData(form.current).entries()]) : "";
  useLayoutEffect(() => { baseline.current = snapshot(); }, []);
  return { form, dirty, onChange: () => setDirty(snapshot() !== baseline.current) };
}
