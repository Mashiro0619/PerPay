import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { json } from "./fixtures";
import { mountOnboarding } from "./onboarding-fixture";

const savedKey = "synthetic-saved-alipay-public-key";
const providerPath = "/settings/onboarding/provider";

describe("saved Alipay public key editing", () => {
  it.each([providerPath, "/settings/provider"])(
    "fills the saved public key without revealing secrets or creating a draft at %s",
    async (path) => {
      const view = mountOnboarding({ stage: 4, path });
      const input = await screen.findByLabelText("支付宝公钥");
      expect(input).toHaveValue(savedKey);
      expect(input).toBeRequired();
      expect(screen.queryByText(/留空不变/)).not.toBeInTheDocument();
      expect(view.writes()).toHaveLength(0);
      if (path === "/settings/provider")
        expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
      await userEvent
        .setup()
        .click(screen.getByRole("button", { name: "刷新" }));
      await waitFor(() =>
        expect(screen.getByLabelText("支付宝公钥")).toHaveValue(savedKey),
      );
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      expect(view.writes()).toHaveLength(0);
    },
  );

  it("explicitly submits the visible saved key when continuing without edits", async () => {
    const view = mountOnboarding({ stage: 4, path: providerPath });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "保存并继续" }));
    await screen.findByRole("heading", { name: "经营码", level: 2 });
    const body = await view.writes()[0]!.clone().json();
    expect(body.platform_public_key).toBe(savedKey);
    expect(body).not.toHaveProperty("private_key");
    expect(view.writes()).toHaveLength(1);
  });

  it.each(["", "  \n  "])(
    "rejects cleared or whitespace-only keys instead of silently retaining the old key",
    async (value) => {
      const view = mountOnboarding({ stage: 4, path: providerPath });
      const input = await screen.findByLabelText("支付宝公钥");
      fireEvent.change(input, { target: { value } });
      fireEvent.submit(input.closest("form")!);
      await screen.findByText("请填写支付宝公钥。");
      await waitFor(() => expect(input).toHaveFocus());
      expect(input).toHaveAttribute("aria-invalid", "true");
      expect(view.writes()).toHaveLength(0);
      expect(view.saved.provider!.platform_public_key).toBe(savedKey);
    },
  );

  it("saves an edited key and displays it after leaving and returning", async () => {
    const view = mountOnboarding({ stage: 4, path: providerPath });
    const user = userEvent.setup();
    fireEvent.change(await screen.findByLabelText("支付宝公钥"), {
      target: { value: "  replacement-platform-key  " },
    });
    await user.click(screen.getByRole("button", { name: "保存并继续" }));
    await screen.findByRole("heading", { name: "经营码", level: 2 });
    await user.click(screen.getByRole("link", { name: /支付宝接入/ }));
    expect(await screen.findByLabelText("支付宝公钥")).toHaveValue(
      "replacement-platform-key",
    );
    expect(view.saved.provider!.platform_public_key).toBe(
      "replacement-platform-key",
    );
    expect(view.writes()).toHaveLength(1);
  });

  it("keeps the edited key on validation failure and supports correcting and retrying it", async () => {
    let reject = true;
    const view = mountOnboarding({
      stage: 4,
      path: providerPath,
      handle: (request) => {
        if (
          reject &&
          request.method === "PUT" &&
          request.url.endsWith("/settings/provider")
        )
          return json(
            {
              error: {
                code: "settings_validation_failed",
                message: "请求字段校验失败",
                fields: { platform_public_key: "请核对完整公钥。" },
              },
            },
            422,
          );
        return undefined;
      },
    });
    const user = userEvent.setup();
    const input = await screen.findByLabelText("支付宝公钥");
    fireEvent.change(input, { target: { value: "invalid-key" } });
    await user.click(screen.getByRole("button", { name: "保存并继续" }));
    await screen.findByText("请核对完整公钥。");
    expect(input).toHaveValue("invalid-key");
    reject = false;
    fireEvent.change(input, { target: { value: "corrected-key" } });
    await user.click(screen.getByRole("button", { name: "保存并继续" }));
    await screen.findByRole("heading", { name: "经营码", level: 2 });
    expect(view.saved.provider!.platform_public_key).toBe("corrected-key");
    expect(view.writes()).toHaveLength(2);
  });

  it("keeps first setup empty and required", async () => {
    const view = mountOnboarding({ stage: 1, path: providerPath });
    const input = await screen.findByLabelText("支付宝公钥");
    expect(input).toHaveValue("");
    expect(input).toBeRequired();
    expect(view.writes()).toHaveLength(0);
  });

  it("does not reuse the saved public key when activating a pending replacement", async () => {
    const view = mountOnboarding({ pendingKey: true, path: providerPath });
    const input = await screen.findByLabelText("支付宝公钥");
    expect(view.saved.provider!.platform_public_key).toBe(savedKey);
    expect(input).toHaveValue("");
    expect(input).toBeRequired();
    expect(view.writes()).toHaveLength(0);
  });
});
