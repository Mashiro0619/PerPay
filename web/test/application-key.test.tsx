import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { queryClient } from "../src/api/client";
import {
  applicationKeyState,
  canRegenerateApplicationKey,
} from "../src/lib/application-key";
import {
  clearOnboardingDeferrals,
  onboardingPath,
} from "../src/lib/onboarding";
import { apiError, json } from "./fixtures";
import { configuredThrough, mountOnboarding } from "./onboarding-fixture";

beforeEach(() => clearOnboardingDeferrals());
const configuredDescription =
  "应用公钥已就绪。复制到支付宝的接口加签设置，已配置则直接下一步。";
const applicationPath = onboardingPath("application");
const body = async (view: ReturnType<typeof mountOnboarding>, index = 0) =>
  view.writes()[index]!.clone().json();

describe("application public key generation and replacement", () => {
  it("explains the key pair and only generates on an explicit first-use click", async () => {
    const view = mountOnboarding();
    const user = userEvent.setup();
    expect(
      await screen.findByRole("heading", { name: "应用公钥", level: 2 }),
    ).toBeVisible();
    expect(
      screen.getByText("应用公钥和应用私钥是一对，合称“应用密钥对”。"),
    ).toBeVisible();
    expect(
      screen.getByRole("link", { name: "导入已有应用私钥" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "下一步" })).toBeDisabled();
    expect(view.writes()).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "生成应用公钥" }));
    expect(await screen.findByText(configuredDescription)).toBeVisible();
    expect(screen.getByText("synthetic-application-public-key")).toBeVisible();
    expect(screen.getByRole("button", { name: "下一步" })).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "重新生成应用公钥" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("link", { name: /导入/ }),
    ).not.toBeInTheDocument();
    expect(view.writes()).toHaveLength(1);
    expect(await body(view)).toEqual({ revision: 3 });
  });

  it.each([1, 2, 4])(
    "does not regenerate stage %i on copy, refresh or returning",
    async (stage) => {
      const user = userEvent.setup();
      const clipboard = vi.spyOn(navigator.clipboard, "writeText");
      const view = mountOnboarding({ stage, path: applicationPath });
      await screen.findByText(configuredDescription);
      await user.click(screen.getByRole("button", { name: "复制应用公钥" }));
      await waitFor(() =>
        expect(clipboard).toHaveBeenCalledWith(
          "synthetic-application-public-key",
        ),
      );
      await user.click(screen.getByRole("button", { name: "刷新" }));
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "刷新" })).toBeEnabled(),
      );
      await user.click(screen.getByRole("button", { name: "下一步" }));
      await screen.findByLabelText("应用 ID（App ID）");
      await user.click(screen.getByRole("tab", { name: /应用公钥/ }));
      expect(
        await screen.findByRole("button", { name: "重新生成应用公钥" }),
      ).toBeVisible();
      expect(view.writes()).toHaveLength(0);
    },
  );

  it("allows cancelling regeneration and restores trigger focus", async () => {
    const view = mountOnboarding({ stage: 4, path: applicationPath });
    const user = userEvent.setup();
    const trigger = await screen.findByRole("button", {
      name: "重新生成应用公钥",
    });
    await user.click(trigger);
    const dialog = await screen.findByRole("dialog", {
      name: "重新生成应用公钥？",
    });
    expect(within(dialog).getByText(/当前收款继续使用原密钥/)).toBeVisible();
    expect(view.writes()).toHaveLength(0);
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(view.writes()).toHaveLength(0);
  });

  it("warns about replacing an initial pair and generates only once after confirmation", async () => {
    const view = mountOnboarding({ stage: 1, path: applicationPath });
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "重新生成应用公钥" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "重新生成应用公钥？",
    });
    expect(within(dialog).getByText(/替换尚未接入的原密钥对/)).toBeVisible();
    await user.click(
      within(dialog).getByRole("button", { name: "生成新公钥" }),
    );
    expect(
      await screen.findByText("synthetic-regenerated-application-public-key"),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "验证并启用" }),
    ).not.toBeInTheDocument();
    expect(view.writes()).toHaveLength(1);
    expect(await body(view)).toMatchObject({
      revision: 3,
      base_fingerprint: "a".repeat(64),
      change_id: expect.any(String),
    });
    expect(new URL(view.writes()[0]!.url).pathname).toMatch(
      /actions[/]regenerate$/,
    );
  });

  it("prepares an active replacement without enabling it and retains it on refresh", async () => {
    const user = userEvent.setup();
    const clipboard = vi.spyOn(navigator.clipboard, "writeText");
    const view = mountOnboarding({ stage: 4, path: applicationPath });
    await user.click(
      await screen.findByRole("button", { name: "重新生成应用公钥" }),
    );
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "生成新公钥",
      }),
    );
    const primary = await screen.findByRole("link", {
      name: "打开支付宝应用管理",
    });
    expect(
      screen.queryByRole("button", { name: "验证并启用" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("synthetic-pending-application-public-key"),
    ).toBeVisible();
    expect(screen.getByText(/当前仍使用原密钥/)).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "重新生成应用公钥" }),
    ).not.toBeInTheDocument();
    await waitFor(() => expect(primary).toHaveFocus());
    await user.click(
      screen.getByRole("button", { name: "复制待启用应用公钥" }),
    );
    await waitFor(() =>
      expect(clipboard).toHaveBeenCalledWith(
        "synthetic-pending-application-public-key",
      ),
    );
    await user.click(
      screen.getByRole("button", { name: "查看当前使用的应用公钥" }),
    );
    expect(
      await screen.findByText("synthetic-application-public-key"),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "刷新" })).toBeEnabled(),
    );
    expect(
      screen.getByText("synthetic-pending-application-public-key"),
    ).toBeVisible();
    expect(view.writes()).toHaveLength(1);
  });

  it("requires the newly retrieved Alipay public key without a redundant upload checkbox", async () => {
    const view = mountOnboarding({
      pendingKey: true,
      path: "/settings/provider",
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "验证并启用" }));
    const dialog = await screen.findByRole("dialog", {
      name: "验证并启用新应用公钥",
    });
    const submit = within(dialog).getByRole("button", { name: "验证并启用" });
    expect(submit).toBeEnabled();
    expect(within(dialog).getByLabelText("支付宝公钥")).toBeRequired();
    expect(within(dialog).getByLabelText("支付宝公钥")).toHaveValue("");
    expect(within(dialog).queryByRole("checkbox")).not.toBeInTheDocument();
    expect(within(dialog).getByText(/只读账单查询/)).toBeVisible();
    await user.type(
      within(dialog).getByLabelText("支付宝公钥"),
      " updated-alipay-public-key ",
    );
    await user.click(submit);
    expect(await screen.findByText("应用公钥已验证并启用。")).toBeVisible();
    expect(await body(view)).toEqual({
      revision: 3,
      change_id: "00000000-0000-4000-8000-000000000001",
      platform_public_key: "updated-alipay-public-key",
    });
    expect(new URL(view.writes()[0]!.url).pathname).toMatch(
      /actions[/]activate$/,
    );
    expect(
      screen.queryByRole("button", { name: "验证并启用" }),
    ).not.toBeInTheDocument();
    expect(queryClient.getQueryData(["settings"])).toMatchObject({
      data: {
        application_public_key: "synthetic-pending-application-public-key",
        pending_application_key: null,
      },
    });
    const cached = JSON.stringify(queryClient.getQueryData(["settings"]));
    expect(cached).not.toContain("updated-alipay-public-key");
    expect(JSON.stringify(localStorage)).not.toContain(
      "updated-alipay-public-key",
    );
    expect(JSON.stringify(sessionStorage)).not.toContain(
      "updated-alipay-public-key",
    );
  });

  it.each([onboardingPath("provider"), "/settings/provider"])(
    "rejects empty and whitespace-only activation keys with an accessible inline error at %s",
    async (path) => {
      const view = mountOnboarding({ pendingKey: true, path });
      const user = userEvent.setup();
      const guided = path === onboardingPath("provider");
      if (!guided)
        await user.click(
          await screen.findByRole("button", { name: "验证并启用" }),
        );
      const dialog = await screen.findByRole(guided ? "form" : "dialog", {
        name: "验证并启用新应用公钥",
      });
      const input = within(dialog).getByLabelText("支付宝公钥");
      const submit = within(dialog).getByRole("button", {
        name: guided ? "验证并启用后继续" : "验证并启用",
      });
      expect(input).toBeRequired();
      expect(input).toHaveValue("");
      expect(within(dialog).queryByRole("checkbox")).not.toBeInTheDocument();
      for (const value of ["", " \n\t "]) {
        fireEvent.change(input, { target: { value } });
        await user.click(submit);
        expect(
          await within(dialog).findByText(
            "请先上传新应用公钥，再填写上传后获取的支付宝公钥。",
          ),
        ).toBeVisible();
        expect(input).toHaveFocus();
        expect(input).toHaveAttribute("aria-invalid", "true");
        expect(input).toHaveAttribute(
          "aria-describedby",
          "activation-platform-hint activation-platform-error",
        );
        expect(view.writes()).toHaveLength(0);
      }
      fireEvent.change(input, {
        target: { value: " latest-platform-public-key " },
      });
      expect(input).toHaveAttribute("aria-invalid", "false");
      await user.click(submit);
      await screen.findByText("应用公钥已验证并启用。");
      expect(view.writes()).toHaveLength(1);
      expect(await body(view)).toHaveProperty(
        "platform_public_key",
        "latest-platform-public-key",
      );
    },
  );

  it("keeps pending state on a known verification failure and allows correcting the public key", async () => {
    let attempts = 0;
    const view = mountOnboarding({
      pendingKey: true,
      path: "/settings/provider",
      handle: (request) =>
        request.url.endsWith("/actions/activate") && ++attempts === 1
          ? apiError(
              "provider_application_key_verification_failed",
              "verification failed",
              422,
            )
          : undefined,
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "验证并启用" }));
    const dialog = await screen.findByRole("dialog");
    const input = within(dialog).getByLabelText("支付宝公钥");
    await user.type(input, "incorrect-platform-key");
    await user.click(
      within(dialog).getByRole("button", { name: "验证并启用" }),
    );
    expect(await within(dialog).findByText(/支付宝验证未通过/)).toBeVisible();
    expect(input).toBeEnabled();
    await user.clear(input);
    await user.type(input, "corrected-platform-key");
    await user.click(
      within(dialog).getByRole("button", { name: "验证并启用" }),
    );
    expect(await screen.findByText("应用公钥已验证并启用。")).toBeVisible();
    expect(view.writes()).toHaveLength(2);
    expect(await body(view, 0)).toHaveProperty(
      "platform_public_key",
      "incorrect-platform-key",
    );
    expect(await body(view, 1)).toHaveProperty(
      "platform_public_key",
      "corrected-platform-key",
    );
  });

  it("focuses invalid Alipay public-key input without locking corrections", async () => {
    const view = mountOnboarding({
      pendingKey: true,
      path: "/settings/provider",
      handle: (request) =>
        request.url.endsWith("/actions/activate")
          ? json(
              {
                error: {
                  code: "settings_validation_failed",
                  message: "配置未通过校验",
                  fields: { platform_public_key: "请使用支付宝公钥" },
                },
              },
              422,
            )
          : undefined,
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "验证并启用" }));
    const dialog = await screen.findByRole("dialog");
    const input = within(dialog).getByLabelText("支付宝公钥");
    await user.type(input, "synthetic-application-public-key");
    await user.click(
      within(dialog).getByRole("button", { name: "验证并启用" }),
    );
    await within(dialog).findByText("请使用支付宝公钥");
    await waitFor(() => expect(input).toHaveFocus());
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toBeEnabled();
    expect(view.writes()).toHaveLength(1);
  });

  it("uses the same regeneration operation after an uncertain network error", async () => {
    let attempts = 0;
    const view = mountOnboarding({
      stage: 4,
      path: applicationPath,
      handle: (request) =>
        request.url.endsWith("/actions/regenerate") && ++attempts === 1
          ? Promise.reject(new Error("synthetic network failure"))
          : undefined,
    });
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "重新生成应用公钥" }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.click(
      within(dialog).getByRole("button", { name: "生成新公钥" }),
    );
    await user.click(
      await within(dialog).findByRole("button", { name: "重试同一操作" }),
    );
    expect(
      await screen.findByText("synthetic-pending-application-public-key"),
    ).toBeVisible();
    expect(view.writes()).toHaveLength(2);
    expect(await body(view, 0)).toEqual(await body(view, 1));
  });

  it("freezes an unresolved activation request and resends exactly the same input", async () => {
    let attempts = 0;
    const view = mountOnboarding({
      pendingKey: true,
      path: "/settings/provider",
      handle: (request) =>
        request.url.endsWith("/actions/activate") && ++attempts === 1
          ? Promise.reject(new Error("synthetic lost response"))
          : undefined,
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "验证并启用" }));
    const dialog = await screen.findByRole("dialog");
    const input = within(dialog).getByLabelText("支付宝公钥");
    await user.type(input, "fixed-platform-key");
    await user.click(
      within(dialog).getByRole("button", { name: "验证并启用" }),
    );
    const retry = await within(dialog).findByRole("button", {
      name: "重试同一操作",
    });
    expect(input).toBeDisabled();
    await user.click(retry);
    await screen.findByText("应用公钥已验证并启用。");
    expect(await body(view, 0)).toEqual(await body(view, 1));
  });

  it("blocks duplicate generation clicks and dismissing the pending request", async () => {
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const view = mountOnboarding({
      stage: 4,
      path: applicationPath,
      handle: (request) =>
        request.url.endsWith("/actions/regenerate") ? pending : undefined,
    });
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "重新生成应用公钥" }),
    );
    const dialog = await screen.findByRole("dialog");
    const submit = within(dialog).getByRole("button", { name: "生成新公钥" });
    await user.click(submit);
    fireEvent.click(submit);
    expect(submit).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "取消" })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(dialog).toBeVisible();
    expect(view.writes()).toHaveLength(1);
    await act(async () => {
      finish(apiError("internal_error", "test failure", 503));
    });
    expect(
      await within(dialog).findByRole("button", { name: "重试同一操作" }),
    ).toBeEnabled();
  });

  it("does not silently retry a conflicting configuration revision", async () => {
    const view = mountOnboarding({
      stage: 4,
      path: applicationPath,
      handle: (request) =>
        request.url.endsWith("/actions/regenerate")
          ? apiError("settings_revision_conflict", "stale revision")
          : undefined,
    });
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "重新生成应用公钥" }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.click(
      within(dialog).getByRole("button", { name: "生成新公钥" }),
    );
    expect(await within(dialog).findByText(/关闭弹窗后刷新/)).toBeVisible();
    expect(
      within(dialog).getByRole("button", { name: "生成新公钥" }),
    ).toBeDisabled();
    expect(view.writes()).toHaveLength(1);
  });

  it("requires acknowledgement before discarding and keeps the current public key", async () => {
    const view = mountOnboarding({ pendingKey: true, path: applicationPath });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "放弃新公钥" }));
    const dialog = await screen.findByRole("dialog", { name: "放弃新公钥？" });
    expect(within(dialog).getByText(/不会撤回支付宝侧的上传/)).toBeVisible();
    const submit = within(dialog).getByRole("button", { name: "确认放弃" });
    expect(submit).toBeDisabled();
    await user.click(within(dialog).getByRole("checkbox"));
    await user.click(submit);
    expect(
      await screen.findByText("已放弃待启用公钥，当前密钥未更换。"),
    ).toBeVisible();
    expect(screen.getByText("synthetic-application-public-key")).toBeVisible();
    expect(
      screen.queryByText("synthetic-pending-application-public-key"),
    ).not.toBeInTheDocument();
    expect(new URL(view.writes()[0]!.url).pathname).toMatch(
      /actions[/]discard$/,
    );
  });

  it("keeps provider drafts when the discard prompt before regeneration is cancelled", async () => {
    const view = mountOnboarding({ stage: 4, path: "/settings/provider" });
    const input = await screen.findByLabelText("应用 ID（App ID）");
    fireEvent.change(input, { target: { value: "unsaved-provider" } });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "重新生成应用公钥" }));
    await user.click(await screen.findByRole("button", { name: "继续编辑" }));
    expect(input).toHaveValue("unsaved-provider");
    expect(
      screen.queryByRole("dialog", { name: "重新生成应用公钥？" }),
    ).not.toBeInTheDocument();
    expect(view.writes()).toHaveLength(0);
  });

  it("keeps existing-key import as an initial alternative rather than a rotation bypass", async () => {
    const view = mountOnboarding();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("link", { name: "导入已有应用私钥" }),
    );
    await user.click(
      await screen.findByRole("button", { name: "导入已有应用私钥（可选）" }),
    );
    expect(screen.getByLabelText("应用私钥")).toBeVisible();
    expect(screen.getByText(/首次接入可导入已有应用私钥/)).toBeVisible();
    expect(view.writes()).toHaveLength(0);
  });

  it("does not mistake missing public-key text or incomplete historical state for a new instance", () => {
    expect(applicationKeyState(configuredThrough(0))).toBe("missing");
    expect(canRegenerateApplicationKey(configuredThrough(1))).toBe(true);
    expect(canRegenerateApplicationKey(configuredThrough(4))).toBe(true);
    const existing = configuredThrough(1);
    existing.application_public_key = null;
    expect(applicationKeyState(existing)).toBe("unavailable");
    expect(canRegenerateApplicationKey(existing)).toBe(false);
    existing.application_public_key = "existing-public-key";
    existing.provider_generations = [
      {
        provider_account_key: "historical",
        app_id: "old-app",
        environment: "PRODUCTION",
        activated_at: "2026-09-01T00:00:00Z",
        active: false,
      },
    ];
    expect(canRegenerateApplicationKey(existing)).toBe(false);
  });
});
