import { createContext, useContext, useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode, type RefObject } from "react";
import { cn } from "@/lib/utils";
import { useWorkspaceSwitching } from "@/lib/workspace-navigation-state";
import * as DialogUI from "@/components/ui/dialog";
import * as AlertUI from "@/components/ui/alert-dialog";
export { DialogTrigger, DialogClose, DialogTitle, DialogDescription } from "@/components/ui/dialog";
export { AlertDialogTrigger, AlertDialogCancel, AlertDialogAction, AlertDialogTitle, AlertDialogDescription } from "@/components/ui/alert-dialog";
const RetainDialogContext = createContext(false);
function useDialogSuspension(props: Pick<ComponentProps<typeof DialogUI.Dialog>, "open" | "defaultOpen" | "onOpenChange" | "onOpenChangeComplete">) {
  const switching = useWorkspaceSwitching();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(props.defaultOpen ?? false);
  const requestedOpen = props.open ?? uncontrolledOpen;
  return {
    requestedOpen,
    root: {
      open: requestedOpen && !switching,
      onOpenChange: ((open, event) => {
        if (switching) { event.cancel(); return; }
        props.onOpenChange?.(open, event);
        if (!event.isCanceled) setUncontrolledOpen(open);
      }) satisfies NonNullable<ComponentProps<typeof DialogUI.Dialog>["onOpenChange"]>,
      onOpenChangeComplete: (open: boolean) => { if (!switching) props.onOpenChangeComplete?.(open); },
    },
  };
}
// Release modal effects while the destination is being prepared. Keep the
// original open state and content so cancelling restores the same draft.
export function Dialog(props: ComponentProps<typeof DialogUI.Dialog>) {
  const state = useDialogSuspension(props);
  return <RetainDialogContext value={state.requestedOpen}><DialogUI.Dialog {...props} {...state.root} /></RetainDialogContext>;
}
export function AlertDialog(props: ComponentProps<typeof AlertUI.AlertDialog>) {
  const state = useDialogSuspension(props);
  return <RetainDialogContext value={state.requestedOpen}><AlertUI.AlertDialog {...props} {...state.root} /></RetainDialogContext>;
}
const content = "flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-[calc(100%-2rem)] flex-col overflow-hidden";
function DialogScroll({ children, scrollRef }: { children: ReactNode; scrollRef?: RefObject<HTMLDivElement | null> }) {
  const localRef = useRef<HTMLDivElement>(null);
  const element = scrollRef ?? localRef;
  const [scrollable, setScrollable] = useState(false);
  useLayoutEffect(() => {
    const scroll = element.current!;
    const measure = () => {
      // Discount the close-control space so a small resize cannot toggle the
      // reservation back and forth. Content that fits keeps its usual layout.
      const popup = scroll.parentElement;
      const popupStyle = popup && getComputedStyle(popup);
      const reserved = scroll.dataset.scrollable === "true" && popup?.querySelector(":scope > [data-slot=dialog-close]") && popupStyle
        ? Math.max(0, (Number.parseFloat(popupStyle.paddingTop) || 0) - (Number.parseFloat(popupStyle.paddingBottom) || 0)) : 0;
      const next = scroll.scrollHeight > scroll.clientHeight + reserved + 1;
      setScrollable(previous => previous === next ? previous : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroll);
    for (const child of scroll.children) observer.observe(child);
    return () => observer.disconnect();
  }, [children]);
  return <div ref={element} tabIndex={scrollable ? 0 : -1} data-admin-dialog-scroll data-scrollable={scrollable}>{children}</div>;
}
export function DialogContent({ className, kind = "form", children, initialFocus, ...props }: ComponentProps<typeof DialogUI.DialogContent> & { kind?: "form" | "technical" }) {
  const keepMounted = useContext(RetainDialogContext);
  const switching = useWorkspaceSwitching();
  const scrollRef = useRef<HTMLDivElement>(null);
  return <DialogUI.DialogContent {...props} initialFocus={openType => {
    const scroll = scrollRef.current;
    if (initialFocus === undefined && scroll && scroll.scrollHeight > scroll.clientHeight + 1) return scroll;
    if (typeof initialFocus === "function") return initialFocus(openType);
    if (initialFocus && typeof initialFocus === "object") return initialFocus.current;
    return initialFocus ?? true;
  }} portalProps={{ ...props.portalProps, keepMounted: keepMounted || props.portalProps?.keepMounted, hidden: switching || props.portalProps?.hidden, inert: switching || props.portalProps?.inert }} data-admin-dialog={kind} className={cn(className, content, kind === "technical" ? "sm:max-w-3xl" : "sm:max-w-xl")}>
    <DialogScroll scrollRef={scrollRef}>{children}</DialogScroll>
  </DialogUI.DialogContent>;
}
export function AlertDialogContent({ className, initialFocus, children, ...props }: ComponentProps<typeof AlertUI.AlertDialogContent>) {
  const element = useRef<HTMLDivElement>(null);
  const keepMounted = useContext(RetainDialogContext);
  const switching = useWorkspaceSwitching();
  return <AlertUI.AlertDialogContent {...props} portalProps={{ ...props.portalProps, keepMounted: keepMounted || props.portalProps?.keepMounted, hidden: switching || props.portalProps?.hidden, inert: switching || props.portalProps?.inert }} ref={element} initialFocus={openType => {
    const scroll = element.current?.querySelector<HTMLElement>("[data-admin-dialog-scroll]");
    // Start long confirmations at their explanation instead of scrolling to
    // the cancellation button before the user has read the operation.
    if (initialFocus !== false && scroll && scroll.scrollHeight > scroll.clientHeight + 1) return scroll;
    if (initialFocus && typeof initialFocus === "object") return initialFocus.current;
    return typeof initialFocus === "function" ? initialFocus(openType) : initialFocus ?? element.current?.querySelector<HTMLButtonElement>('[data-slot="alert-dialog-cancel"]') ?? element.current;
  }} data-admin-dialog="confirm" className={cn(className, content, "data-[size=default]:max-w-[calc(100%-2rem)] data-[size=sm]:max-w-[calc(100%-2rem)] data-[size=default]:sm:max-w-lg")}>
    <DialogScroll>{children}</DialogScroll>
  </AlertUI.AlertDialogContent>;
}
export function DialogHeader({ className, ...props }: ComponentProps<typeof DialogUI.DialogHeader>) {
  return <DialogUI.DialogHeader {...props} className={cn(className, "shrink-0 pr-8 text-left")} />;
}
export function AlertDialogHeader({ className, ...props }: ComponentProps<typeof AlertUI.AlertDialogHeader>) {
  return <AlertUI.AlertDialogHeader {...props} className={cn(className, "flex shrink-0 flex-col items-stretch gap-2 text-left")} />;
}
const footer = "shrink-0 flex-col-reverse flex-nowrap items-stretch sm:flex-row sm:justify-end";
export function DialogFooter({ className, ...props }: ComponentProps<typeof DialogUI.DialogFooter>) {
  return <DialogUI.DialogFooter {...props} className={cn(className, footer)} />;
}
export function AlertDialogFooter({ className, safeActionFirst = false, ...props }: ComponentProps<typeof AlertUI.AlertDialogFooter> & { safeActionFirst?: boolean }) {
  return <AlertUI.AlertDialogFooter {...props} className={cn(className, footer, safeActionFirst && "flex-col sm:flex-row")} />;
}
export function DialogBody({ className, ...props }: ComponentProps<"div">) {
  return <div {...props} data-admin-dialog-body className={cn("-mx-4 flex min-h-0 flex-col gap-4 overflow-y-auto px-4 pb-1", className)} />;
}
