import { useId, useRef, type FormEvent } from "react";
import { ArrowLeft, AlertCircle } from "lucide-react";
import { Link } from "@/navigation";
import { useCurrentTestPayment } from "@/lib/test-payment-request";
import { CopyValue } from "@/components/copy-value";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ErrorNotice, QueryView } from "@/components/request-state";
import { TestPaymentResult } from "@/components/test-payment-result";
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
  FieldTitle,
  FieldDescription,
  FieldError,
  FieldGroup,
} from "@/components/ui/field";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
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
  const { generation } = useCurrentTestPayment();
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
      <TestPaymentForm key={generation} />
    </div>
  );
}

export function TestPaymentDialog(props: TestPaymentDialogProps) {
  const { generation } = useCurrentTestPayment();
  return <TestPaymentForm key={generation} dialog={props} />;
}

function TestPaymentForm({ dialog }: { dialog?: TestPaymentDialogProps }) {
  const request = useCurrentTestPayment();
  const { amount, validation, recovery, create, status, canCreate, startNew } =
    request;
  const amountField = useRef<HTMLInputElement>(null);
  const dialogTitle = useRef<HTMLHeadingElement>(null);
  const formId = useId();
  const errorId = useId();
  const recoveryHintId = useId();
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (request.submit() === "invalid") amountField.current?.focus();
  }

  const order = create.data?.data;
  const form = (
    <form id={formId} onSubmit={submit}>
      <FieldGroup>
        {recovery && (
          <Alert>
            <AlertCircle />
            <AlertTitle>创建结果待确认</AlertTitle>
            <AlertDescription>
              未收到完整结果，订单可能已创建。重试会沿用原金额和请求编号；已有订单会直接返回，若尚未创建则完成这一次创建。
            </AlertDescription>
          </Alert>
        )}
        <Field data-invalid={!!validation}>
          <FieldLabel htmlFor="test-payment-amount">测试金额（元）</FieldLabel>
          <InputGroup>
            <InputGroupInput
              id="test-payment-amount"
              ref={amountField}
              name="amount"
              inputMode="decimal"
              autoComplete="off"
              required
              value={amount}
              disabled={create.isPending}
              readOnly={!!recovery}
              onChange={(event) => request.editAmount(event.target.value)}
              aria-invalid={!!validation}
              aria-describedby={
                recovery
                  ? recoveryHintId
                  : validation
                    ? "test-payment-hint " + errorId
                    : "test-payment-hint"
              }
            />
            <InputGroupAddon align="inline-start">
              <InputGroupText>¥</InputGroupText>
            </InputGroupAddon>
          </InputGroup>
          <FieldDescription
            id={recovery ? recoveryHintId : "test-payment-hint"}
          >
            {recovery
              ? "原金额已锁定，请先恢复这笔订单，再创建另一笔。"
              : "真实付款，以收银台金额为准。"}
          </FieldDescription>
          {validation && (
            <FieldError id={errorId}>{validation.message}</FieldError>
          )}
        </Field>
        {recovery ? (
          <>
            <Field>
              <FieldTitle>商户订单号</FieldTitle>
              <CopyValue
                value={"test-" + recovery.test_payment_id}
                label="复制商户订单号"
              />
              <FieldDescription>
                暂时关闭后仍可恢复。刷新页面或退出登录前，请复制此编号，之后可在订单列表核查。
              </FieldDescription>
            </Field>
            {create.error && (
              <Collapsible>
                <CollapsibleTrigger
                  render={<Button variant="ghost" size="sm" />}
                >
                  失败详情
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <ErrorNotice error={create.error} />
                </CollapsibleContent>
              </Collapsible>
            )}
            <Link
              className={buttonVariants({
                variant: "link",
                size: "sm",
                className: "w-fit",
              })}
              to="/orders"
            >
              查看订单列表
            </Link>
          </>
        ) : (
          <ErrorNotice error={create.error} />
        )}
      </FieldGroup>
    </form>
  );
  const content = (
    <div className="flex flex-col gap-4">
      {!recovery && (
        <QueryView query={status}>
          {({ data }) =>
            data.status === "not_ready" ? (
              <Alert>
                <AlertCircle />
                <AlertDescription>
                  暂不能收款，请<Link to="/settings">完成配置</Link>或查看
                  <Link to="/system">运行状态</Link>。
                </AlertDescription>
              </Alert>
            ) : null
          }
        </QueryView>
      )}
      {(recovery || status.data) && form}
    </div>
  );
  const primaryAction = (
    <Button
      type="submit"
      form={formId}
      disabled={create.isPending || (!recovery && !canCreate)}
    >
      {create.isPending && (
        <Spinner aria-hidden="true" data-icon="inline-start" />
      )}
      {recovery ? "重试原请求" : "创建测试订单"}
    </Button>
  );

  if (dialog)
    return (
      <Dialog
        open={dialog.open}
        onOpenChange={(open, event) => {
          if (!open && request.isSubmitting()) event.cancel();
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
          {order ? (
            <TestPaymentResult
              created={order}
              onNew={startNew}
              onClose={() => dialog.onOpenChange(false)}
            />
          ) : (
            <>
              <div className="-mx-4 min-h-0 overflow-auto px-4 pb-1">
                {content}
              </div>
              <DialogFooter className="shrink-0 flex-row justify-end">
                <Button
                  variant="outline"
                  disabled={create.isPending}
                  onClick={() => {
                    if (!request.isSubmitting()) dialog.onOpenChange(false);
                  }}
                >
                  {recovery ? "暂时关闭" : "取消"}
                </Button>
                {primaryAction}
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    );
  return (
    <Card>
      {order ? (
        <TestPaymentResult created={order} onNew={startNew} />
      ) : (
        <>
          <CardHeader>
            <CardTitle role="heading" aria-level={2}>
              创建测试订单
            </CardTitle>
          </CardHeader>
          <CardContent>{content}</CardContent>
          <CardFooter>{primaryAction}</CardFooter>
        </>
      )}
    </Card>
  );
}
