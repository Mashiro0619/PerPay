import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { queryClient } from "../src/api/client";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CopyValue } from "../src/components/copy-value";
import { SecuritySettings } from "../src/pages/SecuritySettings";
import { recordAction } from "./menu-helper";
import { settings, withSessionList } from "./fixtures";

const longValue = [
  "-----BEGIN PRIVATE KEY-----",
  ...Array.from({ length: 100 }, () =>
    "synthetic-key-content-not-a-real-secret".repeat(2),
  ),
  "-----END PRIVATE KEY-----",
].join("\n");

describe("bounded secret content", () => {
  it.each([true, false])(
    "bounds multiline text without truncating its copied value (secret=%s)",
    async (secret) => {
      const user = userEvent.setup();
      const copy = vi.spyOn(navigator.clipboard, "writeText");
      render(
        <CopyValue value={longValue} label="复制测试内容" secret={secret} />,
      );
      const textbox = screen.getByRole("textbox");
      expect(textbox).toHaveClass(
        "max-h-[min(16rem,40dvh)]",
        "resize-none",
        "overflow-y-auto",
      );
      expect(textbox).toHaveValue(longValue);
      expect(textbox).toHaveAttribute("readonly");
      await user.click(screen.getByRole("button", { name: "复制测试内容" }));
      expect(copy).toHaveBeenCalledExactlyOnceWith(longValue);
      expect(screen.getByRole("status")).toHaveTextContent("已复制");
      expect(screen.getByRole("status").parentElement).toHaveClass("relative");
    },
  );
});

it("bounds the session confirmation without changing its cancel behavior", async () => {
  // This suite tests other security controls; keep the read-only IP lookup cached.
  queryClient.setQueryData(["admin-access-source"], {data:{revision:settings.revision,...settings.admin_access,current_ip:"192.0.2.1"}});

  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", withSessionList(fetchMock));
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <SecuritySettings settings={settings} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  await user.click(await recordAction("注销全部会话", "会话操作"));
  const dialog = await screen.findByRole("alertdialog", {
    name: "注销全部会话？",
  });
  expect(dialog).toHaveClass(
    "max-h-[calc(100dvh-2rem)]",
    "w-[calc(100%-2rem)]",
    "overflow-hidden",
  );
  await user.click(within(dialog).getByRole("button", { name: "取消" }));
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  expect(fetchMock).not.toHaveBeenCalled();
});
