import { useRef, useState, type FormEvent } from "react";
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
} from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
        onNew={() => setGeneration(generation + 1)}
      />
    </div>
  );
}
function TestPaymentForm({ onNew }: { onNew: () => void }) {
  const [amount, setAmount] = useState("0.01");
  const amountField = useRef<HTMLInputElement>(null);
  const [validation, setValidation] = useState<Error | null>(null);
  const operationKey = useOperationKey();
  const status = useQuery({
    queryKey: ["status"],
    queryFn: ({ signal }) =>
      result(api.getAdministratorSystemStatus({ signal })),
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
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      create.isPending ||
      !status.data ||
      status.isError ||
      status.data.data.status === "not_ready"
    )
      return;
    try {
      const cents = parseAmount(amount);
      setValidation(null);
      create.mutate(cents);
    } catch (error) {
      setValidation(error as Error);
      amountField.current?.focus();
    }
  }

  if (create.data) {
    const order = create.data.data;
    const checkoutUrl = safeCheckoutUrl(order.checkout.checkout_url);
    return (
      <Card>
        <CardHeader>
          <CardTitle role="heading" aria-level={2}>
            测试订单已创建
          </CardTitle>
          <CardAction>
            <StatusBadge value={order.payment.status} />
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
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
            {checkoutUrl && (
              <a
                className={buttonVariants()}
                href={checkoutUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                打开收银台
              </a>
            )}
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
          <RecordTools
            data={order}
            identifiers={[["订单编号", order.order_id]]}
          />
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>
          创建测试订单
        </CardTitle>
      </CardHeader>
      <CardContent>
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
              <form onSubmit={submit}>
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
                        aria-describedby="test-payment-hint"
                      />
                    </InputGroup>
                    <FieldDescription id="test-payment-hint">
                      真实付款，以收银台金额为准。
                    </FieldDescription>
                    {validation && (
                      <FieldError>{validation.message}</FieldError>
                    )}
                  </Field>
                  <ErrorNotice error={create.error} />
                  <Field orientation="horizontal">
                    <Button
                      type="submit"
                      disabled={
                        create.isPending ||
                        data.status === "not_ready" ||
                        status.isError
                      }
                    >
                      {create.isPending && (
                        <Spinner aria-hidden="true" data-icon="inline-start" />
                      )}
                      创建测试订单
                    </Button>
                  </Field>
                </FieldGroup>
              </form>
            </div>
          )}
        </QueryView>
      </CardContent>
    </Card>
  );
}
