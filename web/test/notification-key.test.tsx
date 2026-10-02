import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queryClient } from "../src/api/client";
import { SECRET_DISPLAY_NOTICE } from "../src/pages/SecuritySettings";
import { mountOnboarding } from "./onboarding-fixture";

const newSecret = "synthetic-rotated-notification-secret";
async function openRotation(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "通知密钥操作" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "轮换通知签名密钥" }),
  );
  return screen.findByRole("dialog", { name: "轮换通知签名密钥？" });
}
afterEach(() => vi.useRealTimers());
describe("notification signing key rotation", () => {
  it("matches the security table action style while keeping an explicit accessible name", async () => {
    const view = mountOnboarding({
      stage: 4,
      notificationKey: true,
      path: "/settings/security",
    });
    const user = userEvent.setup();
    const notification = await screen.findByRole("button", {
      name: "查看通知签名密钥",
    });
    const api = screen.getByRole("button", { name: "查看PerPay API 密钥" });
    expect(notification.textContent).toBe("查看");
    expect(notification.className).toBe(api.className);
    expect(
      notification.querySelector("svg[data-icon=inline-start]"),
    ).toHaveClass("lucide-eye");
    expect(screen.getByRole("button", { name: "通知密钥操作" }).className).toBe(
      screen.getByRole("button", { name: "API 密钥操作" }).className,
    );
    expect(view.writes()).toHaveLength(0);
    await user.click(notification);
    const dialog = await screen.findByRole("dialog", { name: "通知签名密钥" });
    await within(dialog).findByText(
      "synthetic-onboarding-key-not-a-real-secret",
    );
    expect(view.writes()).toHaveLength(1);
    await user.click(within(dialog).getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(notification).toHaveFocus());
  });

  it.each(["/settings/onboarding/optional", "/settings/notifications"])(
    "retains the normal outlined action in the form at %s",
    async (path) => {
      const view = mountOnboarding({ stage: 4, notificationKey: true, path });
      const button = await screen.findByRole("button", {
        name: "查看签名密钥",
      });
      expect(button).toHaveClass("border-border", "h-8");
      expect(button.querySelector("svg")).toBeNull();
      expect(screen.getByRole("button", { name: "通知密钥操作" })).toHaveClass(
        "size-8",
      );
      expect(view.writes()).toHaveLength(0);
    },
  );
  it.each([
    "/settings/onboarding/optional",
    "/settings/notifications",
    "/settings/security",
  ])(
    "confirms explicitly, preserves focus and does not write on cancel at %s",
    async (path) => {
      const view = mountOnboarding({ stage: 4, notificationKey: true, path });
      const user = userEvent.setup();
      const dialog = await openRotation(user);
      expect(within(dialog).getByText(/新发送和重试的通知/)).toBeVisible();
      expect(view.writes()).toHaveLength(0);
      await user.click(within(dialog).getByRole("button", { name: "取消" }));
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "通知密钥操作" }),
        ).toHaveFocus(),
      );
      expect(view.writes()).toHaveLength(0);
    },
  );
  it.each(["/settings/onboarding/optional", "/settings/notifications"])(
    "rotates only the signing key and retains unsaved form input at %s",
    async (path) => {
      const view = mountOnboarding({ stage: 4, notificationKey: true, path });
      const user = userEvent.setup();
      const input = await screen.findByLabelText("通知超时（秒）");
      fireEvent.change(input, { target: { value: "9" } });
      const before = structuredClone(view.saved);
      const dialog = await openRotation(user);
      await user.click(
        within(dialog).getByRole("button", { name: "确认轮换" }),
      );
      const result = await screen.findByRole("dialog", {
        name: "新的通知签名密钥",
      });
      expect(within(result).getByText(newSecret)).toBeVisible();
      expect(within(result).getByText(SECRET_DISPLAY_NOTICE)).toBeVisible();
      expect(view.writes()).toHaveLength(1);
      expect(await view.writes()[0]!.clone().json()).toEqual({
        revision: before.revision,
      });
      expect(view.saved.notifications).toEqual(before.notifications);
      expect(view.saved.payment_revision).toBe(before.payment_revision);
      expect(
        JSON.stringify(queryClient.getQueryData(["settings"])),
      ).not.toContain(newSecret);
      expect(JSON.stringify(localStorage)).not.toContain(newSecret);
      expect(JSON.stringify(sessionStorage)).not.toContain(newSecret);
      await user.click(within(result).getByRole("button", { name: "完成" }));
      expect(screen.getByLabelText("通知超时（秒）")).toHaveValue(9);
      await user.click(
        screen.getByRole("button", {
          name: path.includes("onboarding") ? "保存通知" : "保存",
        }),
      );
      await waitFor(() => expect(view.writes()).toHaveLength(2));
      expect(await view.writes()[1]!.clone().json()).toMatchObject({
        revision: before.revision + 1,
        timeout_milliseconds: 9000,
      });
    },
  );
  it("does not retry an uncertain rotation and explains how to recover", async () => {
    const view = mountOnboarding({
      stage: 4,
      notificationKey: true,
      path: "/settings/security",
      handle: (request) =>
        request.url.endsWith("/notification-key/actions/rotate")
          ? Promise.reject(new Error("lost response"))
          : undefined,
    });
    const user = userEvent.setup();
    const dialog = await openRotation(user);
    await user.click(within(dialog).getByRole("button", { name: "确认轮换" }));
    await screen.findByText(
      "结果未确认，请关闭后刷新配置并查看当前密钥。本次不再重试。",
    );
    expect(screen.getByRole("button", { name: "确认轮换" })).toBeDisabled();
    expect(view.writes()).toHaveLength(1);
  });
  it("never offers rotation before a notification key has been generated", async () => {
    const view = mountOnboarding({
      stage: 4,
      path: "/settings/onboarding/optional",
    });
    await screen.findByRole("heading", { name: "通知与备份", level: 2 });
    expect(
      screen.queryByRole("button", { name: "通知密钥操作" }),
    ).not.toBeInTheDocument();
    expect(view.writes()).toHaveLength(0);
  });
  it.each(["timeout", "hidden"])(
    "clears only displayed plaintext on %s, without deleting the stored key",
    async (reason) => {
      const timer = vi.spyOn(window, "setTimeout");
      const view = mountOnboarding({
        stage: 4,
        notificationKey: true,
        path: "/settings/onboarding/optional",
      });
      const user = userEvent.setup();
      await user.click(
        await screen.findByRole("button", { name: "查看签名密钥" }),
      );
      const dialog = await screen.findByRole("dialog", {
        name: "通知签名密钥",
      });
      await within(dialog).findByText(
        "synthetic-onboarding-key-not-a-real-secret",
      );
      expect(within(dialog).getByText(SECRET_DISPLAY_NOTICE)).toBeVisible();
      const before = structuredClone(view.saved);
      const writes = view.writes().length;
      if (reason === "timeout") {
        const expire = timer.mock.calls.find(
          ([, delay]) => delay === 60000,
        )?.[0];
        expect(typeof expire).toBe("function");
        act(() => (expire as () => void)());
      } else {
        const hidden = vi
          .spyOn(document, "hidden", "get")
          .mockReturnValue(true);
        fireEvent(document, new Event("visibilitychange"));
        hidden.mockRestore();
      }
      timer.mockRestore();
      await waitFor(() =>
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
      );
      expect(view.saved).toEqual(before);
      expect(view.writes()).toHaveLength(writes);
    },
  );
});
