// SPDX-License-Identifier: MIT
const form = document.querySelector('#order-form');
const create = document.querySelector('#create');
const feedback = document.querySelector('#feedback');
let csrf = null;
let busy = false;
let ordersSignature = '';
let eventsSignature = '';
const labels = { UNPAID: '未确认付款', CONFIRMED: '已确认付款', DISPUTED: '付款存在争议', NONE: '无退款', PARTIAL: '部分退款已登记', FULL: '全额退款已登记', OPEN: '收银台开放', CLOSED: '收银台已关闭', EXPIRED: '收银台已过期', PAYMENT_CONFIRMED: '付款确认', PAYMENT_DISPUTED: '付款争议', REFUND_UPDATED: '退款记录更新', updated: '已更新', same_version: '同版本', ignored_older_version: '已忽略旧版本', ignored_unknown_order: '非本机订单，未处理' };
const money = cents => cents == null ? '未知' : new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' }).format(cents / 100);
function element(tag, text, className) { const node = document.createElement(tag); node.textContent = text; if (className) node.className = className; return node; }
function report(text, error = false) { feedback.textContent = text; feedback.classList.toggle('is-error', error); feedback.setAttribute('role', error ? 'alert' : 'status'); }
function newNumber() { document.querySelector('#merchant-no').value = 'DEMO-' + crypto.randomUUID().replaceAll('-', ''); }
async function request(path, payload) {
  const response = await fetch(path, { cache: 'no-store', ...(payload === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', 'x-demo-csrf': csrf }, body: JSON.stringify(payload) }) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? '操作失败。');
  return data;
}
function orderAction(no, action, text) {
  const button = element('button', text); button.type = 'button'; button.dataset.order = no; button.dataset.action = action;
  button.addEventListener('click', () => operate(async () => { await request('/demo/orders/' + encodeURIComponent(no) + '/' + action, {}); report(action === 'retry' ? '已用原单号和原参数重试；不会新建另一笔业务订单。' : '已向 PerPay 查询当前状态。'); }));
  return button;
}
function renderOrders(orders, origin) {
  const container = document.querySelector('#orders');
  const active = document.activeElement;
  const focus = active?.dataset.order ? { no: active.dataset.order, action: active.dataset.action } : null;
  container.replaceChildren();
  if (!orders.length) container.append(element('p', '还没有订单，先创建第一笔。', 'empty'));
  for (const order of orders) {
    const item = element('article', '', 'order');
    item.append(element('h3', order.product_name), element('p', order.merchant_order_no, 'id'));
    const snapshot = order.snapshot;
    item.append(element('p', '请求金额 ' + money(order.amount_cents) + (snapshot ? ' · 实际应付 ' + money(snapshot.payable_amount_cents) : ' · 尚未取得订单响应')));
    if (snapshot) {
      item.append(element('p', (labels[snapshot.payment_status] ?? snapshot.payment_status) + ' · ' + (labels[snapshot.refund_status] ?? snapshot.refund_status) + ' · 版本 ' + snapshot.version));
      item.append(element('p', '来源：' + (snapshot.source === 'webhook' ? '已验签通知' : 'PerPay 服务端响应'), 'muted'));
    }
    if (!order.notifications) item.append(element('p', '此旧订单没有回调地址，需手动查单；新订单会使用当前回调配置。', 'muted'));
    if (order.last_error) item.append(element('p', order.last_error, 'error'));
    const actions = element('div', '', 'actions');
    if (snapshot?.checkout_url && snapshot.payment_status === 'UNPAID' && snapshot.checkout_status === 'OPEN' && Date.parse(snapshot.expires_at) > Date.now()) {
      const url = new URL(snapshot.checkout_url);
      if (url.origin === origin && url.pathname.startsWith('/checkout/')) {
        const link = element('a', '打开收银台'); link.href = url.href; link.target = '_blank'; link.rel = 'noreferrer'; actions.append(link);
      }
    }
    if (!snapshot || order.last_error) actions.append(orderAction(order.merchant_order_no, 'retry', '按原参数重试创建'));
    actions.append(orderAction(order.merchant_order_no, 'refresh', '手动查单'));
    item.append(actions); container.append(item);
  }
  if (focus) Array.from(container.querySelectorAll('button')).find(button => button.dataset.order === focus.no && button.dataset.action === focus.action)?.focus();
}
async function refresh() {
  const state = await request('/demo/state'); csrf = state.csrf;
  document.querySelector('#connection').textContent = 'PerPay 地址：' + state.perpay_url + ' · 密钥仅保存在后端';
  document.querySelector('#notification-hint').textContent = state.notifications ? '回调地址已配置：收到付款通知并验签后，订单状态自动更新。' : '回调配置缺失，请填写通知地址和签名密钥后重启 Demo。';
  // Unchanged polling must not replace focused controls. No upstream polling is automatic.
  const signature = JSON.stringify(state.orders) + state.orders.map(order => Date.parse(order.snapshot?.expires_at) > Date.now()).join();
  if (signature !== ordersSignature) { renderOrders(state.orders, state.perpay_url); ordersSignature = signature; }
  if (JSON.stringify(state.events) !== eventsSignature) {
    const list = document.querySelector('#events'); list.replaceChildren();
    for (const event of state.events) list.append(element('li', (labels[event.event_type] ?? event.event_type) + ' · ' + event.merchant_order_no + ' · 版本 ' + event.order_version + ' · ' + (labels[event.disposition] ?? event.disposition)));
    if (!state.events.length) list.append(element('li', '尚未接到通知。', 'muted'));
    eventsSignature = JSON.stringify(state.events);
  }
  create.disabled = busy;
}
async function operate(action) {
  if (busy) return;
  busy = true; create.disabled = true;
  document.querySelector('#new-order').disabled = true;
  try { await action(); } catch (error) { report(error.message, true); }
  finally {
    busy = false; document.querySelector('#new-order').disabled = false;
    try { await refresh(); } catch { report('本机示例服务暂时不可用，请确认终端仍在运行。', true); }
  }
}
form.addEventListener('submit', event => {
  event.preventDefault(); const data = new FormData(form);
  void operate(async () => {
    await request('/demo/orders', { merchant_order_no: data.get('merchant_order_no'), product_name: data.get('product_name'), amount: data.get('amount'), note: data.get('note'), confirm_real_payment: data.has('confirm_real_payment') });
    report('订单已创建。打开收银台付款，收到回调后这里会自动更新。');
  });
});
document.querySelector('#new-order').addEventListener('click', () => { newNumber(); form.elements.confirm_real_payment.checked = false; report('已更换业务单号。之前的订单仍在本机记录中，重试请使用原订单的按钮。'); });
document.querySelector('#reload').addEventListener('click', () => { void refresh().catch(() => report('无法读取本机记录。', true)); });
newNumber(); void refresh().catch(() => report('无法连接本机示例服务，请确认终端仍在运行。', true));
setInterval(() => { if (!document.hidden && !busy) void refresh().catch(() => {}); }, 5000);
