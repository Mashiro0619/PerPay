import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearOnboardingDeferrals,
  onboardingPath,
  resolveOnboardingStep,
} from "../src/lib/onboarding";
import {
  configuredThrough,
  mountOnboarding,
  systemStatus,
} from "./onboarding-fixture";

beforeEach(() => clearOnboardingDeferrals());
const applicationPath = onboardingPath("application");
const providerPath = onboardingPath("provider");
const collectionPath = onboardingPath("collection");
const body = (view: ReturnType<typeof mountOnboarding>, index: number) =>
  view.writes()[index]!.clone().json();

describe("infrequent application-key maintenance", () => {
  it.each([
    [1, applicationPath],
    [4, applicationPath],
    [1, "/settings/provider"],
    [4, "/settings/provider"],
  ])(
    "keeps regeneration and its explanation collapsed at stage %s / %s",
    async (stage, path) => {
      const view = mountOnboarding({
        stage: Number(stage),
        path: String(path),
      });
      const user = userEvent.setup();
      const toggle = await screen.findByRole("button", { name: "密钥维护" });
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect(
        screen.queryByRole("button", { name: "重新生成应用公钥" }),
      ).not.toBeInTheDocument();
      expect(screen.queryByText(/重新生成会同时/)).not.toBeInTheDocument();
      toggle.focus();
      await user.keyboard("{Enter}");
      expect(toggle).toHaveAttribute("aria-expanded", "true");
      expect(
        screen.getByRole("button", { name: "重新生成应用公钥" }),
      ).toBeVisible();
      expect(screen.getByText(/重新生成会同时/)).toBeVisible();
      expect(view.writes()).toHaveLength(0);
      await user.click(toggle);
      await waitFor(() =>
        expect(
          screen.queryByRole("button", { name: "重新生成应用公钥" }),
        ).not.toBeInTheDocument(),
      );
      expect(view.writes()).toHaveLength(0);
    },
  );

  it("collapses again and restores a visible focus target after replacing an initial key", async () => {
    const view = mountOnboarding({ stage: 1, path: applicationPath });
    const user = userEvent.setup();
    const toggle = await screen.findByRole("button", { name: "密钥维护" });
    await user.click(toggle);
    await user.click(screen.getByRole("button", { name: "重新生成应用公钥" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "生成新公钥",
      }),
    );
    await screen.findByText("synthetic-regenerated-application-public-key");
    await waitFor(() => expect(toggle).toHaveFocus());
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("button", { name: "重新生成应用公钥" }),
    ).not.toBeInTheDocument();
    expect(view.writes()).toHaveLength(1);
  });
});

describe("non-blocking pending application keys", () => {
  it("keeps all later steps usable immediately after regeneration", async () => {
    const view = mountOnboarding({ stage: 4, path: applicationPath });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "密钥维护" }));
    await user.click(screen.getByRole("button", { name: "重新生成应用公钥" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "生成新公钥",
      }),
    );
    await screen.findByText("synthetic-pending-application-public-key");
    for (const name of ["经营码", "通知与备份", "收款检查"])
      expect(
        screen.getByRole("link", { name: new RegExp(name) }),
      ).not.toHaveAttribute("aria-disabled", "true");
    await user.click(screen.getByRole("link", { name: /经营码/ }));
    await screen.findByLabelText("支付宝经营码内容");
    const warning = screen
      .getByText("新应用公钥尚未启用")
      .closest('[role="status"]')!;
    expect(warning).toHaveAttribute("data-slot", "alert");
    expect(
      within(warning as HTMLElement).getByText(/其他配置可以继续修改/),
    ).toBeVisible();
    expect(
      within(warning as HTMLElement).getByRole("link", {
        name: "前往验证启用",
      }),
    ).toHaveAttribute("href", providerPath);
    expect(view.router.state.location.pathname).toBe(collectionPath);
    expect(view.writes()).toHaveLength(1);
  });

  it("allows skipping activation, saving other settings and activating later with the latest revision", async () => {
    const view = mountOnboarding({ pendingKey: true, path: providerPath });
    const user = userEvent.setup();
    const pending = structuredClone(view.saved.pending_application_key);
    const currentKey = view.saved.application_public_key;
    await user.click(
      await screen.findByRole("link", { name: "暂不启用，继续配置" }),
    );
    const orderTtl = await screen.findByLabelText("收银台有效期（秒）");
    expect(screen.getByText("新应用公钥尚未启用")).toBeVisible();
    fireEvent.change(orderTtl, { target: { value: "1800" } });
    await user.click(screen.getByRole("button", { name: "保存并继续" }));
    await screen.findByRole("heading", { name: "通知与备份", level: 2 });
    expect(view.saved.collection!.order_ttl_seconds).toBe(1800);
    expect(view.saved.pending_application_key).toEqual(pending);
    expect(view.saved.application_public_key).toBe(currentKey);
    await user.click(screen.getByRole("link", { name: /通知与备份/ }));
    fireEvent.change(await screen.findByLabelText("备份间隔（秒）"), {
      target: { value: "172800" },
    });
    await user.click(screen.getByRole("button", { name: "保存备份" }));
    await waitFor(() =>
      expect(view.saved.backup.interval_seconds).toBe(172800),
    );
    expect(view.saved.pending_application_key).toEqual(pending);
    expect(view.writes()).toHaveLength(2);
    await user.click(screen.getByRole("link", { name: "前往验证启用" }));
    const form = await screen.findByRole("form", {
      name: "验证并启用新应用公钥",
    });
    await user.type(
      within(form).getByLabelText("支付宝公钥"),
      "latest-platform-key",
    );
    await user.click(
      within(form).getByRole("button", { name: "验证并启用后继续" }),
    );
    await screen.findByLabelText("支付宝经营码内容");
    expect(await body(view, 2)).toEqual({
      revision: 5,
      change_id: pending!.change_id,
      platform_public_key: "latest-platform-key",
    });
    expect(view.saved.pending_application_key).toBeNull();
    expect(view.saved.collection!.order_ttl_seconds).toBe(1800);
    expect(view.saved.backup.interval_seconds).toBe(172800);
    expect(screen.queryByText("新应用公钥尚未启用")).not.toBeInTheDocument();
  });

  it("preserves a later-step draft when cancelling the warning's navigation link", async () => {
    const view = mountOnboarding({ pendingKey: true, path: collectionPath });
    const user = userEvent.setup();
    const input = await screen.findByLabelText("收银台有效期（秒）");
    fireEvent.change(input, { target: { value: "1800" } });
    await user.click(screen.getByRole("link", { name: "前往验证启用" }));
    await user.click(await screen.findByRole("button", { name: "继续编辑" }));
    expect(view.router.state.location.pathname).toBe(collectionPath);
    expect(input).toHaveValue(1800);
    expect(view.writes()).toHaveLength(0);
  });

  it("does not silently abandon an unresolved operation through the skip link", async () => {
    const view = mountOnboarding({
      pendingKey: true,
      path: providerPath,
      handle: (request) =>
        request.url.endsWith("/actions/activate")
          ? Promise.reject(new Error("lost response"))
          : undefined,
    });
    const user = userEvent.setup();
    const input = await screen.findByLabelText("支付宝公钥");
    await user.type(input, "submitted-platform-key");
    await user.click(screen.getByRole("button", { name: "验证并启用后继续" }));
    await screen.findByRole("button", { name: "重试同一操作" });
    await user.click(screen.getByRole("link", { name: "暂不启用，继续配置" }));
    let dialog = await screen.findByRole("alertdialog", {
      name: "操作结果尚未确认，仍要离开？",
    });
    await user.click(within(dialog).getByRole("button", { name: "留在此页" }));
    expect(input).toHaveValue("submitted-platform-key");
    expect(input).toBeDisabled();
    await user.click(screen.getByRole("link", { name: "暂不启用，继续配置" }));
    dialog = await screen.findByRole("alertdialog", {
      name: "操作结果尚未确认，仍要离开？",
    });
    await user.click(
      within(dialog).getByRole("button", { name: "离开并稍后核查" }),
    );
    await screen.findByLabelText("支付宝经营码内容");
    expect(screen.getByText("新应用公钥尚未启用")).toBeVisible();
    expect(view.writes()).toHaveLength(1);
  });

  it("still honors real collection-readiness failures rather than treating a pending-key warning as permission to receive", async () => {
    const view = mountOnboarding({
      pendingKey: true,
      path: onboardingPath("check"),
      status: (settings) => {
        const status = systemStatus(settings);
        status.status = "not_ready";
        status.ledger.collection_ready = false;
        return status;
      },
    });
    await screen.findByText("等待成功采集");
    expect(screen.getByText("新应用公钥尚未启用")).toBeVisible();
    expect(
      screen.queryByRole("link", { name: "进入控制台" }),
    ).not.toBeInTheDocument();
    expect(view.writes()).toHaveLength(0);
    expect(resolveOnboardingStep(configuredThrough(1), "check")).toBe(
      "provider",
    );
  });
});
