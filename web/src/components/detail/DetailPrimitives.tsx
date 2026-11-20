import { useQuery } from '@/lib/workspace-query';
import { useWorkspaceApi } from "@/workspace";
import { useRef, useState, type ReactNode } from "react";
import { useIsFetching } from '@tanstack/react-query';
import { ArrowLeft, Code, X } from "lucide-react";
import { result, type AdminOrderDetail, type ReconciliationOrder } from "@/api/client";
import { Link } from "@/navigation";
import { CopyValue } from "@/components/copy-value";
import { FieldList } from "@/components/record/FieldList";
import { useOverlayContext } from "@/lib/overlay-context";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
  DialogBody,
} from "@/components/admin-dialog";
const detailQueryScopes = new Set([
  "order",
  "order-notifications",
  "match",
  "candidate",
  "exception",
  "ledger",
  "ledger-candidates",
  "notification",
  "notification-attempts",
  "conflict",
  "audit-event",
]);
export function useDetailFetching() {
  return useIsFetching({
    predicate: (query) => detailQueryScopes.has(String(query.queryKey[0])),
  });
}
export function DetailPage({ children }: { children: ReactNode }) {
  return <div className="flex min-w-0 flex-col gap-4" data-detail-page data-detail-layout="readable">{children}</div>;
}
export function DetailNavigation({ back, identifier, identifierLabel = "记录编号", global = false, children }: {
  back: { to: string; label: string; state?: unknown };
  identifier?: string | undefined;
  identifierLabel?: string;
  global?: boolean;
  children?: ReactNode;
}) {
  const overlay = useOverlayContext();
  if (overlay) return children ? <div className="contents" data-detail-navigation>{children}</div> : null;
  return <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2" data-detail-navigation>
    <Link global={global} to={back.to} state={back.state} className={buttonVariants({ variant: "ghost", size: "sm" })}>
      <ArrowLeft data-icon="inline-start" />{back.label}
    </Link>
    {identifier && <div className="min-w-0 text-xs text-muted-foreground" data-detail-identifier>
      <CopyValue value={identifier} label={"复制" + identifierLabel} />
    </div>}
    {children && <div className="ml-auto flex items-center gap-2 empty:hidden">{children}</div>}
  </div>;
}
export function TechnicalDetails({ data, identifiers = [], title = "技术信息", children }: {
  data: unknown;
  identifiers?: ReadonlyArray<readonly [string, string | null]>;
  title?: string;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return <div className="flex min-w-0" data-technical-information>
    <Button ref={trigger} variant="ghost" size="sm" className="h-auto min-h-8 max-w-full whitespace-normal" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
      {title}
      <Code aria-hidden="true" data-icon="inline-end" />
    </Button>
    <TechnicalDetailsDialog open={open} onOpenChange={setOpen} finalFocus={() => trigger.current} data={data} identifiers={identifiers} title={title}>{children}</TechnicalDetailsDialog>
  </div>;
}
export function TechnicalDetailsDialog({
  open,
  onOpenChange,
  finalFocus,
  data,
  identifiers = [],
  title: titleText = "技术详情",
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  finalFocus: () => HTMLElement | null;
  data: unknown;
  identifiers?: ReadonlyArray<readonly [string, string | null]>;
  title?: string;
  children?: ReactNode;
}) {
  const title = useRef<HTMLHeadingElement>(null);
  return (
    <Dialog presentation="dialog" open={open} onOpenChange={onOpenChange}>
      <DialogContent
        kind="technical"
        backdropProps={{ forceRender: true }}
        data-technical-dialog
        showCloseButton={false}
        initialFocus={title}
        finalFocus={finalFocus}
      >
        <DialogHeader className="flex-row items-center justify-between gap-2 pr-0">
          <DialogTitle ref={title} tabIndex={-1}>
            {titleText}
          </DialogTitle>
          <DialogClose render={<Button variant="ghost" size="icon" aria-label={"关闭" + titleText} />}><X /></DialogClose>
        </DialogHeader>
        <DialogBody>
          {children}
          {identifiers.length > 0 && (
            <FieldList
              items={identifiers
                .filter(
                  (entry): entry is readonly [string, string] => !!entry[1],
                )
                .map(([name, value]) => ({
                  label: name,
                  kind: "id" as const,
                  value,
                  copy: value,
                  copyLabel: "复制" + name,
                }))}
            />
          )}
          <pre
            tabIndex={0}
            aria-label={titleText}
            role="group"
            className="shrink-0 rounded-md bg-muted p-4 text-xs whitespace-pre-wrap break-all"
          >
            {JSON.stringify(data, null, 2)}
          </pre>
        </DialogBody>
        <DialogFooter className="shrink-0">
          <DialogClose render={<Button variant="outline" />}>关闭</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
export function useRelatedOrder(
  orderId: string | null,
  known?: ReconciliationOrder | AdminOrderDetail,
) {
  const api = useWorkspaceApi();
  const query = useQuery({
    queryKey: ["order", orderId],
    enabled: !!orderId && !known,
    queryFn: ({ signal }) =>
      result(
        api.getAdministratorOrder({ path: { orderId: orderId! }, signal }),
      ),
  });
  return { order: known ?? query.data?.data, query };
}
