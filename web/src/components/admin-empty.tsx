import type { ComponentProps, ReactNode } from "react";
import { Empty as BaseEmpty } from "@/components/ui/empty";
import { cn } from "@/lib/utils";
export { EmptyHeader, EmptyTitle, EmptyDescription, EmptyContent, EmptyMedia } from "@/components/ui/empty";
export function Empty({ kind = "page", className, ...props }: ComponentProps<typeof BaseEmpty> & { kind?: "page" | "filtered" }) {
  return <BaseEmpty {...props} data-empty-kind={kind} className={cn(className, kind === "filtered" ? "gap-3 p-4 md:p-6" : "gap-4 p-6 md:p-8")} />;
}
export function InlineEmpty({ children }: { children: ReactNode }) {
  return <p data-empty-kind="inline" className="text-sm text-muted-foreground">{children}</p>;
}
