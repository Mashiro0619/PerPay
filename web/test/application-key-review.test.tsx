import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { queryClient } from "../src/api/client";
import { SuccessMessage } from "../src/components/Feedback";
import {
  clearOnboardingDeferrals,
  onboardingPath,
} from "../src/lib/onboarding";
import { apiError, json } from "./fixtures";
import { mountOnboarding } from "./onboarding-fixture";

beforeEach(() => clearOnboardingDeferrals());

const applicationPath = onboardingPath("application");
const providerPath = onboardingPath("provider");
const currentKey = "synthetic-application-public-key";
const pendingKey = "synthetic-pending-application-public-key";
const body = (view: ReturnType<typeof mountOnboarding>, index: number) =>
  view.writes()[index]!.clone().json();
function unloadBlocked() {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

async function openActivation(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "验证并启用" }));
  const dialog = await screen.findByRole("dialog", {
    name: "验证并启用新应用公钥",
  });
  const input = within(dialog).getByLabelText("支付宝公钥");
  await user.type(input, "original-platform-key");
  await user.click(within(dialog).getByRole("button", { name: "验证并启用" }));
  return { dialog, input };
}

describe("pending key continuity across onboarding steps", () => {
  it("copies the pending key after Next and refresh, and activates in the provider step", async () => {
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
    await screen.findByText(pendingKey);
    expect(
      screen.queryByRole("button", { name: "验证并启用" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "下一步" }));
    await screen.findByLabelText("应用 ID（App ID）");
    expect(view.router.state.location.pathname).toBe(providerPath);
    const help = screen.getByRole("complementary", { name: "本步说明" });
    expect(
      within(help).getByRole("heading", { name: "填回支付宝公钥" }),
    ).toBeVisible();
    expect(within(help).getByText(/点击“验证并启用后继续”/)).toBeVisible();
    expect(
      screen.queryByText(/本页保存不会启用新密钥/),
    ).not.toBeInTheDocument();
    expect(within(help).queryByText(/如有更新|可留空/)).not.toBeInTheDocument();
    expect(
      within(help).queryByRole("button", { name: "查看应用公钥" }),
    ).not.toBeInTheDocument();
    await user.click(
      within(help).getByRole("button", { name: "查看待启用应用公钥" }),
    );
    expect(within(help).getByText(pendingKey)).toBeVisible();
    expect(within(help).queryByText(currentKey)).not.toBeInTheDocument();
    await user.click(
      within(help).getByRole("button", { name: "复制待启用应用公钥" }),
    );
    await waitFor(() => expect(clipboard).toHaveBeenLastCalledWith(pendingKey));
    await user.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "刷新" })).toBeEnabled(),
    );
    await user.click(
      screen.getByRole("button", { name: "查看待启用应用公钥" }),
    );
    await user.click(
      screen.getByRole("button", { name: "复制待启用应用公钥" }),
    );
    await waitFor(() => expect(clipboard).toHaveBeenLastCalledWith(pendingKey));
    expect(
      screen.queryByRole("link", { name: "返回验证并启用" }),
    ).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("支付宝公钥"), "latest-platform-key");
    await user.click(screen.getByRole("button", { name: "验证并启用后继续" }));
    await screen.findByLabelText("支付宝经营码内容");
    expect(view.router.state.location.pathname).toBe(
      onboardingPath("collection"),
    );
    expect(view.writes()).toHaveLength(2);
    expect(new URL(view.writes()[1]!.url).pathname).toMatch(
      /actions\/activate$/,
    );
  });

  it.each([1, 4])(
    "keeps the ordinary upload instructions for stage %i without a pending key",
    async (stage) => {
      const user = userEvent.setup();
      const clipboard = vi.spyOn(navigator.clipboard, "writeText");
      const view = mountOnboarding({ stage, path: providerPath });
      await user.click(
        await screen.findByRole("button", { name: "查看应用公钥" }),
      );
      await user.click(screen.getByRole("button", { name: "复制应用公钥" }));
      await waitFor(() =>
        expect(clipboard).toHaveBeenLastCalledWith(currentKey),
      );
      expect(
        screen.queryByRole("link", { name: "返回验证并启用" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("heading", { name: "填回支付宝公钥" }),
      ).not.toBeInTheDocument();
      expect(view.writes()).toHaveLength(0);
    },
  );

  it("keeps the activation public-key draft when returning to the first step is cancelled", async () => {
    const user = userEvent.setup();
    const view = mountOnboarding({ pendingKey: true, path: providerPath });
    const input = await screen.findByLabelText("支付宝公钥");
    fireEvent.change(input, { target: { value: "unsaved-platform-key" } });
    await user.click(screen.getByRole("link", { name: "上一步" }));
    await user.click(await screen.findByRole("button", { name: "继续编辑" }));
    expect(view.router.state.location.pathname).toBe(providerPath);
    expect(input).toHaveValue("unsaved-platform-key");
    expect(view.writes()).toHaveLength(0);
  });

  it.each([
    ["activate", "验证并启用", "验证并启用", pendingKey],
    ["discard", "放弃新公钥", "确认放弃", currentKey],
  ] as const)(
    "uses the current key after %s ends the pending state",
    async (action, trigger, submit, key) => {
      const user = userEvent.setup();
      const clipboard = vi.spyOn(navigator.clipboard, "writeText");
      const view = mountOnboarding({
        pendingKey: true,
        path: action === "activate" ? providerPath : applicationPath,
      });
      if (action !== "activate")
        await user.click(await screen.findByRole("button", { name: trigger }));
      const dialog = await screen.findByRole(
        action === "activate" ? "form" : "dialog",
        {
          name: action === "activate" ? "验证并启用新应用公钥" : "放弃新公钥？",
        },
      );
      if (action === "activate")
        await user.type(
          within(dialog).getByLabelText("支付宝公钥"),
          "latest-platform-key",
        );
      else await user.click(within(dialog).getByRole("checkbox"));
      await user.click(
        within(dialog).getByRole("button", {
          name: action === "activate" ? "验证并启用后继续" : submit,
        }),
      );
      await waitFor(() =>
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
      );
      if (action === "activate") {
        await screen.findByLabelText("支付宝经营码内容");
        await user.click(screen.getByRole("tab", { name: /支付宝接入/ }));
      } else await user.click(screen.getByRole("button", { name: "下一步" }));
      await user.click(
        await screen.findByRole("button", { name: "查看应用公钥" }),
      );
      await user.click(screen.getByRole("button", { name: "复制应用公钥" }));
      await waitFor(() => expect(clipboard).toHaveBeenLastCalledWith(key));
      expect(
        screen.queryByRole("link", { name: "返回验证并启用" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "复制待启用应用公钥" }),
      ).not.toBeInTheDocument();
      expect(view.writes()).toHaveLength(1);
    },
  );
});

describe("authoritative verification failure after an unknown response", () => {
  it("unlocks correction after network failure then verification rejection, preserving the change identity", async () => {
    let attempts = 0;
    const view = mountOnboarding({
      pendingKey: true,
      path: "/settings/provider",
      handle: (request) => {
        if (!request.url.endsWith("/actions/activate")) return undefined;
        attempts++;
        if (attempts === 1)
          return Promise.reject(new Error("synthetic lost response"));
        if (attempts === 2)
          return apiError(
            "provider_application_key_verification_failed",
            "verification failed",
            422,
          );
        return undefined;
      },
    });
    const user = userEvent.setup();
    const { dialog, input } = await openActivation(user);
    const retry = await within(dialog).findByRole("button", {
      name: "重试同一操作",
    });
    expect(input).toBeDisabled();
    expect(within(dialog).queryByRole("checkbox")).not.toBeInTheDocument();
    await waitFor(() => expect(unloadBlocked()).toBe(true));
    await user.click(retry);
    expect(await within(dialog).findByText(/支付宝验证未通过/)).toBeVisible();
    expect(input).toBeEnabled();
    expect(
      within(dialog).queryByText(/上次操作结果尚未确认/),
    ).not.toBeInTheDocument();
    expect(
      within(dialog).queryByRole("button", { name: "重试同一操作" }),
    ).not.toBeInTheDocument();
    await waitFor(() => expect(unloadBlocked()).toBe(false));
    expect(queryClient.getQueryData(["settings"])).toMatchObject({
      data: {
        application_public_key: currentKey,
        pending_application_key: { public_key: pendingKey },
      },
    });
    await user.clear(input);
    await user.type(input, "corrected-platform-key");
    await user.click(
      within(dialog).getByRole("button", { name: "验证并启用" }),
    );
    expect(await screen.findByText("应用公钥已验证并启用。")).toBeVisible();
    expect(view.writes()).toHaveLength(3);
    const first = await body(view, 0);
    expect(await body(view, 1)).toEqual(first);
    expect(await body(view, 2)).toEqual({
      ...first,
      platform_public_key: "corrected-platform-key",
    });
    expect(
      view
        .writes()
        .every((request) => request.url.endsWith("/actions/activate")),
    ).toBe(true);
  });

  it.each([
    [403, "csrf_invalid", false],
    [422, "validation_failed", false],
    [422, "settings_validation_failed", true],
    [409, "settings_revision_conflict", false],
    [500, "internal_error", false],
  ] as const)(
    "preserves uncertainty after an ordinary %i/%s response",
    async (status, code, fieldError) => {
      let attempts = 0;
      const view = mountOnboarding({
        pendingKey: true,
        path: "/settings/provider",
        handle: (request) => {
          if (!request.url.endsWith("/actions/activate")) return undefined;
          attempts++;
          if (attempts === 1)
            return Promise.reject(new Error("synthetic lost response"));
          return json(
            {
              error: {
                code,
                message: "此响应不证明先前操作未执行",
                ...(fieldError
                  ? { fields: { platform_public_key: "请核对公钥" } }
                  : {}),
              },
            },
            status,
          );
        },
      });
      const user = userEvent.setup();
      const { dialog, input } = await openActivation(user);
      await user.click(
        await within(dialog).findByRole("button", { name: "重试同一操作" }),
      );
      await within(dialog).findByText("此响应不证明先前操作未执行");
      expect(input).toBeDisabled();
      expect(within(dialog).getByText(/上次操作结果尚未确认/)).toBeVisible();
      expect(unloadBlocked()).toBe(true);
      expect(await body(view, 1)).toEqual(await body(view, 0));
      expect(view.writes()).toHaveLength(2);
    },
  );
});

describe.each([
  ["onboarding", applicationPath],
  ["regular settings", "/settings/provider"],
] as const)("key operation completion feedback in %s", (_name, path) => {
  it.each([
    [
      "initial",
      "重新生成应用公钥",
      "生成新公钥",
      "应用公钥已重新生成，请使用新的公钥配置支付宝。",
    ],
    [
      "active",
      "重新生成应用公钥",
      "生成新公钥",
      "新应用公钥已生成，上传到支付宝后再验证启用。",
    ],
    ["pending", "验证并启用", "验证并启用", "应用公钥已验证并启用。"],
    ["pending", "放弃新公钥", "确认放弃", "已放弃待启用公钥，当前密钥未更换。"],
  ] as const)(
    "uses a wrapping status callout for %s/%s",
    async (state, trigger, submit, message) => {
      const inline = path === applicationPath && trigger === "验证并启用";
      const view = mountOnboarding({
        stage: state === "initial" ? 1 : 4,
        pendingKey: state === "pending",
        path: inline ? providerPath : path,
      });
      const user = userEvent.setup();
      if (!inline)
        await user.click(await screen.findByRole("button", { name: trigger }));
      const dialog = await screen.findByRole(inline ? "form" : "dialog");
      if (trigger === "验证并启用")
        await user.type(
          within(dialog).getByLabelText("支付宝公钥"),
          "latest-platform-key",
        );
      else if (state === "pending")
        await user.click(within(dialog).getByRole("checkbox"));
      await user.click(
        within(dialog).getByRole("button", {
          name: inline ? "验证并启用后继续" : submit,
        }),
      );
      const feedback = await screen.findByText(message);
      const status = feedback.closest('[role="status"]');
      expect(status).toHaveAttribute("data-slot", "alert");
      expect(status).toHaveClass("min-w-0");
      expect(feedback.closest('[data-slot="badge"]')).toBeNull();
      expect(view.writes()).toHaveLength(1);
    },
  );
});

it("does not change the default compact feedback used elsewhere", () => {
  render(<SuccessMessage message="已保存" />);
  expect(screen.getByRole("status")).toHaveAttribute("data-slot", "badge");
});
