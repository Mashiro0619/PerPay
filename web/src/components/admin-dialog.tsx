import { createContext, useContext, useRef, useState, type ComponentProps } from "react";
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
export function DialogContent({ className, kind = "form", ...props }: ComponentProps<typeof DialogUI.DialogContent> & { kind?: "form" | "technical" }) {
  const keepMounted = useContext(RetainDialogContext);
  const switching = useWorkspaceSwitching();
  return <DialogUI.DialogContent {...props} portalProps={{ ...props.portalProps, keepMounted: keepMounted || props.portalProps?.keepMounted, hidden: switching || props.portalProps?.hidden, inert: switching || props.portalProps?.inert }} data-admin-dialog={kind} className={cn(className, content, kind === "technical" ? "sm:max-w-3xl" : "sm:max-w-xl")} />;
}
export function AlertDialogContent({ className, initialFocus, ...props }: ComponentProps<typeof AlertUI.AlertDialogContent>) {
  const element = useRef<HTMLDivElement>(null);
  const keepMounted = useContext(RetainDialogContext);
  const switching = useWorkspaceSwitching();
  return <AlertUI.AlertDialogContent {...props} portalProps={{ ...props.portalProps, keepMounted: keepMounted || props.portalProps?.keepMounted, hidden: switching || props.portalProps?.hidden, inert: switching || props.portalProps?.inert }} ref={element} initialFocus={initialFocus ?? (() => element.current?.querySelector<HTMLButtonElement>('[data-slot="alert-dialog-cancel"]') ?? element.current)} data-admin-dialog="confirm" className={cn(className, content, "data-[size=default]:max-w-[calc(100%-2rem)] data-[size=sm]:max-w-[calc(100%-2rem)] data-[size=default]:sm:max-w-lg")} />;
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
