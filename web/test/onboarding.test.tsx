import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { clearOnboardingDeferrals, isOnboardingDeferred } from "../src/lib/onboarding";
import { instanceId, mountOnboarding, systemStatus } from "./onboarding-fixture";

beforeEach(() => clearOnboardingDeferrals());
const pathIs = (view: ReturnType<typeof mountOnboarding>, step: string) => waitFor(() => expect(view.router.state.location.pathname).toBe("/settings/onboarding/" + step));
const edit = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe("first collection onboarding", () => {
  it("keeps administrator initialization separate, then begins configuration after login", async () => {
    const meta = document.createElement("meta");
    meta.name = "perpay-initialized";
    meta.content = "false";
    document.head.append(meta);
    const view = mountOnboarding({ signedIn: false, path: "/setup" });
    await screen.findByLabelText("设置管理员密码");
    edit("一次性初始化令牌", "e".repeat(64));
    edit("设置管理员密码", "isolated-onboarding-password");
    edit("再次输入密码", "isolated-onboarding-password");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "创建管理员" }));
    await screen.findByRole("heading", { name: "登录管理后台" });
    expect(view.router.state.location.pathname).toBe("/login");
    expect(view.writes()).toHaveLength(1);
    edit("管理员密码", "isolated-onboarding-password");
    await user.click(screen.getByRole("button", { name: "登录" }));
    await pathIs(view, "accounts");
    expect(
      view.writes().map((request) => new URL(request.url).pathname),
    ).toEqual(["/api/admin/v1/setup", "/api/admin/v1/session/login"]);
  });
  it("takes a new instance from the overview to the first step", async () => {
    const view = mountOnboarding({ path: "/" });
    await pathIs(view, "accounts");
    expect(
      await screen.findByRole("heading", { name: "配置支付宝账号" }),
    ).toBeVisible();
    expect(view.writes()).toHaveLength(0);
  });
  it.each(["/orders", "/settings/display"])(
    "does not force explicit %s navigation through onboarding",
    async (path) => {
      const view = mountOnboarding({ path });
      await screen.findByRole("heading", {
        name: path === "/orders" ? "全部订单" : "系统设置",
        level: 1,
      });
      expect(view.router.state.location.pathname).toBe(path);
    },
  );
  it("does not reopen setup for an already configured instance with a runtime outage", async () => {
    const view = mountOnboarding({
      stage: 4,
      path: "/",
      status: (value) => ({ ...systemStatus(value), status: "not_ready" }),
    });
    await screen.findByRole("heading", { name: "收款趋势" });
    expect(view.router.state.location.pathname).toBe("/");
    expect(
      screen.queryByRole("heading", { name: "首次收款配置" }),
    ).not.toBeInTheDocument();
  });
  it("defers only this instance in the tab and clears the deferral on logout", async () => {
    const view = mountOnboarding();
    await screen.findByRole("link", { name: "稍后配置" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("link", { name: "稍后配置" }));
    await screen.findByRole("link", { name: "继续配置" });
    expect(view.router.state.location.pathname).toBe("/");
    expect(isOnboardingDeferred(instanceId)).toBe(true);
    expect(isOnboardingDeferred("another-instance")).toBe(false);
    expect(
      view.router.state.location.state?.deferOnboardingFor,
    ).toBeUndefined();
    await user.click(screen.getByRole("button", { name: /账户菜单$/ }));
    await user.click(await screen.findByRole("menuitem", { name: "退出登录" }));
    await screen.findByRole("heading", { name: "登录管理后台" });
    expect(isOnboardingDeferred(instanceId)).toBe(false);
  });
});
