import { useState, type FormEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowUpRight, CheckCircle2, ScanLine } from "lucide-react";
import { Link } from "../navigation";

import { api, refreshOperationalData, result } from "../api/client";
import { Badge, Button, CopyValue, Details, ErrorNotice, Field, Notice, PageHeading, Panel, QueryView } from "../components/ui";
import { money, parseAmount, safeCheckoutUrl } from "../lib/format";
import { useOperationKey } from "../lib/idempotency";

export default function TestPayment() {
  const [generation, setGeneration] = useState(0);
  return <><PageHeading title="测试收款" back={{ to: "/", label: "收款概览" }} />
    <TestPaymentForm key={generation} onNew={() => setGeneration(generation + 1)} />
  </>;
}

function TestPaymentForm({ onNew }: { onNew: () => void }) {
  const [amount, setAmount] = useState("0.01");
  const [accepted, setAccepted] = useState(false);
  const [validation, setValidation] = useState<Error | null>(null);
  const operationKey = useOperationKey();
  const status = useQuery({ queryKey: ["status"], queryFn: ({ signal }) => result(api.getAdministratorSystemStatus({ signal })) });
  const create = useMutation({
    mutationFn: (cents: number) => result(api.createAdministratorTestPayment({ body: { amount_cents: cents, test_payment_id: operationKey(cents) } })),
    onSuccess: () => { void refreshOperationalData(); },
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try { const cents = parseAmount(amount); setValidation(null); create.mutate(cents); }
    catch (error) { setValidation(error as Error); }
  }
  if (create.data) {
    const order = create.data.data;
    const checkoutUrl = safeCheckoutUrl(order.checkout.checkout_url);
    return <Panel title="测试订单已创建" className="content-panel narrow-panel">
      <Notice tone="success"><CheckCircle2 size={16} className="inline-icon" />订单已经保存。按收银台显示的准确金额付款后，回到订单详情查看确认结果。</Notice>
      <Details items={[["测试金额", money(order.requested_amount_cents)], ["实际应付", <strong className="amount">{money(order.payable_amount_cents)}</strong>], ["付款状态", <Badge value={order.payment.status} />], ["商户订单号", order.merchant_order_no]]} />
      <CopyValue value={order.order_id} label="复制订单编号" />
      <div className="form-actions">{checkoutUrl && <a className="button button--primary" href={checkoutUrl} target="_blank" rel="noreferrer">打开收银台<ArrowUpRight size={16} /></a>}<Link className="button" to={`/orders/${order.order_id}`}>查看订单</Link><Button variant="quiet" onClick={onNew}>再创建一笔</Button></div>
    </Panel>;
  }
  return <Panel title="创建小额测试订单" className="content-panel narrow-panel">
    <Notice tone="warning">这不是模拟支付。付款后资金会进入配置的支付宝账户；测试金额最高 ¥100.00。为区分订单，实际应付金额可能包含随机尾差。</Notice>
    <QueryView query={status}>{({ data }) => <>
      {data.status === "not_ready" && <Notice tone="warning">实例尚未就绪，请先<Link to="/settings">完成收款配置</Link>，或查看<Link to="/system">运行状态</Link>。</Notice>}
      <form onSubmit={submit} className="form-stack">
        <Field label="测试金额（元）" hint="例如 0.01。务必按最终收银台金额付款，不要按此处填写的原始金额付款。"><input name="amount" inputMode="decimal" required value={amount} disabled={create.isPending} onChange={(event) => setAmount(event.target.value)} /></Field>
        <label className="checkbox-field"><input type="checkbox" required checked={accepted} disabled={create.isPending} onChange={(event) => setAccepted(event.target.checked)} /><span>我了解这会创建真实收款订单。</span></label>
        <ErrorNotice error={validation ?? create.error} />
        <div className="form-actions"><Button type="submit" variant="primary" pending={create.isPending} disabled={!accepted || data.status === "not_ready"}><ScanLine size={17} />创建测试订单</Button></div>
      </form>
    </>}</QueryView>
  </Panel>;
}
