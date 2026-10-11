import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

type ListColumnsHost = {
  target: HTMLDivElement | null;
  setTarget: (target: HTMLDivElement | null) => void;
  summary: boolean;
  setSummary: (summary: boolean) => void;
};

const ListColumnsContext = createContext<ListColumnsHost | null>(null);

/** One host per business list; column state remains with its BusinessTable. */
export function ListColumnsProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  const [summary, setSummary] = useState(false);
  const value = useMemo(() => ({ target, setTarget, summary, setSummary }), [target, summary]);
  return <ListColumnsContext value={value}>{children}</ListColumnsContext>;
}

export function useListSummary() {
  return useContext(ListColumnsContext)?.summary ?? false;
}

export function ListColumnsSlot() {
  const host = useContext(ListColumnsContext);
  return (
    <div
      ref={host?.setTarget}
      className="list-columns-slot flex items-center gap-2 empty:hidden"
      data-list-columns-slot
    />
  );
}

/** Portals preserve the table's state and clean up with the displayed result. */
export function ListColumnsMenu({ children, summary = false }: { children: ReactNode; summary?: boolean }) {
  const host = useContext(ListColumnsContext);
  const setSummary = host?.setSummary;
  useLayoutEffect(() => {
    // Keep the last measured layout while a query temporarily removes its rows.
    setSummary?.(summary);
  }, [setSummary, summary]);
  if (!host)
    return (
      <div className="business-table-toolbar flex items-center justify-end gap-2">
        {children}
      </div>
    );
  return host.target ? createPortal(children, host.target) : null;
}
