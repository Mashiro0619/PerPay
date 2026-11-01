import { useWorkspace } from "@/workspace";
import { actualPageAddress } from "@/lib/navigation-selection";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { useLocation, useMatch } from "react-router";
import { ScanLine } from "lucide-react";
import { TestPaymentDialog } from "@/pages/TestPayment";
import {
  TestPaymentRequestContext,
  useTestPaymentRequest,
} from "@/lib/test-payment-request";
import { Button } from "@/components/ui/button";
import { usePageActionMenu } from "@/components/page-header-actions";
import { useOptionalOverlayNavigation } from "@/lib/overlay-context";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";

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
  const request = useTestPaymentRequest((overlay ? overlay.target?.pathname === "/test-payment" : open) || standalone);
  const trigger = useRef<HTMLButtonElement | null>(null);
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
          <TestPaymentDialog
            open={open}
            onOpenChange={setOpen}
            finalFocus={() =>
              trigger.current?.isConnected
                ? trigger.current
                : document.getElementById("main-content")
            }
          />
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
