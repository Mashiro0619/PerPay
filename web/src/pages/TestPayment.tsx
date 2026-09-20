import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowLeft, AlertCircle } from "lucide-react";
import { Link } from "@/navigation";
import { api, refreshOperationalData, result } from "@/api/client";
import { money, parseAmount, safeCheckoutUrl } from "@/lib/format";
import { useOperationKey } from "@/lib/idempotency";
import { StatusBadge } from "@/components/business-status";
import { ErrorNotice, QueryView } from "@/components/request-state";
import { RecordTools } from "@/components/detail/RecordTools";
import { DetailFields } from "@/components/detail/DetailPrimitives";
import { Button, buttonVariants } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  InputGroup,
  InputGroupInput,
  InputGroupAddon,
  InputGroupText,
} from "@/components/ui/input-group";
import {
  Field,
  FieldLabel,
  FieldDescription,
  FieldError,
  FieldGroup,
} from "@/components/ui/field";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardAction,
  CardFooter,
} from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

type TestPaymentDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  finalFocus: () => HTMLElement | null;
};

export default function TestPayment() {
  const [generation, setGeneration] = useState(0);
  return (
    <div className="flex w-full max-w-xl flex-col gap-4">
      <Link
        to="/"
        className={buttonVariants({
          variant: "ghost",
          size: "sm",
          className: "w-fit",
        })}
      >
        <ArrowLeft data-icon="inline-start" />
        收款概览
      </Link>
      <TestPaymentForm
        key={generation}
        onNew={() => setGeneration((value) => value + 1)}
      />
    </div>
  );
}

export function TestPaymentDialog(props: TestPaymentDialogProps) {
  const [generation, setGeneration] = useState(0);
  return (
    <TestPaymentForm
      key={generation}
      dialog={props}
      onNew={() => setGeneration((value) => value + 1)}
    />
  );
}

function TestPaymentForm({
  onNew,
  dialog,
}: {
  onNew: () => void;
  dialog?: TestPaymentDialogProps;
}) {
  const [amount, setAmount] = useState("0.01");
  const amountField = useRef<HTMLInputElement>(null);
  const dialogTitle = useRef<HTMLHeadingElement>(null);
  const resultTitle = useRef<HTMLHeadingElement>(null);
  const submitting = useRef(false);
  const [validation, setValidation] = useState<Error | null>(null);
  const formId = useId();
  const errorId = useId();
  const operationKey = useOperationKey();
  const status = useQuery({
    queryKey: ["status"],
    queryFn: ({ signal }) =>
      result(api.getAdministratorSystemStatus({ signal })),
    enabled: !dialog || dialog.open,
    staleTime: 0,
  });
  const create = useMutation({
    mutationFn: (cents: number) =>
      result(
        api.createAdministratorTestPayment({
          body: { amount_cents: cents, test_payment_id: operationKey(cents) },
        }),
      ),
    onSuccess: () => {
      void refreshOperationalData();
    },
    onSettled: () => {
      submitting.current = false;
    },
  });
  const canCreate =
    !!status.data &&
    !status.isError &&
    !status.isFetching &&
    status.data.data.status !== "not_ready";
  useEffect(() => {
    if (create.data && (!dialog || dialog.open)) resultTitle.current?.focus();
  }, [create.data, dialog?.open]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || create.isPending || !canCreate) return;
    try {
      const cents = parseAmount(amount);
      setValidation(null);
      submitting.current = true;
      create.mutate(cents);
    } catch (error) {
      setValidation(error as Error);
      amountField.current?.focus();
    }
  }

  const order = create.data?.data;
  const checkoutUrl = order
    ? safeCheckoutUrl(order.checkout.checkout_url)
    : null;
  const resultHeading = order && (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 ref={resultTitle} tabIndex={-1} className="font-medium">
        测试订单已创建
      </h3>
      <StatusBadge value={order.payment.status} />
    </div>
  );
  const content = order ? (
    <div className="flex min-w-0 flex-col gap-4">
      {dialog && resultHeading}
      <DetailFields
        items={[
          ["测试金额", money(order.requested_amount_cents)],
          [
            "实际应付",
            <strong className="tabular-nums">
              {money(order.payable_amount_cents)}
            </strong>,
          ],
          ["商户订单号", order.merchant_order_no],
        ]}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Link
          className={buttonVariants({ variant: "outline" })}
          to={"/orders/" + order.order_id}
        >
          查看订单
        </Link>
        <Button variant="ghost" onClick={onNew}>
          再创建一笔
        </Button>
      </div>
      {!checkoutUrl && (
        <Alert>
          <AlertCircle />
          <AlertDescription>
            收银台地址不可用，请打开订单查看。
          </AlertDescription>
        </Alert>
      )}
      <RecordTools data={order} identifiers={[["订单编号", order.order_id]]} />
    </div>
  ) : (
    <QueryView query={status}>
      {({ data }) => (
        <div className="flex flex-col gap-4">
          {data.status === "not_ready" && (
            <Alert>
              <AlertCircle />
              <AlertDescription>
                暂不能收款，请<Link to="/settings">完成配置</Link>或查看
                <Link to="/system">运行状态</Link>。
              </AlertDescription>
            </Alert>
          )}
          <form id={formId} onSubmit={submit}>
            <FieldGroup>
              <Field data-invalid={!!validation}>
                <FieldLabel htmlFor="test-payment-amount">
                  测试金额（元）
                </FieldLabel>
                <InputGroup>
                  <InputGroupAddon>
                    <InputGroupText>¥</InputGroupText>
                  </InputGroupAddon>
                  <InputGroupInput
                    id="test-payment-amount"
                    ref={amountField}
                    name="amount"
                    inputMode="decimal"
                    autoComplete="off"
                    required
                    value={amount}
                    disabled={create.isPending}
                    onChange={(event) => {
                      setAmount(event.target.value);
                      setValidation(null);
                      create.reset();
                    }}
                    aria-invalid={!!validation}
                    aria-describedby={
                      validation
                        ? "test-payment-hint " + errorId
                        : "test-payment-hint"
                    }
                  />
                </InputGroup>
                <FieldDescription id="test-payment-hint">
                  真实付款，以收银台金额为准。
                </FieldDescription>
                {validation && (
                  <FieldError id={errorId}>{validation.message}</FieldError>
                )}
              </Field>
              <ErrorNotice error={create.error} />
            </FieldGroup>
          </form>
        </div>
      )}
    </QueryView>
  );
  const primaryAction = order ? (
    checkoutUrl && (
      <a
        className={buttonVariants()}
        href={checkoutUrl}
        target="_blank"
        rel="noopener noreferrer"
      >
        打开收银台
      </a>
    )
  ) : (
    <Button
      type="submit"
      form={formId}
      disabled={create.isPending || !canCreate}
    >
      {create.isPending && (
        <Spinner aria-hidden="true" data-icon="inline-start" />
      )}
      创建测试订单
    </Button>
  );

  if (dialog)
    return (
      <Dialog
        open={dialog.open}
        onOpenChange={(open, event) => {
          if (!open && (submitting.current || create.isPending)) event.cancel();
          else dialog.onOpenChange(open);
        }}
      >
        <DialogContent
          className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-xl"
          initialFocus={dialogTitle}
          finalFocus={dialog.finalFocus}
          showCloseButton={!create.isPending}
        >
          <DialogHeader className="shrink-0 pr-8">
            <DialogTitle ref={dialogTitle} tabIndex={-1}>
              测试收款
            </DialogTitle>
            <DialogDescription>
              创建真实收款订单，付款以收银台金额为准。
            </DialogDescription>
          </DialogHeader>
          <div className="-mx-4 min-h-0 overflow-auto px-4 pb-1">{content}</div>
          <DialogFooter className="shrink-0">
            <Button
              variant="outline"
              disabled={create.isPending}
              onClick={() => {
                if (!submitting.current && !create.isPending)
                  dialog.onOpenChange(false);
              }}
            >
              {order ? "关闭" : "取消"}
            </Button>
            {primaryAction}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  return (
    <Card>
      <CardHeader>
        <CardTitle
          role="heading"
          aria-level={2}
          ref={resultTitle}
          tabIndex={order ? -1 : undefined}
        >
          {order ? "测试订单已创建" : "创建测试订单"}
        </CardTitle>
        {order && (
          <CardAction>
            <StatusBadge value={order.payment.status} />
          </CardAction>
        )}
      </CardHeader>
      <CardContent>{content}</CardContent>
      <CardFooter>{primaryAction}</CardFooter>
    </Card>
  );
}
