import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { queryClient } from "../src/api/client";
import {
  clearOnboardingDeferrals,
  nextRequiredStep,
  onboardingPath,
  resolveOnboardingStep,
  onboardingSteps,
} from "../src/lib/onboarding";
import { apiError, json } from "./fixtures";
import {
  configuredThrough,
  mountOnboarding,
  pendingApplicationKey,
} from "./onboarding-fixture";

beforeEach(() => clearOnboardingDeferrals());
const applicationPath = onboardingPath("application");
const providerPath = onboardingPath("provider");
const collectionPath = onboardingPath("collection");
const actionLabel = "验证并启用后继续";
const body = (view: ReturnType<typeof mountOnboarding>, index = 0) =>
  view.writes()[index]!.clone().json();
const activationForm = () =>
  screen.findByRole("form", { name: "验证并启用新应用公钥" });
function unloadBlocked() {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}
async function fillAndSubmit(
  user: ReturnType<typeof userEvent.setup>,
  key = "latest-alipay-key",
) {
  const form = await activationForm();
  const input = within(form).getByLabelText("支付宝公钥");
  await user.type(input, key);
  await user.click(within(form).getByRole("button", { name: actionLabel }));
  return { form, input };
}
function activatedSettings() {
  const value = pendingApplicationKey();
  value.revision++;
  value.payment_revision++;
  value.application_public_key = value.pending_application_key!.public_key;
  value.application_key_fingerprint =
    value.pending_application_key!.fingerprint;
  value.pending_application_key = null;
  return value;
}

describe("sequential application-key onboarding", () => {
  it("has one forward activation path and never renders the ordinary provider save form while a key is pending", async () => {
    const view = mountOnboarding({ pendingKey: true, path: applicationPath });
    const user = userEvent.setup();
    await screen.findByRole("button", { name: "复制待启用应用公钥" });
    expect(
      screen.queryByRole("button", { name: "验证并启用" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText("支付宝公钥")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "下一步" }));
    const form = await activationForm();
    expect(view.router.state.location.pathname).toBe(providerPath);
    expect(screen.getAllByLabelText("支付宝公钥")).toHaveLength(1);
    expect(within(form).getByLabelText("应用 ID（App ID）")).toHaveAttribute(
      "readonly",
    );
    expect(within(form).getByLabelText("应用 ID（App ID）")).toHaveValue(
      "test-app-id",
    );
    expect(within(form).getByLabelText("支付宝环境")).toHaveAttribute(
      "readonly",
    );
    expect(screen.queryByLabelText("请求超时（毫秒）")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "保存并继续" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "返回验证并启用" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/已配置，留空不变|本页保存不会启用新密钥/),
    ).not.toBeInTheDocument();
    const submit = within(form).getByRole("button", {
      name: actionLabel,
    }) as HTMLButtonElement;
    expect(submit.form).toBe(form);
    expect(view.writes()).toHaveLength(0);
    await fillAndSubmit(user, " latest-alipay-key ");
    await screen.findByLabelText("支付宝经营码内容");
    expect(view.router.state.location.pathname).toBe(collectionPath);
    expect(screen.getByText("应用公钥已验证并启用。")).toBeVisible();
    expect(await body(view)).toEqual({
      revision: 3,
      change_id: "00000000-0000-4000-8000-000000000001",
      platform_public_key: "latest-alipay-key",
    });
    expect(new URL(view.writes()[0]!.url).pathname).toMatch(
      /application-key\/actions\/activate$/,
    );
    expect(view.writes()).toHaveLength(1);
    expect(queryClient.getQueryData(["settings"])).toMatchObject({
      data: {
        provider: {
          ...configuredThrough(4).provider,
          platform_public_key: "latest-alipay-key",
        },
        pending_application_key: null,
      },
    });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(unloadBlocked()).toBe(false);
  });

  it.each([undefined, "check", "collection", "optional"])(
    "suggests activation by default without restricting the explicitly requested step %s",
    async (step) => {
      const settings = pendingApplicationKey();
      const expected = step ?? "provider";
      expect(nextRequiredStep(settings)).toBe("check");
      expect(resolveOnboardingStep(settings, step)).toBe(expected);
      const view = mountOnboarding({
        pendingKey: true,
        path: step ? "/settings/onboarding/" + step : "/settings/onboarding",
      });
      await screen.findByRole("heading", {
        name: onboardingSteps.find((item) => item.id === expected)!.title,
        level: 2,
      });
      expect(view.router.state.location.pathname).toBe(
        "/settings/onboarding/" + expected,
      );
      expect(screen.getByRole("link", { name: /经营码/ })).not.toHaveAttribute(
        "aria-disabled",
        "true",
      );
      if (step) {
        expect(screen.getByText("新应用公钥尚未启用")).toBeVisible();
        expect(
          screen.getByRole("link", { name: "前往验证启用" }),
        ).toHaveAttribute("href", providerPath);
      }
      expect(
        within(
          screen.getByRole("link", { name: /支付宝接入/ }),
        ).queryByLabelText("已配置"),
      ).not.toBeInTheDocument();
      expect(view.writes()).toHaveLength(0);
    },
  );

  it("keeps first-time provider setup editable and uses only its existing save endpoint", async () => {
    const view = mountOnboarding({ stage: 1, path: providerPath });
    await screen.findByLabelText("应用 ID（App ID）");
    expect(screen.getByLabelText("应用 ID（App ID）")).not.toHaveAttribute(
      "readonly",
    );
    expect(screen.getByLabelText("支付宝公钥")).toBeRequired();
    expect(screen.getByLabelText("请求超时（毫秒）")).toBeVisible();
    expect(screen.getByRole("button", { name: "保存并继续" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: actionLabel }),
    ).not.toBeInTheDocument();
    expect(view.writes()).toHaveLength(0);
  });

  it.each(["previous", "refresh"])(
    "preserves unsubmitted key text when cancelling %s",
    async (target) => {
      const view = mountOnboarding({ pendingKey: true, path: providerPath });
      const user = userEvent.setup();
      const form = await activationForm();
      const input = within(form).getByLabelText("支付宝公钥");
      await user.type(input, "unsaved-alipay-key");
      await user.click(
        target === "previous"
          ? screen.getByRole("link", { name: "上一步" })
          : screen.getByRole("button", { name: "刷新" }),
      );
      await user.click(await screen.findByRole("button", { name: "继续编辑" }));
      expect(view.router.state.location.pathname).toBe(providerPath);
      expect(input).toHaveValue("unsaved-alipay-key");
      expect(unloadBlocked()).toBe(true);
      expect(view.writes()).toHaveLength(0);
    },
  );

  it("retries the original input after a lost response and permits correction only after authoritative rejection", async () => {
    let attempts = 0;
    const view = mountOnboarding({
      pendingKey: true,
      path: providerPath,
      handle: (request) => {
        if (!request.url.endsWith("/actions/activate")) return undefined;
        if (++attempts === 1) return Promise.reject(new Error("lost response"));
        if (attempts === 2)
          return apiError(
            "provider_application_key_verification_failed",
            "verification rejected",
            422,
          );
        return undefined;
      },
    });
    const user = userEvent.setup();
    const { form, input } = await fillAndSubmit(user, "wrong-alipay-key");
    await within(form).findByRole("button", { name: "重试同一操作" });
    expect(input).toBeDisabled();
    expect(screen.getByRole("button", { name: "刷新" })).toBeDisabled();
    await user.click(
      within(form).getByRole("button", { name: "重试同一操作" }),
    );
    await within(form).findByText(/支付宝验证未通过/);
    expect(input).toBeEnabled();
    expect(screen.getByRole("button", { name: "刷新" })).toBeEnabled();
    await user.clear(input);
    await user.type(input, "corrected-alipay-key");
    await user.click(within(form).getByRole("button", { name: actionLabel }));
    await screen.findByLabelText("支付宝经营码内容");
    expect(await body(view, 1)).toEqual(await body(view, 0));
    expect(await body(view, 2)).toEqual({
      ...(await body(view, 0)),
      platform_public_key: "corrected-alipay-key",
    });
    expect(view.writes()).toHaveLength(3);
    expect(unloadBlocked()).toBe(false);
  });

  it.each([
    ["csrf_invalid", 403],
    ["settings_validation_failed", 422],
    ["settings_revision_conflict", 409],
    ["internal_error", 500],
  ] as const)(
    "does not unlock an unknown activation after %s",
    async (code, status) => {
      let attempts = 0;
      const view = mountOnboarding({
        pendingKey: true,
        path: providerPath,
        handle: (request) => {
          if (!request.url.endsWith("/actions/activate")) return undefined;
          if (++attempts === 1)
            return Promise.reject(new Error("lost response"));
          return json(
            {
              error: {
                code,
                message: "不能证明上次未执行",
                fields:
                  code === "settings_validation_failed"
                    ? { platform_public_key: "普通字段错误" }
                    : {},
              },
            },
            status,
          );
        },
      });
      const user = userEvent.setup();
      const { form, input } = await fillAndSubmit(user);
      await user.click(
        await within(form).findByRole("button", { name: "重试同一操作" }),
      );
      await within(form).findByText("不能证明上次未执行");
      expect(input).toBeDisabled();
      expect(screen.getByRole("button", { name: "刷新" })).toBeDisabled();
      expect(await body(view, 1)).toEqual(await body(view, 0));
      await user.click(screen.getByRole("link", { name: "上一步" }));
      const leave = await screen.findByRole("alertdialog", {
        name: "操作结果尚未确认，仍要离开？",
      });
      await user.click(within(leave).getByRole("button", { name: "留在此页" }));
      expect(view.router.state.location.pathname).toBe(providerPath);
      expect(input).toHaveValue("latest-alipay-key");
      await waitFor(() =>
        expect(
          within(form).getByRole("button", {
            name: status === 409 ? "刷新配置" : "重试同一操作",
          }),
        ).toHaveFocus(),
      );
    },
  );

  it("requires an explicit outcome warning before reloading an unresolved activation", async () => {
    const view = mountOnboarding({
      pendingKey: true,
      path: providerPath,
      handle: (request) =>
        request.url.endsWith("/actions/activate")
          ? Promise.reject(new Error("lost response"))
          : undefined,
    });
    const user = userEvent.setup();
    const { form, input } = await fillAndSubmit(user);
    await within(form).findByRole("button", { name: "重试同一操作" });
    await user.click(within(form).getByRole("button", { name: "刷新配置" }));
    let confirm = await screen.findByRole("alertdialog", {
      name: "刷新并核对启用结果？",
    });
    await user.click(
      within(confirm).getByRole("button", { name: "保留并重试" }),
    );
    expect(input).toHaveValue("latest-alipay-key");
    expect(input).toBeDisabled();
    await user.click(within(form).getByRole("button", { name: "刷新配置" }));
    confirm = await screen.findByRole("alertdialog", {
      name: "刷新并核对启用结果？",
    });
    await user.click(within(confirm).getByRole("button", { name: "刷新配置" }));
    await waitFor(() =>
      expect(screen.getByLabelText("支付宝公钥")).toHaveValue(""),
    );
    expect(screen.getByLabelText("支付宝公钥")).toBeEnabled();
    expect(screen.getByRole("button", { name: actionLabel })).toBeVisible();
    expect(view.writes()).toHaveLength(1);
  });

  it("keeps the original retry usable if outcome refresh fails", async () => {
    let attempts = 0;
    let failReads = false;
    const view = mountOnboarding({
      pendingKey: true,
      path: providerPath,
      handle: (request) => {
        if (
          failReads &&
          request.method === "GET" &&
          request.url.endsWith("/settings")
        )
          return apiError("internal_error", "读取配置失败", 503);
        if (request.url.endsWith("/actions/activate") && ++attempts === 1)
          return Promise.reject(new Error("lost response"));
        return undefined;
      },
    });
    const user = userEvent.setup();
    const { form, input } = await fillAndSubmit(user);
    await within(form).findByRole("button", { name: "重试同一操作" });
    failReads = true;
    await user.click(within(form).getByRole("button", { name: "刷新配置" }));
    const confirm = await screen.findByRole("alertdialog", {
      name: "刷新并核对启用结果？",
    });
    await user.click(within(confirm).getByRole("button", { name: "刷新配置" }));
    await screen.findByText("读取配置失败");
    expect(input).toHaveValue("latest-alipay-key");
    expect(input).toBeDisabled();
    failReads = false;
    await user.click(
      within(form).getByRole("button", { name: "重试同一操作" }),
    );
    await screen.findByLabelText("支付宝经营码内容");
    expect(await body(view, 1)).toEqual(await body(view, 0));
  });

  it("restores focus to the verification heading when cancelling departure during an in-flight request", async () => {
    let finish!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const view = mountOnboarding({
      pendingKey: true,
      path: providerPath,
      handle: (request) =>
        request.url.endsWith("/actions/activate") ? response : undefined,
    });
    const user = userEvent.setup();
    await fillAndSubmit(user);
    await user.click(screen.getByRole("link", { name: "上一步" }));
    const dialog = await screen.findByRole("alertdialog", {
      name: "操作结果尚未确认，仍要离开？",
    });
    await user.click(within(dialog).getByRole("button", { name: "留在此页" }));
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "验证并启用新应用公钥" }),
      ).toHaveFocus(),
    );
    expect(view.router.state.location.pathname).toBe(providerPath);
    await act(async () => {
      finish(json({ data: activatedSettings() }));
    });
    await screen.findByLabelText("支付宝经营码内容");
    expect(view.writes()).toHaveLength(1);
  });

  it("protects an in-flight request and honors a requested navigation if activation completes during the prompt", async () => {
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const view = mountOnboarding({
      pendingKey: true,
      path: providerPath,
      handle: (request) =>
        request.url.endsWith("/actions/activate") ? pending : undefined,
    });
    const user = userEvent.setup();
    const { form, input } = await fillAndSubmit(user);
    const submit = within(form).getByRole("button", { name: actionLabel });
    fireEvent.click(submit);
    expect(view.writes()).toHaveLength(1);
    expect(input).toBeDisabled();
    expect(submit).toBeDisabled();
    await user.click(screen.getByRole("link", { name: "上一步" }));
    await screen.findByRole("alertdialog", {
      name: "操作结果尚未确认，仍要离开？",
    });
    await act(async () => {
      finish(json({ data: activatedSettings() }));
    });
    await waitFor(() =>
      expect(view.router.state.location.pathname).toBe(applicationPath),
    );
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: actionLabel }),
    ).not.toBeInTheDocument();
    expect(view.writes()).toHaveLength(1);
  });
});
