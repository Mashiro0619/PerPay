import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

type ListColumnsHost = {
  target: HTMLDivElement | null;
  setTarget: (target: HTMLDivElement | null) => void;
};

const ListColumnsContext = createContext<ListColumnsHost | null>(null);

/** One host per business list; column state remains with its BusinessTable. */
export function ListColumnsProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  const value = useMemo(() => ({ target, setTarget }), [target]);
  return <ListColumnsContext value={value}>{children}</ListColumnsContext>;
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
export function ListColumnsMenu({ children }: { children: ReactNode }) {
  const host = useContext(ListColumnsContext);
  if (!host)
    return (
      <div className="business-table-toolbar flex items-center justify-end gap-2">
        {children}
      </div>
    );
  return host.target ? createPortal(children, host.target) : null;
}
