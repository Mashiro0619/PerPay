import { QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { queryClient } from "../src/api/client";
import { SecuritySettings } from "../src/pages/SecuritySettings";
import { recordAction } from "./menu-helper";
import { json, settings } from "./fixtures";

const syntheticSecret = "synthetic-test-key-never-real";

describe("secret visibility lifecycle", () => {
  it.each(["api", "webhook"])(
    "bounds a hung %s key rotation, permits closing and ignores late plaintext",
    async (kind) => {
  // This suite tests other security controls; keep the read-only IP lookup cached.
  queryClient.setQueryData(["admin-access-source"], {data:{revision:settings.revision,...settings.admin_access,current_ip:"192.0.2.1"}});

      let finish!: (response: Response) => void;
      let request: Request | undefined;
      const fetchMock = vi.fn((input: Request) => {
        request = input;
        // A stalled transport may not honor abort; timeout still has to settle.
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      });
      vi.stubGlobal("fetch", fetchMock);
      const configured = {
        ...settings,
        completion: { ...settings.completion, api: true },
        secrets: {
          ...settings.secrets,
          api_secret: { ...settings.secrets.api_secret, configured: true },
          webhook_secret: {
            ...settings.secrets.webhook_secret,
            configured: true,
          },
        },
      };
      const onSaved = vi.fn();
      render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <SecuritySettings settings={configured} onSaved={onSaved} />
          </MemoryRouter>
        </QueryClientProvider>,
      );
      const user = userEvent.setup();
      const title = kind === "api" ? "轮换 API 密钥" : "轮换通知签名密钥";
      const origin = kind === "api" ? "API 密钥操作" : "通知密钥操作";
      await user.click(await recordAction(title, origin));
      vi.useFakeTimers();
      fireEvent.click(screen.getByRole("button", { name: "确认轮换" }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(request!.url).toContain(
        kind === "api"
          ? "/api-key/actions/rotate"
          : "/notification-key/actions/rotate",
      );
      expect(await request!.clone().json()).toEqual({
        revision: configured.revision,
      });
      expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000);
      });
      expect(
        screen.getByText("等待操作结果超时。停止等待不代表服务端已取消操作。"),
      ).toBeVisible();
      expect(
        screen.getByText(
          "结果未确认，请关闭后刷新配置并查看当前密钥。本次不再重试。",
        ),
      ).toBeVisible();
      expect(request!.signal.aborted).toBe(true);
      expect(screen.getByRole("button", { name: "确认轮换" })).toBeDisabled();
      expect(
        screen
          .getAllByRole("button", { name: "关闭" })
          .every((button) => !button.hasAttribute("disabled")),
      ).toBe(true);
      await act(async () => {
        finish(
          json({
            data: {
              secret: syntheticSecret,
              settings: { ...configured, revision: configured.revision + 1 },
            },
          }),
        );
        await vi.advanceTimersByTimeAsync(120_000);
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(onSaved).not.toHaveBeenCalled();
      expect(screen.queryByText(syntheticSecret)).not.toBeInTheDocument();
      vi.useRealTimers();
      await user.keyboard("{Escape}");
      await waitFor(() =>
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
      );
      await waitFor(() =>
        expect(screen.getByRole("button", { name: origin })).toHaveFocus(),
      );
    },
  );

  it.each(["read", "rotate"])(
    "closes the %s dialog when hidden before its response and never displays late plaintext",
    async (operation) => {
      const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
      let finish: (response: Response) => void = () => {};
      vi.stubGlobal(
        "fetch",
        vi.fn(
          () =>
            new Promise<Response>((resolve) => {
              finish = resolve;
            }),
        ),
      );
      const configured = {
        ...settings,
        completion: { ...settings.completion, api: true },
        secrets: {
          ...settings.secrets,
          api_secret: { ...settings.secrets.api_secret, configured: true },
        },
      };
      const onSaved = vi.fn();
      render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <SecuritySettings settings={configured} onSaved={onSaved} />
          </MemoryRouter>
        </QueryClientProvider>,
      );
      const user = userEvent.setup();
      if (operation === "read") {
        await user.click(
          screen.getByRole("button", { name: "查看PerPay API 密钥" }),
        );
      } else {
        await user.click(await recordAction("轮换 API 密钥", "API 密钥操作"));
        expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "确认轮换" }));
      }
      hidden.mockReturnValue(true);
      fireEvent(document, new Event("visibilitychange"));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      await act(async () => {
        finish(
          json({
            data:
              operation === "read"
                ? { value: syntheticSecret }
                : {
                    secret: syntheticSecret,
                    settings: { ...settings, revision: 4 },
                  },
          }),
        );
      });
      expect(screen.queryByText(syntheticSecret)).not.toBeInTheDocument();
      hidden.mockReturnValue(false);
      fireEvent(document, new Event("visibilitychange"));
      expect(screen.queryByText(syntheticSecret)).not.toBeInTheDocument();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      if (operation === "rotate") expect(onSaved).toHaveBeenCalledOnce();
    },
  );
});

it("still clears a displayed multiline key after sixty seconds", async () => {
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  const value =
    "-----BEGIN PRIVATE KEY-----\nsynthetic-private-key\n-----END PRIVATE KEY-----";
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json({ data: { value } })),
  );
  const configured = {
    ...settings,
    secrets: {
      ...settings.secrets,
      provider_private_key: {
        ...settings.secrets.provider_private_key,
        configured: true,
      },
    },
  };
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <SecuritySettings settings={configured} onSaved={vi.fn()} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  vi.useFakeTimers();
  fireEvent.click(screen.getByRole("button", { name: "查看应用私钥" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
  expect(screen.getByRole("textbox", { name: "密钥内容" })).toBeVisible();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(59_000);
  });
  expect(screen.getByRole("dialog", { name: "应用私钥" })).toBeVisible();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_010);
  });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.queryByText(/synthetic-private-key/)).not.toBeInTheDocument();
});
