import { createContext, useContext, useId, useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode, type RefObject } from "react";
import { cn } from "@/lib/utils";
import { useWorkspaceSwitching } from "@/lib/workspace-navigation-state";
import { LocalRequestNotices } from "@/lib/request-notices";
import { OverlayNestedModalContext, OverlayStepsContext, type OverlaySize } from "@/lib/overlay-context";
import * as DialogUI from "@/components/ui/dialog";
import * as AlertUI from "@/components/ui/alert-dialog";
export { DialogTrigger, DialogClose, DialogTitle, DialogDescription } from "@/components/ui/dialog";
export { AlertDialogTrigger, AlertDialogCancel, AlertDialogAction, AlertDialogTitle, AlertDialogDescription } from "@/components/ui/alert-dialog";
const RetainDialogContext = createContext(false);
const StepDialogContext = createContext<{ id: string; open: boolean } | null>(null);
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
export function Dialog({ presentation = "auto", ...props }: ComponentProps<typeof DialogUI.Dialog> & { presentation?: "auto" | "dialog" }) {
  const state = useDialogSuspension(props);
  const steps = useContext(OverlayStepsContext);
  const registerNested = useContext(OverlayNestedModalContext);
  const id = useId();
  const step = steps && presentation === "auto" ? { id, open: state.requestedOpen } : null;
  const nested = presentation === "dialog" && !!registerNested;
  useLayoutEffect(() => {
    if (!nested) return;
    registerNested?.(id, state.root.open);
    return () => registerNested?.(id, false);
  }, [id, nested, registerNested, state.root.open]);
  return <StepDialogContext value={step}><RetainDialogContext value={state.requestedOpen}>
    <DialogUI.Dialog {...props} {...state.root} {...(step ? { modal: false } : {})} />
  </RetainDialogContext></StepDialogContext>;
}
export function AlertDialog(props: ComponentProps<typeof AlertUI.AlertDialog>) {
  const state = useDialogSuspension(props);
  const id = useId();
  const register = useContext(OverlayNestedModalContext);
  useLayoutEffect(() => {
    register?.(id, state.root.open);
    return () => register?.(id, false);
  }, [id, register, state.root.open]);
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
function stepScrollRegion(layout: HTMLElement | null) {
  return layout?.querySelector<HTMLElement>(
    ':scope > [data-admin-dialog-body], :scope > [data-slot="field-group"], :scope > .overflow-auto, ' +
    ':scope > form > [data-admin-dialog-body], :scope > form > [data-slot="field-group"], :scope > form > .overflow-auto',
  ) ?? null;
}
/** Keep the existing form/body/footer nodes while restoring a keyboard reading entry. */
function StepDialogLayout({ children, layoutRef }: { children: ReactNode; layoutRef: RefObject<HTMLDivElement | null> }) {
  useLayoutEffect(() => {
    const layout = layoutRef.current;
    const scroll = stepScrollRegion(layout);
    if (!layout || !scroll) return;
    const priorTabIndex = scroll.getAttribute("tabindex");
    scroll.setAttribute("data-overlay-step-scroll", "");
    const measure = () => {
      const scrollable = scroll.scrollHeight > scroll.clientHeight + 1;
      scroll.dataset.scrollable = String(scrollable);
      scroll.tabIndex = scrollable ? 0 : -1;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(layout);
    observer.observe(scroll);
    for (const child of scroll.children) observer.observe(child);
    return () => {
      observer.disconnect();
      scroll.removeAttribute("data-overlay-step-scroll");
      scroll.removeAttribute("data-scrollable");
      if (priorTabIndex === null) scroll.removeAttribute("tabindex");
      else scroll.setAttribute("tabindex", priorTabIndex);
    };
  }, [children, layoutRef]);
  return <div ref={layoutRef} data-overlay-step-layout>{children}</div>;
}
export function DialogContent({ className, kind = "form", size, children, initialFocus, ...props }: ComponentProps<typeof DialogUI.DialogContent> & { kind?: "form" | "technical" | "detail"; size?: OverlaySize }) {
  const keepMounted = useContext(RetainDialogContext);
  const switching = useWorkspaceSwitching();
  const scrollRef = useRef<HTMLDivElement>(null);
  const step = useContext(StepDialogContext);
  const steps = useContext(OverlayStepsContext);
  const stepReturnFocus = useRef<HTMLElement | null>(null);
  const wasStepOpen = useRef(false);
  const register = steps?.register;
  const stepSize = size ?? (kind === "technical" ? "lg" : "md");
  useLayoutEffect(() => {
    if (step?.open && !wasStepOpen.current) {
      stepReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    wasStepOpen.current = !!step?.open;
  }, [step?.open]);
  useLayoutEffect(() => {
    if (!step || !register) return;
    register(step.id, step.open, stepSize);
    return () => register(step.id, false);
  }, [step?.id, step?.open, stepSize, register]);
  if (step && !steps?.portal) return null;
  const stepHidden = !!step && steps?.activeId !== step.id;
  // Reset Tailwind's translation variables too: CSS minification can merge
  // `translate: none` into `transform: none`, leaving the separate translate active.
  const detailClass = "max-md:inset-0 max-md:h-[100dvh] max-md:max-h-none max-md:w-full max-md:max-w-none max-md:translate-x-0 max-md:translate-y-0 max-md:rounded-none md:max-h-[calc(100dvh-3rem)] md:w-[calc(100%-3rem)] " +
    (size === "xl" ? "md:max-w-6xl" : size === "lg" ? "md:max-w-4xl" : "md:max-w-[40rem]");
  return <DialogUI.DialogContent {...props} aria-modal={step ? true : props["aria-modal"]} finalFocus={step && props.finalFocus !== false ? closeType => {
    const readTarget = () => {
      const value = typeof props.finalFocus === "function" ? props.finalFocus(closeType) : props.finalFocus;
      if (value === undefined || value === true) return stepReturnFocus.current;
      return value && typeof value === "object" && "current" in value ? value.current : value;
    };
    const target = readTarget();
    if (switching || target === false) return false;
    steps!.restoreFocus(() => {
      const latest = readTarget();
      return latest instanceof HTMLElement ? latest : null;
    });
    return false;
  } : props.finalFocus} initialFocus={openType => {
    const scroll = step ? stepScrollRegion(scrollRef.current) : scrollRef.current;
    if (initialFocus === undefined && scroll && scroll.scrollHeight > scroll.clientHeight + 1) return scroll;
    if (typeof initialFocus === "function") return initialFocus(openType);
    if (initialFocus && typeof initialFocus === "object") return initialFocus.current;
    return initialFocus ?? true;
  }} presentation={step ? "step" : "dialog"} portalProps={{ ...props.portalProps, ...(step ? { container: steps!.portal } : {}), keepMounted: keepMounted || props.portalProps?.keepMounted,
    hidden: switching || stepHidden || props.portalProps?.hidden, inert: switching || stepHidden || props.portalProps?.inert }} data-admin-dialog={kind} data-overlay-step={step ? step.id : undefined}
    className={cn(className, step ? "flex min-h-0 max-h-full w-full flex-1 flex-col overflow-hidden" : content,
      !step && (kind === "detail" ? detailClass : "max-md:translate-x-0 max-md:translate-y-0 " + (kind === "technical" ? "sm:max-w-3xl" : "sm:max-w-xl")))}>
    <LocalRequestNotices>{kind === "detail" || (kind === "technical" && !step) ? children : step
      ? <StepDialogLayout layoutRef={scrollRef}>{children}</StepDialogLayout>
      : <DialogScroll scrollRef={scrollRef}>{children}</DialogScroll>}</LocalRequestNotices>
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
    <LocalRequestNotices><DialogScroll>{children}</DialogScroll></LocalRequestNotices>
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
