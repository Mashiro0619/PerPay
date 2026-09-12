import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { queryClient, sessionKey } from "../src/api/client";
import { clearOnboardingDeferrals, isOnboardingDeferred, onboardingPath, resolveOnboardingStep } from "../src/lib/onboarding";
import { apiError, json } from "./fixtures";
import { configuredThrough, instanceId, mountOnboarding, syntheticSecret, systemStatus } from "./onboarding-fixture";

beforeEach(() => { clearOnboardingDeferrals(); });
const pathIs = (view: ReturnType<typeof mountOnboarding>, step: string) => waitFor(() => expect(view.router.state.location.pathname).toBe("/settings/onboarding/" + step));
const edit = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe("first collection onboarding", () => {
  it("keeps administrator initialization separate, then begins configuration after login", async () => {
    const meta = document.createElement("meta"); meta.name = "perpay-initialized"; meta.content = "false"; document.head.append(meta);
    const view = mountOnboarding({ signedIn: false, path: "/setup" });
    await screen.findByLabelText("设置管理员密码");
    edit("设置管理员密码", "isolated-onboarding-password"); edit("再次输入密码", "isolated-onboarding-password");
    const user = userEvent.setup(); await user.click(screen.getByRole("button", { name: "创建管理员" }));
    await screen.findByRole("heading", { name: "登录管理后台" });
    expect(view.router.state.location.pathname).toBe("/login");
    expect(view.writes()).toHaveLength(1);
    edit("管理员密码", "isolated-onboarding-password"); await user.click(screen.getByRole("button", { name: "登录" }));
    await pathIs(view, "application");
    expect(view.writes().map((request) => new URL(request.url).pathname)).toEqual(["/api/admin/v1/setup", "/api/admin/v1/session/login"]);
  });
  it("remounts at the first missing step using saved server configuration", async () => {
    const first = mountOnboarding({ stage: 2, path: onboardingPath("check") });
    await pathIs(first, "collection"); first.unmount(); queryClient.clear();
    const second = mountOnboarding({ stage: 2 });
    await pathIs(second, "collection");
    expect(second.writes()).toHaveLength(0);
  });
  it.each([0, 1, 2, 3, 4])("resolves real server progress for stage %i instead of trusting URL progress", (stage) => {
    const next = ["application", "provider", "collection", "api", "check"][stage];
    expect(resolveOnboardingStep(configuredThrough(stage), "check")).toBe(next);
    expect(resolveOnboardingStep(configuredThrough(stage), "unknown")).toBe(next);
    expect(resolveOnboardingStep(configuredThrough(stage), "application")).toBe("application");
  });
  it("takes a new instance from the overview to the first step", async () => {
    const view = mountOnboarding({ path: "/" });
    await pathIs(view, "application");
    expect(await screen.findByRole("heading", { name: "应用密钥" })).toBeVisible();
    expect(view.writes()).toHaveLength(0);
  });
  it("keeps prerequisites in optional help without repeating long instructions", async () => {
    const view = mountOnboarding();
    const help = await screen.findByText("接入前准备");
    expect(help.closest("details")).not.toHaveAttribute("open");
    expect(screen.getByText(/支付宝搜索“经营码”申请/)).not.toBeVisible();
    await userEvent.setup().click(help);
    expect(screen.getByText(/支付宝搜索“经营码”申请/)).toBeVisible();
    expect(screen.getByText(/支付宝应用需有账务明细查询权限/)).toBeVisible();
    expect(screen.getByRole("link", { name: "图文教程" })).toHaveAttribute("href", "https://github.com/Mashiro0619/PerPay/blob/main/docs/alipay-setup.md");
    expect(view.writes()).toHaveLength(0);
  });
  it("keeps the provider step focused on App ID and the Alipay public key", async () => {
    const view = mountOnboarding({ stage: 1 });
    expect(await screen.findByLabelText("应用 ID（App ID）")).toBeVisible();
    expect(screen.getByLabelText("支付宝公钥")).toBeVisible();
    expect(screen.getByLabelText("支付宝环境")).not.toBeVisible();
    expect(screen.getByLabelText("请求超时（毫秒）")).not.toBeVisible();
    expect(screen.getByRole("link", { name: "支付宝应用管理" })).toHaveAttribute("href", "https://open.alipay.com/develop/manage");
    expect(screen.queryByText(/应用网关|生成密钥文件|保存只完成配置/)).not.toBeInTheDocument();
    expect(screen.getAllByRole("heading", { name: "支付宝接入" })).toHaveLength(1);
    expect(view.writes()).toHaveLength(0);
  });
  it.each(["/orders", "/settings/provider"])("does not force explicit %s navigation through onboarding", async (path) => {
    const view = mountOnboarding({ path });
    await screen.findByRole("heading", { name: path === "/orders" ? "订单" : "实例设置", level: 1 });
    expect(view.router.state.location.pathname).toBe(path);
  });
  it("does not reopen setup for an already configured instance with a runtime outage", async () => {
    const view = mountOnboarding({ stage: 4, path: "/", status: (value) => ({ ...systemStatus(value), status: "not_ready" }) });
    await screen.findByText("收款数据");
    expect(view.router.state.location.pathname).toBe("/");
    expect(screen.queryByRole("heading", { name: "首次收款配置" })).not.toBeInTheDocument();
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
    expect(view.router.state.location.state?.deferOnboardingFor).toBeUndefined();
    await user.click(screen.getByRole("button", { name: "退出登录" }));
    await screen.findByRole("heading", { name: "登录管理后台" });
    expect(isOnboardingDeferred(instanceId)).toBe(false);
  });
  it("keeps the current draft and does not defer when leaving is cancelled", async () => {
    const view = mountOnboarding({ stage: 2, path: onboardingPath("collection") });
    await screen.findByLabelText("支付宝经营码内容");
    edit("支付宝经营码内容", "https://qr.alipay.com/draft");
    const user = userEvent.setup();
    await user.click(screen.getByRole("link", { name: "稍后配置" }));
    await user.click(await screen.findByRole("button", { name: "继续编辑" }));
    expect(isOnboardingDeferred(instanceId)).toBe(false);
    expect(screen.getByLabelText("支付宝经营码内容")).toHaveValue("https://qr.alipay.com/draft");
    await pathIs(view, "collection");
  });
  it("generates an application key once and waits for an explicit next step", async () => {
    const view = mountOnboarding();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "生成应用密钥" }));
    expect(await screen.findByText("synthetic-application-public-key")).toBeVisible();
    await pathIs(view, "application");
    expect(view.writes()).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "生成应用密钥" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "下一步" }));
    await pathIs(view, "provider");
  });
  it("saves provider defaults before advancing without a discard prompt", async () => {
    const view = mountOnboarding({ stage: 1 });
    await screen.findByLabelText("应用 ID（App ID）");
    edit("应用 ID（App ID）", "my-app"); edit("支付宝公钥", "synthetic-platform-public-key");
    expect(screen.getByText("高级设置").closest("details")).not.toHaveAttribute("open");
    await userEvent.setup().click(screen.getByRole("button", { name: "保存并继续" }));
    await pathIs(view, "collection");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(await view.writes()[0]!.clone().json()).toMatchObject({ revision: 3, app_id: "my-app", timeout_milliseconds: 8000, scan_interval_seconds: 30, active_scan_interval_seconds: 5, safety_lag_seconds: 10, maximum_success_age_seconds: 60 });
    const unload = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(unload); expect(unload.defaultPrevented).toBe(false);
  });
  it("preserves a conflicted draft and stays on the same step", async () => {
    const view = mountOnboarding({ stage: 2, handle: (request) => request.method === "PUT" ? apiError("settings_revision_conflict", "configuration changed") : undefined });
    await screen.findByLabelText("支付宝经营码内容");
    edit("支付宝经营码内容", "https://qr.alipay.com/conflict-draft");
    await userEvent.setup().click(screen.getByRole("button", { name: "保存并继续" }));
    expect(await screen.findByRole("alert")).toBeVisible();
    await pathIs(view, "collection");
    expect(screen.getByLabelText("支付宝经营码内容")).toHaveValue("https://qr.alipay.com/conflict-draft");
    expect(screen.getByText("有未保存的修改")).toBeVisible();
  });
  it("saves a manual collection payload with the current revision before continuing", async () => {
    const view = mountOnboarding({ stage: 2 });
    const field = await screen.findByLabelText("支付宝经营码内容");
    expect(screen.getByText("上传接入账户的经营码，核对识别结果后保存。")).toBeVisible();
    expect(field).toHaveAttribute("rows", "2");
    expect(screen.getByRole("button", { name: "点击或拖拽二维码图片" })).toBeVisible();
    edit("支付宝经营码内容", "https://qr.alipay.com/onboarding");
    await userEvent.setup().click(screen.getByRole("button", { name: "保存并继续" }));
    await pathIs(view, "api");
    expect(view.saved.collection?.code_payload).toBe("https://qr.alipay.com/onboarding");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("keeps generated API plaintext until explicit storage confirmation, without persisting it", async () => {
    const view = mountOnboarding({ stage: 3 });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "生成 API 密钥" }));
    await user.click(screen.getByRole("button", { name: "生成密钥" }));
    expect(await screen.findByText(syntheticSecret)).toBeVisible();
    await pathIs(view, "api");
    expect(JSON.stringify(sessionStorage)).not.toContain(syntheticSecret);
    await user.click(screen.getByRole("button", { name: "已妥善保存" }));
    await pathIs(view, "optional");
    expect(screen.queryByText(syntheticSecret)).not.toBeInTheDocument();
    expect(view.writes()).toHaveLength(1);
  });
  it("reuses an existing API key and does not rotate it on revisit", async () => {
    const view = mountOnboarding({ stage: 4, path: onboardingPath("api") });
    expect(await screen.findByRole("button", { name: "查看密钥" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "生成 API 密钥" })).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "已保存，下一步" }));
    await pathIs(view, "optional");
    expect(view.writes()).toHaveLength(0);
  });
  it("closes a pending API key dialog when hidden and never navigates on a late secret", async () => {
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    let finish: (response: Response) => void = () => {};
    const view = mountOnboarding({ stage: 3, handle: (request) => request.url.endsWith("/api-key/actions/rotate") ? new Promise<Response>((resolve) => { finish = resolve; }) : undefined });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "生成 API 密钥" })); await user.click(screen.getByRole("button", { name: "生成密钥" }));
    hidden.mockReturnValue(true); fireEvent(document, new Event("visibilitychange"));
    await act(async () => { finish(json({ data: { settings: configuredThrough(4), secret: syntheticSecret, client_id: "default" } })); });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText(syntheticSecret)).not.toBeInTheDocument();
    await pathIs(view, "api");
  });
  it("clears revealed API plaintext after sixty seconds without advancing", async () => {
    const view = mountOnboarding({ stage: 4, path: onboardingPath("api") });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "查看密钥" }));
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "读取明文" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(screen.getByText(syntheticSecret)).toBeVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText(syntheticSecret)).not.toBeInTheDocument();
    expect(view.router.state.location.pathname).toBe(onboardingPath("api"));
  });
  it("preserves the other optional form while saving each with the latest revision", async () => {
    const view = mountOnboarding({ stage: 4, path: onboardingPath("optional") });
    await userEvent.setup().click(await screen.findByText("调整备份策略"));
    await screen.findByLabelText("备份间隔（秒）");
    edit("备份间隔（秒）", "172800");
    fireEvent.click(screen.getByRole("checkbox", { name: "启用业务通知" }));
    edit("允许的通知网站 Origin", "https://shop.example.com");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "保存通知" }));
    await screen.findByRole("button", { name: "查看签名密钥" });
    expect(screen.getByLabelText("备份间隔（秒）")).toHaveValue(172800);
    expect(screen.getAllByText("有未保存的修改")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "保存备份" }));
    await waitFor(() => expect(screen.queryByText("有未保存的修改")).not.toBeInTheDocument());
    expect(await view.writes()[0]!.clone().json()).toMatchObject({ revision: 3, enabled: true, allowed_origin: "https://shop.example.com" });
    expect(await view.writes()[1]!.clone().json()).toEqual({ revision: 4, interval_seconds: 172800, keep_count: 7 });
  });
  it("skips optional settings without writing or treating disabled notifications as enabled", async () => {
    const view = mountOnboarding({ stage: 4, path: onboardingPath("optional") });
    await userEvent.setup().click(await screen.findByRole("link", { name: "继续" }));
    await pathIs(view, "check");
    expect(await screen.findByText("业务通知未启用，请由网站主动查单。")).toBeVisible();
    expect(view.writes()).toHaveLength(0);
  });
  it("confirms dirty optional settings before skipping and never saves them implicitly", async () => {
    const view = mountOnboarding({ stage: 4, path: onboardingPath("optional") });
    await userEvent.setup().click(await screen.findByText("调整备份策略"));
    await screen.findByLabelText("备份间隔（秒）"); edit("备份间隔（秒）", "172800");
    const user = userEvent.setup();
    await user.click(screen.getByRole("link", { name: "继续" }));
    await user.click(await screen.findByRole("button", { name: "放弃修改并继续" }));
    await pathIs(view, "check");
    expect(view.saved.backup.interval_seconds).toBe(86400);
    expect(view.writes()).toHaveLength(0);
  });
  it("retains a wizard draft during a temporary session query failure", async () => {
    let fail = false;
    const view = mountOnboarding({ stage: 2, handle: (request) => fail && new URL(request.url).pathname.endsWith("/session") ? apiError("internal_error", "temporary failure", 503) : undefined });
    const field = await screen.findByLabelText("支付宝经营码内容"); edit("支付宝经营码内容", "https://qr.alipay.com/retained"); fail = true;
    await act(async () => { await queryClient.refetchQueries({ queryKey: sessionKey, exact: true }); });
    expect(screen.getByLabelText("支付宝经营码内容")).toBe(field);
    expect(field).toHaveValue("https://qr.alipay.com/retained");
    await pathIs(view, "collection");
  });
  it("ignores a save callback after the user leaves the step", async () => {
    let finish: (response: Response) => void = () => {};
    const view = mountOnboarding({ stage: 2, handle: (request) => request.method === "PUT" ? new Promise<Response>((resolve) => { finish = resolve; }) : undefined });
    await screen.findByLabelText("支付宝经营码内容"); edit("支付宝经营码内容", "https://qr.alipay.com/late");
    const user = userEvent.setup(); await user.click(screen.getByRole("button", { name: "保存并继续" }));
    await user.click(screen.getByRole("link", { name: "上一步" }));
    await user.click(await screen.findByRole("button", { name: "放弃修改并继续" }));
    await pathIs(view, "provider");
    await act(async () => { finish(json({ data: configuredThrough(3) })); });
    await pathIs(view, "provider");
  });
});
