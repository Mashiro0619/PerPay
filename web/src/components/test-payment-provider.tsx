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

const TestPaymentContext = createContext<
  ((trigger: HTMLButtonElement) => void) | null
>(null);

export function TestPaymentProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [started, setStarted] = useState(false);
  const standalone = useMatch("/test-payment") !== null;
  const request = useTestPaymentRequest(open || standalone);
  const trigger = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    setOpen(false);
  }, [location.pathname, location.search]);
  return (
    <TestPaymentContext
      value={(element) => {
        trigger.current = element;
        setStarted(true);
        setOpen(true);
      }}
    >
      <TestPaymentRequestContext value={request}>
        {children}
        {started && !standalone && (
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
  if (!show) throw new Error("TestPaymentButton requires TestPaymentProvider");
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
