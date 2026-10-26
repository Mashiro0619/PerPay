import {
  createContext,
  cloneElement,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type Dispatch,
  type ReactElement,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from "react";
import { createPortal } from "react-dom";
import { useLocation } from "react-router";
import { useIsMobile } from "@/hooks/use-mobile";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { ThemeControl } from "@/theme";
import { useWorkspaceSwitching } from "@/lib/workspace-navigation-state";

type ActionsHost = {
  target: HTMLDivElement | null;
  setTarget: (target: HTMLDivElement | null) => void;
  mobile: boolean;
  triggerRef: RefObject<HTMLButtonElement | null>;
  hasPageActions: boolean;
  setPageActions: Dispatch<SetStateAction<number>>;
};
const ActionsContext = createContext<ActionsHost | null>(null);
export const PageActionMenuContext = createContext<RefObject<HTMLButtonElement | null> | null>(null);
export const usePageActionMenu = () => useContext(PageActionMenuContext);
export const usePageHeaderMenu = () => useContext(ActionsContext);

export function PageHeaderActionsProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  const mobile = useIsMobile();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [pageActions, setPageActions] = useState(0);
  const { pathname } = useLocation();
  useEffect(() => setOpen(false), [pathname, mobile]);
  const value = useMemo(() => ({ target, setTarget, mobile, triggerRef, hasPageActions: pageActions > 0, setPageActions }), [target, mobile, pageActions]);
  // The header trigger and each route's popup share the same menu root.
  return <ActionsContext value={value}>
    <DropdownMenu open={open} onOpenChange={setOpen}>{children}</DropdownMenu>
  </ActionsContext>;
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

/** Actions retain their page's query and draft contexts in both presentations.
 * Unmounting the route removes its actions without stale callback registration.
 */
export function PageHeaderActions({ children }: { children: ReactNode }) {
  const host = useContext(ActionsContext);
  const register = host?.setPageActions;
  useEffect(() => {
    if (!register) return;
    register(count => count + 1);
    return () => register(count => count - 1);
  }, [register]);
  // Standalone page/test renders have no application header.
  if (!host)
    return (
      <div className="flex items-center justify-end gap-2">{children}</div>
    );
  // Render mobile items beneath their actual Popup so Base UI can register
  // them for arrow-key navigation while preserving the route's contexts.
  if (host.mobile) return <PageHeaderMenuContent>{children}</PageHeaderMenuContent>;
  return host.target ? createPortal(children, host.target) : null;
}

export function PageHeaderMenuContent({ children, busy = false }: { children?: ReactNode; busy?: boolean }) {
  const host = useContext(ActionsContext);
  const switching = useWorkspaceSwitching();
  return <DropdownMenuContent align="end" aria-label="页面操作" data-header-mobile-actions className="w-56 max-w-[calc(100vw-2rem)]" inert={busy || switching}>
    <PageActionMenuContext value={host?.triggerRef ?? null}>
      {children && <><DropdownMenuGroup>{children}</DropdownMenuGroup><DropdownMenuSeparator /></>}
      <DropdownMenuGroup><ThemeControl submenu /></DropdownMenuGroup>
    </PageActionMenuContext>
  </DropdownMenuContent>;
}

export function PageHeaderActionLink({ children }: { children: ReactElement<ComponentProps<"a">> }) {
  const menu = usePageActionMenu();
  return menu
    ? <DropdownMenuItem render={cloneElement(children, { className: undefined })} nativeButton={false}>{children.props.children}</DropdownMenuItem>
    : children;
}
