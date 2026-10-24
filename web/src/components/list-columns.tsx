import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "cn";

type ListColumnsHost = {
  target: HTMLDivElement | null;
  setTarget: (target: HTMLDivElement | null) => void;
  summary: boolean;
  setSummary: (summary: boolean) => void;
  display: boolean;
  setDisplay: (display: boolean) => void;
};

const ListColumnsContext = createContext<ListColumnsHost | null>(null);

/** One host per business list; column state remains with its BusinessTable. */
export function ListColumnsProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  const [summary, setSummary] = useState(false);
  const [display, setDisplay] = useState(false);
  const value = useMemo(() => ({ target, setTarget, summary, setSummary, display, setDisplay }), [target, summary, display]);
  return <ListColumnsContext value={value}>{children}</ListColumnsContext>;
}

export function useListSummary() {
  return useContext(ListColumnsContext)?.summary ?? false;
}

/** The compact host exposes fields directly inside its display sheet. */
export function useListDisplay() {
  return useContext(ListColumnsContext)?.display ?? false;
}

export function ListColumnsSlot({ children, display = false }: { children?: ReactNode; display?: boolean }) {
  const host = useContext(ListColumnsContext);
  const setDisplay = host?.setDisplay;
  useLayoutEffect(() => {
    setDisplay?.(display);
    return () => setDisplay?.(false);
  }, [display, setDisplay]);
  return (
    <div
      ref={host?.setTarget}
      className={cn("list-columns-slot flex gap-2 empty:hidden", display ? "min-w-0 flex-col items-stretch gap-4" : "items-center")}
      data-list-columns-slot
    >{children}</div>
  );
}

/** Portals preserve the table's state and clean up with the displayed result. */
export function ListColumnsMenu({ children, summary }: { children: ReactNode; summary?: boolean }) {
  const host = useContext(ListColumnsContext);
  const setSummary = host?.setSummary;
  useLayoutEffect(() => {
    // Keep the last measured layout while rows are absent or awaiting measurement.
    if (summary !== undefined) setSummary?.(summary);
  }, [setSummary, summary]);
  if (!host)
    return (
      <div className="business-table-toolbar flex items-center justify-end gap-2">
        {children}
      </div>
    );
  return host.target ? createPortal(children, host.target) : null;
}
