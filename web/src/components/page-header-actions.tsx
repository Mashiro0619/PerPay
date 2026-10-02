import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

type ActionsHost = {
  target: HTMLDivElement | null;
  setTarget: (target: HTMLDivElement | null) => void;
};
const ActionsContext = createContext<ActionsHost | null>(null);

export function PageHeaderActionsProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  const value = useMemo(() => ({ target, setTarget }), [target]);
  return <ActionsContext value={value}>{children}</ActionsContext>;
}

export function PageHeaderActionsSlot() {
  const host = useContext(ActionsContext);
  return (
    <div
      ref={host?.setTarget}
      className="flex items-center gap-1 empty:hidden sm:gap-2"
      data-page-header-actions
    />
  );
}

/** Move only the DOM: actions retain their page's query and draft contexts.
 * Unmounting the route removes its actions without stale callback registration.
 */
export function PageHeaderActions({ children }: { children: ReactNode }) {
  const host = useContext(ActionsContext);
  // Standalone page/test renders have no application header.
  if (!host)
    return (
      <div className="flex items-center justify-end gap-2">{children}</div>
    );
  return host.target ? createPortal(children, host.target) : null;
}
