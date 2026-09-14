import { StrictMode, useState } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

import type { AdminWorkItem, WebhookAttemptOutcome } from "../src/api/client";
import { WorkItemList } from "../src/components/WorkItemList";
import { Button, CopyValue, Dialog, Field } from "../src/components/ui";
import { label } from "../src/lib/labels";

function DialogHarness() {
  const [open, setOpen] = useState(false);
  return <><Button onClick={() => setOpen(true)}>打开确认</Button>
    {open && <Dialog title="确认操作" onClose={() => setOpen(false)}><Button onClick={() => setOpen(false)}>取消</Button></Dialog>}
  </>;
}

describe("native dialogs", () => {
  it("associates nested fields with labels, hints and inline errors", () => {
    render(<Field label="密码" hint="至少 6 个字符" error="密码过短"><span><input name="password" /><button type="button">显示</button></span></Field>);
    const input = screen.getByRole("textbox", { name: "密码" });
    expect(input).toHaveAccessibleDescription("至少 6 个字符 密码过短");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "显示" }).closest("label")).toBeNull();
  });
  it("restores the trigger focus before unmounting, including Strict Mode", async () => {
    const user = userEvent.setup();
    render(<StrictMode><DialogHarness /></StrictMode>);
    const trigger = screen.getByRole("button", { name: "打开确认" });
    await user.click(trigger);
    expect(screen.getByRole("dialog", { name: "确认操作" })).toHaveAttribute("open");
    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("handles native cancellation and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    render(<DialogHarness />);
    const trigger = screen.getByRole("button", { name: "打开确认" });
    await user.click(trigger);
    fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("does not dismiss an operation while its request is pending", () => {
    const onClose = vi.fn();
    render(<Dialog title="正在确认" busy onClose={onClose}>等待请求完成</Dialog>);
    const cancellation = new Event("cancel", { cancelable: true });
    fireEvent(screen.getByRole("dialog"), cancellation);
    expect(cancellation.defaultPrevented).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toHaveAttribute("open");
    expect(screen.getByRole("button", { name: "关闭对话框" })).toBeDisabled();
  });
});

const workItem: AdminWorkItem = {
  type: "FINANCIAL_EXCEPTION", status: "OPEN", exception_type: "UNMATCHED_CREDIT", candidate_id: null,
  resource_id: "00000000-0000-4000-8000-000000000001", provider_account_key: "synthetic-account",
  order_id: null, ledger_entry_id: null, created_at: "2026-09-06T12:00:00Z", actionable_at: "2026-09-06T12:00:00Z",
  ignored_at: null, ignored_by: null, ended: false,
  detail_url: "/api/admin/v1/reconciliation/exceptions/00000000-0000-4000-8000-000000000001",
};

describe("work item heading hierarchy", () => {
  it.each([2, 3] as const)("uses level %i in populated lists", (headingLevel) => {
    render(<MemoryRouter><WorkItemList items={[workItem]} headingLevel={headingLevel} /></MemoryRouter>);
    expect(screen.getByRole("heading", { level: headingLevel, name: "收入尚未匹配订单" })).toBeVisible();
  });

  it.each([2, 3] as const)("uses level %i in empty lists", (headingLevel) => {
    render(<WorkItemList items={[]} headingLevel={headingLevel} />);
    expect(screen.getByRole("heading", { level: headingLevel, name: "暂时没有待处理事项" })).toBeVisible();
    expect(screen.queryByText("账务异常、账本冲突和失败通知会汇总到这里。")).not.toBeInTheDocument();
  });
});

const attemptLabels: Record<WebhookAttemptOutcome, string> = {
  STARTED: "投递已开始", ACKNOWLEDGED: "业务方已确认", RETRYABLE_FAILURE: "可重试的投递失败",
  PERMANENT_FAILURE: "不可重试的投递失败", OUTCOME_UNKNOWN: "投递结果未知",
};

describe("notification attempt labels", () => {
  it.each(Object.entries(attemptLabels))("explains %s in Chinese", (outcome, expected) => {
    expect(label(outcome)).toBe(expected);
  });
});

const syntheticPem = "-----BEGIN PRIVATE KEY-----\r\n" + "synthetic-content-not-a-real-key".repeat(12) + "\r\n-----END PRIVATE KEY-----\r\n";

describe("copyable secret layout", () => {
  it.each([true, false])("separates multiline content from the copy toolbar (secret=%s) without changing copied bytes", async (secret) => {
    const user = userEvent.setup();
    const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    render(<CopyValue value={syntheticPem} label="复制测试密钥" secret={secret} />);
    const region = screen.getByRole("region", { name: secret ? "密钥内容" : "可复制内容" });
    expect(region).toHaveAttribute("tabindex", "0");
    expect(region.querySelector("code")?.textContent).toBe(syntheticPem);
    expect(within(region).queryByRole("button")).not.toBeInTheDocument();
    const button = screen.getByRole("button", { name: "复制测试密钥" });
    expect(button.closest(".copy-value-toolbar")).not.toBeNull();
    await user.click(button);
    expect(copy).toHaveBeenCalledExactlyOnceWith(syntheticPem);
    expect(button).toHaveTextContent("已复制");
  });

  it("keeps short identifiers compact and offers selection when the clipboard is unavailable", async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("clipboard unavailable"));
    render(<CopyValue value="short-identifier" label="复制编号" />);
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    const button = screen.getByRole("button", { name: "复制编号" });
    expect(button).toHaveClass("icon-button");
    await user.click(button);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("无法自动复制，请选中文本手动复制。"));
    expect(screen.getByText("short-identifier")).toBeVisible();
  });
});
