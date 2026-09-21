import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { OperationRecoveryNotice } from "@/components/operation-recovery-notice";

const operationId = "42b17c31-8353-40f8-91e5-fb87d77ea8e4";

describe("operation recovery attention", () => {
  it("focuses the result summary and exposes the explanation without stealing focus on passive rerenders", async () => {
    const error = new Error("lost response");
    const { rerender } = render(
      <OperationRecoveryNotice
        operationId={operationId}
        conflict={false}
        error={error}
      />,
    );
    const title = screen.getByText("操作结果待确认", { exact: true });
    await waitFor(() => expect(title).toHaveFocus());
    expect(title).toHaveAccessibleDescription(/操作可能已生效/);
    expect(title).toHaveAttribute("tabindex", "-1");
    const details = screen.getByRole("button", { name: "响应详情" });
    await userEvent.click(details);
    expect(details).toHaveFocus();
    rerender(
      <OperationRecoveryNotice
        operationId={operationId}
        conflict={false}
        error={error}
      />,
    );
    expect(details).toHaveFocus();
  });

  it("returns attention to a new failed retry, not to a pending or unrelated update", async () => {
    const content = (error: unknown, conflict = false) => (
      <>
        <button type="button">另一个控件</button>
        <OperationRecoveryNotice
          operationId={operationId}
          conflict={conflict}
          error={error}
        />
      </>
    );
    const { rerender } = render(content(new Error("lost response")));
    await waitFor(() =>
      expect(screen.getByText("操作结果待确认", { exact: true })).toHaveFocus(),
    );
    const other = screen.getByRole("button", { name: "另一个控件" });
    await userEvent.click(other);
    rerender(content(null));
    expect(other).toHaveFocus();
    rerender(content(new Error("state conflict"), true));
    const title = screen.getByText("操作结果待确认", { exact: true });
    await waitFor(() => expect(title).toHaveFocus());
    expect(title).toHaveAccessibleDescription(/请关闭并刷新/);
  });
});
