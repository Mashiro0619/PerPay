import { StrictMode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import {
  queryClient,
  type AdminWorkItem,
  type WebhookAttemptOutcome,
} from "../src/api/client";
import { label } from "../src/lib/labels";
import { Button } from "../src/components/ui/button";
import { Input } from "../src/components/ui/input";
import {
  Field,
  FieldLabel,
  FieldDescription,
  FieldError,
} from "../src/components/ui/field";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogClose,
} from "../src/components/ui/dialog";
import { ReasonDialog } from "../src/components/ReasonDialog";
import { CopyValue } from "../src/components/copy-value";
import { WorkItemsTable } from "../src/components/work-items-table";
function DialogHarness() {
  return (
    <Dialog>
      <DialogTrigger render={<Button />}>打开确认</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>确认操作</DialogTitle>
        </DialogHeader>
        <DialogClose render={<Button variant="outline" />}>取消</DialogClose>
      </DialogContent>
    </Dialog>
  );
}
describe("official field and dialog composition", () => {
  it("associates a field with its hint and error without nesting its auxiliary button in the label", () => {
    render(
      <Field data-invalid>
        <FieldLabel htmlFor="example-password">密码</FieldLabel>
        <Input
          id="example-password"
          aria-invalid
          aria-describedby="example-hint example-error"
        />
        <Button>显示</Button>
        <FieldDescription id="example-hint">至少 6 个字符</FieldDescription>
        <FieldError id="example-error">密码过短</FieldError>
      </Field>,
    );
    expect(
      screen.getByRole("textbox", { name: "密码" }),
    ).toHaveAccessibleDescription("至少 6 个字符 密码过短");
    expect(
      screen.getByRole("button", { name: "显示" }).closest("label"),
    ).toBeNull();
  });
  it("restores trigger focus on cancel in Strict Mode", async () => {
    const user = userEvent.setup();
    render(
      <StrictMode>
        <DialogHarness />
      </StrictMode>,
    );
    const trigger = screen.getByRole("button", { name: "打开确认" });
    await user.click(trigger);
    expect(
      await screen.findByRole("dialog", { name: "确认操作" }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(trigger).toHaveFocus());
  });
  it("supports Escape using Base UI instead of a native dialog cancel event", async () => {
    const user = userEvent.setup();
    render(<DialogHarness />);
    const trigger = screen.getByRole("button", { name: "打开确认" });
    await user.click(trigger);
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(trigger).toHaveFocus();
  });
  it("keeps a financial confirmation open and prevents another submit while pending", async () => {
    const close = vi.fn();
    const execute = vi.fn(() => new Promise<void>(() => {}));
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={queryClient}>
        <ReasonDialog
          title="正在确认"
          description="确认后保存"
          action="确认"
          execute={execute}
          onClose={close}
          onSuccess={vi.fn()}
        />
      </QueryClientProvider>,
    );
    await user.type(screen.getByLabelText("操作理由"), "已核对");
    await user.click(screen.getByRole("button", { name: /^确认$/ }));
    await user.keyboard("{Escape}");
    expect(close).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(screen.getByRole("button", { name: /^确认$/ })).toBeDisabled();
    fireEvent.submit(screen.getByLabelText("操作理由").closest("form")!);
    expect(execute).toHaveBeenCalledOnce();
  });
});
const workItem: AdminWorkItem = {
  type: "FINANCIAL_EXCEPTION",
  status: "OPEN",
  exception_type: "UNMATCHED_CREDIT",
  candidate_id: null,
  resource_id: "00000000-0000-4000-8000-000000000001",
  provider_account_key: "synthetic-account",
  order_id: null,
  ledger_entry_id: null,
  created_at: "2026-09-06T12:00:00Z",
  actionable_at: "2026-09-06T12:00:00Z",
  ignored_at: null,
  ignored_by: null,
  ended: false,
  detail_url:
    "/api/admin/v1/reconciliation/exceptions/00000000-0000-4000-8000-000000000001",
};
describe("work item table", () => {
  it("keeps a real link to the original financial record", () => {
    render(
      <MemoryRouter>
        <WorkItemsTable items={[workItem]} />
      </MemoryRouter>,
    );
    expect(screen.getByRole("table")).toBeVisible();
    expect(
      screen.getByRole("link", { name: "收入尚未匹配订单" }),
    ).toHaveAttribute(
      "href",
      "/reconciliation/exceptions/" + workItem.resource_id,
    );
  });
  it("uses the official lightweight empty state", () => {
    render(<WorkItemsTable items={[]} />);
    expect(
      screen.getByRole("heading", { name: "暂无待处理提醒" }),
    ).toBeVisible();
  });
});
const attemptLabels: Record<WebhookAttemptOutcome, string> = {
  STARTED: "投递已开始",
  ACKNOWLEDGED: "业务方已确认",
  RETRYABLE_FAILURE: "可重试的投递失败",
  PERMANENT_FAILURE: "不可重试的投递失败",
  OUTCOME_UNKNOWN: "投递结果未知",
};

describe("notification attempt labels", () => {
  it.each(Object.entries(attemptLabels))(
    "explains %s in Chinese",
    (outcome, expected) => {
      expect(label(outcome)).toBe(expected);
    },
  );
});

const syntheticPem =
  "-----BEGIN PRIVATE KEY-----\r\n" +
  "synthetic-content-not-a-real-key".repeat(12) +
  "\r\n-----END PRIVATE KEY-----\r\n";
describe("copyable secret content", () => {
  it.each([true, false])(
    "uses a selectable readonly control and copies exact bytes (secret=%s)",
    async (secret) => {
      const user = userEvent.setup();
      const copy = vi
        .spyOn(navigator.clipboard, "writeText")
        .mockResolvedValue();
      render(
        <CopyValue value={syntheticPem} label="复制测试密钥" secret={secret} />,
      );
      const content = screen.getByRole("textbox", {
        name: secret ? "密钥内容" : "可复制内容",
      });
      expect(content).toHaveAttribute("readonly");
      expect(content).toHaveValue(syntheticPem.replaceAll("\r\n", "\n"));
      expect(within(content).queryByRole("button")).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "复制测试密钥" }));
      expect(copy).toHaveBeenCalledExactlyOnceWith(syntheticPem);
      expect(screen.getByRole("status")).toHaveTextContent("已复制");
    },
  );
  it("keeps a short value selectable when clipboard access fails", async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(
      new Error("unavailable"),
    );
    render(<CopyValue value="short-identifier" label="复制编号" />);
    await user.click(screen.getByRole("button", { name: "复制编号" }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "无法自动复制，请选中文本手动复制。",
      ),
    );
    expect(screen.getByText("short-identifier")).toBeVisible();
  });
});
