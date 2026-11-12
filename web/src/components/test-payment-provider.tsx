import { useWorkspace } from "@/workspace";
import { actualPageAddress } from "@/lib/navigation-selection";
import {
  createContext,
  lazy,
  Suspense,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { useLocation, useMatch } from "react-router";
import { ScanLine } from "lucide-react";
import {
  TestPaymentRequestContext,
  useTestPaymentRequest,
} from "@/lib/test-payment-request";
import { Button } from "@/components/ui/button";
import { usePageActionMenu } from "@/components/page-header-actions";
import { useOptionalOverlayNavigation } from "@/lib/overlay-context";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/admin-dialog";
import { Spinner } from "@/components/ui/spinner";

const TestPaymentDialog = lazy(() =>
  import("@/pages/TestPayment").then((module) => ({
    default: module.TestPaymentDialog,
  })),
);

function TestPaymentLoadingDialog({
  open,
  onOpenChange,
  finalFocus,
}: ComponentProps<typeof TestPaymentDialog>) {
  const title = useRef<HTMLHeadingElement>(null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent initialFocus={title} finalFocus={open ? false : finalFocus}>
        <DialogHeader>
          <DialogTitle ref={title} tabIndex={-1}>测试收款</DialogTitle>
        </DialogHeader>
        <div role="status" className="flex items-center gap-2">
          <Spinner aria-hidden="true" />正在加载测试收款…
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const TestPaymentContext = createContext<
  ((trigger: HTMLButtonElement) => void) | null
>(null);

export function TestPaymentProvider({ children }: { children: ReactNode }) {
  const overlay = useOptionalOverlayNavigation();
  const location = useLocation();
  const pageAddress = actualPageAddress(location);
  const { clientId } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [started, setStarted] = useState(false);
  const standalone = useMatch("/test-payment") !== null;
  const overlayOpen = overlay?.target?.pathname === "/test-payment";
  const request = useTestPaymentRequest((overlay ? overlayOpen : open) || standalone);
  const bindSite = useRef(request.bindSite);
  useLayoutEffect(() => { bindSite.current = request.bindSite; });
  useLayoutEffect(() => {
    // URLs can open the form without its button. Bind only on entry/scope change:
    // completing a recovery from another site must retain that original result.
    if (overlayOpen) bindSite.current(clientId);
  }, [overlayOpen, clientId]);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const finalFocus = () => trigger.current?.isConnected
    ? trigger.current : document.getElementById("main-content");
  useEffect(() => {
    setOpen(false);
  }, [pageAddress]);
  return (
    <TestPaymentContext
      value={(element) => {
        trigger.current = element;
        request.bindSite(clientId);
        setStarted(true);
        if (overlay) overlay.open("/test-payment", { trigger: element });
        else setOpen(true);
      }}
    >
      <TestPaymentRequestContext value={request}>
        {children}
        {started && !standalone && !overlay && (
          <Suspense fallback={
            <TestPaymentLoadingDialog open={open} onOpenChange={setOpen} finalFocus={finalFocus} />
          }>
            <TestPaymentDialog open={open} onOpenChange={setOpen} finalFocus={finalFocus} />
          </Suspense>
        )}
      </TestPaymentRequestContext>
    </TestPaymentContext>
  );
}

export function TestPaymentButton({
  children = "测试收款",
  ...props
}: Pick<
  ComponentProps<typeof Button>,
  "children" | "className" | "size" | "variant" | "title"
>) {
  const show = useContext(TestPaymentContext);
  const menu = usePageActionMenu();
  if (!show) throw new Error("TestPaymentButton requires TestPaymentProvider");
  if (menu) return <DropdownMenuItem aria-haspopup="dialog" onClick={() => {
    if (menu.current) show(menu.current);
  }}><ScanLine />{children}</DropdownMenuItem>;
  return (
    <Button
      type="button"
      variant="outline"
      {...props}
      aria-haspopup="dialog"
      onClick={(event) => show(event.currentTarget)}
    >
      <ScanLine data-icon="inline-start" />
      {children}
    </Button>
  );
}
