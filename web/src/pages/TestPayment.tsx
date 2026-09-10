import { useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "../navigation";

import { api, refreshOperationalData, result } from "../api/client";
import { Badge, Button, CopyValue, Details, ErrorNotice, Field, Notice, PageHeading, Panel, QueryView } from "../components/ui";
import { money, parseAmount, safeCheckoutUrl } from "../lib/format";
import { useOperationKey } from "../lib/idempotency";

export default function TestPayment() {
  const [generation, setGeneration] = useState(0);
  return <div className="test-payment-page"><PageHeading title="测试收款" back={{ to: "/", label: "收款概览" }} />
    <TestPaymentForm key={generation} onNew={() => setGeneration(generation + 1)} />
  </div>;
}

function TestPaymentForm({ onNew }: { onNew: () => void }) {
  const [amount, setAmount] = useState("0.01");
  const amountField = useRef<HTMLInputElement>(null);
  const [validation, setValidation] = useState<Error | null>(null);
  const operationKey = useOperationKey();
  const status = useQuery({ queryKey: ["status"], queryFn: ({ signal }) => result(api.getAdministratorSystemStatus({ signal })) });
  const create = useMutation({
    mutationFn: (cents: number) => result(api.createAdministratorTestPayment({ body: { amount_cents: cents, test_payment_id: operationKey(cents) } })),
    onSuccess: () => { void refreshOperationalData(); },
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (create.isPending || !status.data || status.isError || status.data.data.status === "not_ready") return;
    try { const cents = parseAmount(amount); setValidation(null); create.mutate(cents); }
    catch (error) { setValidation(error as Error); amountField.current?.focus(); }
  }
  if (create.data) {
    const order = create.data.data;
    const checkoutUrl = safeCheckoutUrl(order.checkout.checkout_url);
    return <Panel title="测试订单已创建" className="content-panel">
      <Details items={[["测试金额", money(order.requested_amount_cents)], ["实际应付", <strong className="amount">{money(order.payable_amount_cents)}</strong>], ["付款状态", <Badge value={order.payment.status} />], ["商户订单号", order.merchant_order_no]]} />
      <CopyValue value={order.order_id} label="复制订单编号" />
      <div className="form-actions">{checkoutUrl && <a className="button button--primary" href={checkoutUrl} target="_blank" rel="noopener noreferrer">打开收银台</a>}<Link className="button" to={"/orders/" + order.order_id}>查看订单</Link><Button variant="quiet" onClick={onNew}>再创建一笔</Button></div>
    </Panel>;
  }
  return <Panel className="content-panel">
    <QueryView query={status}>{({ data }) => <>
      {data.status === "not_ready" && <Notice tone="warning">暂不能收款，请<Link to="/settings">完成配置</Link>或查看<Link to="/system">运行状态</Link>。</Notice>}
      <form onSubmit={submit} className="form-stack test-payment-form">
        <Field label="测试金额（元）" hint="真实付款，以收银台金额为准。" error={validation?.message}><input ref={amountField} name="amount" inputMode="decimal" autoComplete="off" required value={amount} disabled={create.isPending} onChange={(event) => { setAmount(event.target.value); setValidation(null); }} /></Field>
        <ErrorNotice error={create.error} />
        <div className="form-actions"><Button type="submit" variant="primary" pending={create.isPending} disabled={data.status === "not_ready" || status.isError}>创建测试订单</Button></div>
      </form>
    </>}</QueryView>
  </Panel>;
}
