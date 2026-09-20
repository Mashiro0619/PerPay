import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { queryClient } from "../src/api/client";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CopyValue } from "../src/components/copy-value";
import {
  SecretDialog,
  RotateKeyDialog,
  SecuritySettings,
} from "../src/pages/SecuritySettings";
import { recordAction } from "./menu-helper";
import { json, settings } from "./fixtures";

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
    },
  );

  it.each(["reveal", "rotate"] as const)(
    "keeps the %s title and closing action outside the scrollable content",
    async (kind) => {
      vi.spyOn(document, "hidden", "get").mockReturnValue(false);
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          json({
            data:
              kind === "reveal"
                ? { value: longValue }
                : { secret: longValue, settings },
          }),
        ),
      );
      const onClose = vi.fn();
      const user = userEvent.setup();
      render(
        kind === "reveal" ? (
          <SecretDialog
            name="provider_private_key"
            title="应用私钥"
            onClose={onClose}
          />
        ) : (
          <RotateKeyDialog
            settings={{
              ...settings,
              completion: { ...settings.completion, api: false },
            }}
            onSaved={vi.fn()}
            onClose={onClose}
          />
        ),
      );
      if (kind === "rotate")
        await user.click(screen.getByRole("button", { name: "生成密钥" }));
      const textbox = await screen.findByRole("textbox", { name: "密钥内容" });
      const dialog = screen.getByRole("dialog");
      const header = dialog.querySelector<HTMLElement>(
        "[data-slot=dialog-header]",
      )!;
      const footer = dialog.querySelector<HTMLElement>(
        "[data-slot=dialog-footer]",
      )!;
      const body = header.nextElementSibling;
      expect(dialog).toHaveClass(
        "flex",
        "flex-col",
        "max-h-[calc(100dvh-2rem)]",
      );
      expect(header).toHaveClass("shrink-0", "pr-8");
      expect(footer).toHaveClass("shrink-0");
      expect(body).toHaveClass("min-h-0", "overflow-y-auto");
      expect(body).toContainElement(textbox);
      expect(body).not.toContainElement(header);
      expect(body).not.toContainElement(footer);
      expect(textbox).toHaveValue(longValue);
      expect(dialog).toHaveAccessibleDescription(
        "60 秒后或切换标签页时自动清除。",
      );
      await user.click(
        within(footer).getByRole("button", {
          name: kind === "reveal" ? "关闭" : "完成",
        }),
      );
      expect(onClose).toHaveBeenCalledOnce();
    },
  );
});

it("bounds the session confirmation without changing its cancel behavior", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <SecuritySettings settings={settings} onSaved={vi.fn()} />
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
    "overflow-y-auto",
  );
  await user.click(within(dialog).getByRole("button", { name: "取消" }));
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  expect(fetchMock).not.toHaveBeenCalled();
});
