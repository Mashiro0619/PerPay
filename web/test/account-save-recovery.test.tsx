import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { alipayAccount, json } from "./fixtures";
import { mountOnboarding, systemStatus } from "./onboarding-fixture";

it("账号冲突时弹窗底部操作也停用，重读后保留草稿并恢复操作", async () => {
  let account = { ...alipayAccount };
  const view = mountOnboarding({ stage: 4, path: "/settings/accounts/" + account.id, handle: request => {
    const path = new URL(request.url).pathname;
    if (path === "/api/admin/v1/alipay-accounts") return json({ data: [account] });
    if (path !== "/api/admin/v1/alipay-accounts/" + account.id) return undefined;
    if (request.method === "GET") return json({ data: account });
    return json({ error: { code: "alipay_account_revision_conflict", message: "账号设置已变化，请刷新后重试。" } }, 409);
  } });
  const user = userEvent.setup();
  const dialog = await screen.findByRole("dialog", { name: "支付宝账号" });
  const name = await within(dialog).findByLabelText("账号名称");
  await user.clear(name);
  await user.type(name, "仍保留的账号名称");
  await user.click(within(dialog).getByRole("button", { name: "更多账号操作" }));
  await user.click(await screen.findByRole("menuitem", { name: "保存草稿" }));
  const reload = await within(dialog).findByRole("button", { name: "重新读取账号" });
  expect(within(dialog).getByRole("button", { name: "更多账号操作" })).toBeDisabled();
  expect(within(dialog).getByRole("button", { name: "保存并检查" })).toBeDisabled();
  account = { ...account, revision: account.revision + 1, enabled: false };
  await user.click(reload);
  await within(dialog).findByText("账号配置已重新读取");
  expect(name).toHaveValue("仍保留的账号名称");
  expect(within(dialog).getByRole("switch", { name: "接收新订单" })).not.toBeChecked();
  expect(within(dialog).getByRole("button", { name: "更多账号操作" })).toBeEnabled();
  expect(within(dialog).getByRole("button", { name: "保存并检查" })).toBeEnabled();
  expect(view.writes()).toHaveLength(1);
});

it("releases the account editor after saving while a background status read is still pending", async () => {
  let account = { ...alipayAccount };
  let saved = false;
  let statusReads = 0;
  let finishStatus!: (response: Response) => void;
  const pendingStatus = new Promise<Response>(resolve => { finishStatus = resolve; });
  const view = mountOnboarding({ stage: 4, path: "/settings/accounts/" + account.id, handle: request => {
    const path = new URL(request.url).pathname;
    if (path.endsWith("/system/status") && saved) { statusReads++; return pendingStatus; }
    if (path === "/api/admin/v1/alipay-accounts") return json({ data: [account] });
    if (path !== "/api/admin/v1/alipay-accounts/" + account.id) return undefined;
    if (request.method === "GET") return json({ data: account });
    return request.clone().json().then(input => {
      saved = true;
      account = { ...account, ...input, revision: account.revision + 1 };
      return json({ data: account });
    });
  } });
  try {
    const user = userEvent.setup();
    const dialog = await screen.findByRole("dialog", { name: "支付宝账号" });
    const name = await within(dialog).findByLabelText("账号名称");
    await user.clear(name);
    await user.type(name, "已保存的收款账号");
    await user.click(within(dialog).getByRole("button", { name: "更多账号操作" }));
    await user.click(await screen.findByRole("menuitem", { name: "保存草稿" }));
    await within(dialog).findByText("账号已保存");
    await waitFor(() => expect(statusReads).toBe(1));
    expect(account.name).toBe("已保存的收款账号");
    await waitFor(() => expect(name).toBeEnabled());
    await user.click(within(dialog).getByRole("button", { name: "关闭对话框" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "支付宝账号" })).not.toBeInTheDocument());
    await act(async () => { await view.router.navigate("/settings/display"); });
    expect(view.router.state.location.pathname).toBe("/settings/display");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(view.writes()).toHaveLength(1);
  } finally {
    await act(async () => finishStatus(json({ data: systemStatus() })));
  }
});
