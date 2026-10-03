import { useRef, type ComponentProps } from "react";
import { cn } from "@/lib/utils";
import * as DialogUI from "@/components/ui/dialog";
import * as AlertUI from "@/components/ui/alert-dialog";
export { Dialog, DialogTrigger, DialogClose, DialogTitle, DialogDescription } from "@/components/ui/dialog";
export { AlertDialog, AlertDialogTrigger, AlertDialogCancel, AlertDialogAction, AlertDialogTitle, AlertDialogDescription } from "@/components/ui/alert-dialog";
const content = "flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-[calc(100%-2rem)] flex-col overflow-hidden";
export function DialogContent({ className, kind = "form", ...props }: ComponentProps<typeof DialogUI.DialogContent> & { kind?: "form" | "technical" }) {
  return <DialogUI.DialogContent {...props} data-admin-dialog={kind} className={cn(className, content, kind === "technical" ? "sm:max-w-3xl" : "sm:max-w-xl")} />;
}
export function AlertDialogContent({ className, initialFocus, ...props }: ComponentProps<typeof AlertUI.AlertDialogContent>) {
  const element = useRef<HTMLDivElement>(null);
  return <AlertUI.AlertDialogContent {...props} ref={element} initialFocus={initialFocus ?? (() => element.current?.querySelector<HTMLButtonElement>('[data-slot="alert-dialog-cancel"]') ?? element.current)} data-admin-dialog="confirm" className={cn(className, content, "data-[size=default]:max-w-[calc(100%-2rem)] data-[size=sm]:max-w-[calc(100%-2rem)] data-[size=default]:sm:max-w-lg")} />;
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
