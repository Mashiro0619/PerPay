import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  queryClient,
  refreshOperationalData,
  sessionKey,
  type OfficialUpdate,
} from "../src/api/client";
import { OfficialUpdatePanel, officialUpdateKey } from "../src/updates";
import { setUpdatePreferences } from "../src/lib/update-preferences";
import { restoreUpdateReminders } from "../src/lib/update-reminders";
import { toast } from "../src/components/ui/toast";
import { apiError, json } from "./fixtures";
import { mountOnboarding, systemStatus } from "./onboarding-fixture";

const update: OfficialUpdate = {
  status: "update_available",
  current_version: "0.2.0",
  latest_version: "0.2.1",
  release_url: "https://github.com/Mashiro0619/PerPay/releases/tag/v0.2.1",
  published_at: "2026-09-10T00:00:00Z",
  checked_at: "2026-09-10T01:00:00Z",
};
const isUpdate = (request: Request) =>
  new URL(request.url).pathname === "/api/admin/v1/system/update";
const preferencesKey = "perpay:update-preferences";
const sixHours = 6 * 60 * 60 * 1000;
const updateLinkName = /运行状态.*有更新/;
const updateIndicator = () => document.querySelector("[data-update-indicator]");
function preferences(automatic: boolean, channel = "prerelease") {
  localStorage.setItem(preferencesKey, JSON.stringify({ automatic, channel }));
  fireEvent(window, new StorageEvent("storage", { key: preferencesKey, newValue: localStorage.getItem(preferencesKey), storageArea: localStorage }));
}
beforeEach(() => {
  // This suite exercises checking and the compact strip; foreground dialog
  // behavior is covered separately in update-dialog.test.tsx.
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
  restoreUpdateReminders("stable");
  restoreUpdateReminders("prerelease");
  setUpdatePreferences({ automatic: true, channel: "prerelease" });
  localStorage.removeItem(preferencesKey);
  fireEvent(window, new StorageEvent("storage", { key: preferencesKey, newValue: null }));
});

afterEach(() => {
  delete document.documentElement.dataset.perpayDemo;
  vi.restoreAllMocks();
});
function mountPanel(handle: (request: Request) => Response | Promise<Response> = () => json({ data: update }), currentVersion = update.current_version, strict = false) {
  // The standalone panel has no AuthBoundary observer pinning the active session.
  queryClient.setDefaultOptions({ queries: { ...queryClient.getDefaultOptions().queries, gcTime: Infinity } });
  queryClient.setQueryData(sessionKey, { authenticated: true });
  const fetchMock = vi.fn(handle);
  vi.stubGlobal("fetch", fetchMock);
  const panel = <QueryClientProvider client={queryClient}><OfficialUpdatePanel currentVersion={currentVersion} /></QueryClientProvider>;
  const view = render(strict ? <StrictMode>{panel}</StrictMode> : panel);
  return { ...view, fetchMock };
}
async function advance(milliseconds = 10) {
  await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); });
}
const mount = (
  handle: (request: Request) => Response | Promise<Response> | undefined,
  path = "/settings/collection-policy",
  signedIn = true,
  currentVersion = update.current_version,
) => mountOnboarding({
  stage: 4,
  path,
  signedIn,
  handle,
  status: (settings) => ({ ...systemStatus(settings), version: currentVersion }),
});

async function editPolicy() {
  if (!screen.queryByLabelText("查账有效时限（秒）")) await userEvent.setup().click(await screen.findByRole("link", { name: /编辑/ }));
  return screen.findByLabelText("查账有效时限（秒）");
}

describe("automatic official update checks", () => {
  it("completes the initial automatic check under StrictMode effect replay", async () => {
    const view = mountPanel(() => json({ data: update }), update.current_version, true);
    expect(await screen.findByText("有可用更新：v0.2.1")).toBeVisible();
    expect(view.fetchMock.mock.calls.some(([request]) => !request.signal.aborted)).toBe(true);
    expect(screen.queryByText(/暂时无法检查更新/)).not.toBeInTheDocument();
  });

  it("keeps controls and installed version without timestamps or release detail copy", async () => {
    const view = mountPanel();
    await screen.findByText("有可用更新：v0.2.1");
    expect(screen.getByRole("switch", { name: "自动检查更新" })).toBeChecked();
    expect(screen.getByRole("combobox", { name: "检查通道" })).toHaveTextContent("包含预发布版");
    expect(new URL(view.fetchMock.mock.calls[0]![0].url).searchParams.get("channel")).toBe("prerelease");
    expect(screen.getByText("v0.2.0")).toBeVisible();
    expect(screen.queryByText(/上次检查时间|发布时间|官方稳定版|官方预发布版|备份数据库/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "发布信息" })).not.toBeInTheDocument();
    expect(screen.queryByText(/偏好仅作用于当前浏览器|不会自动安装|每 6 小时/)).not.toBeInTheDocument();
    const controls = screen.getByRole("group", { name: "更新检查设置" });
    expect(within(controls).getByRole("switch", { name: "自动检查更新" })).toBeVisible();
    expect(within(controls).getByRole("combobox", { name: "检查通道" })).toBeVisible();
    expect(within(controls).getByRole("button", { name: "检查更新" })).toBeVisible();
    expect(screen.queryByText("发布时间")).not.toBeInTheDocument();
  });

  it("offers exactly the stable and prerelease channels", async () => {
    mountPanel();
    await screen.findByText("有可用更新：v0.2.1");
    await userEvent.setup().click(screen.getByRole("combobox", { name: "检查通道" }));
    const options = await screen.findAllByRole("option");
    expect(options.map(option => option.textContent)).toEqual(["仅稳定版", "包含预发布版"]);
  });

  it("includes prereleases by default even when the installed version is stable", async () => {
    const latest = "0.3.0-rc.1";
    const view = mountPanel(() => json({ data: { ...update, latest_version: latest, release_url: `https://github.com/Mashiro0619/PerPay/releases/tag/v${latest}` } }));
    expect(await screen.findByText("有可用更新：v0.3.0-rc.1（预发布）")).toBeVisible();
    expect(new URL(view.fetchMock.mock.calls[0]![0].url).searchParams.get("channel")).toBe("prerelease");
  });

  it.each([
    ['{"automatic":false,"channel":"auto"}', "包含预发布版", false],
    ['{"automatic":false}', "包含预发布版", false],
    ['{"automatic":false,"channel":"unknown"}', "包含预发布版", false],
    ['{"automatic":false,"channel":"stable"}', "仅稳定版", false],
    ['{"channel":"auto"}', "包含预发布版", true],
    ['{invalid json', "包含预发布版", true],
  ] as const)("migrates stored preferences %s without losing a saved opt-out or stable selection", async (stored, label, automatic) => {
    localStorage.setItem(preferencesKey, stored);
    const view = mountPanel();
    expect(screen.getByRole("combobox", { name: "检查通道" })).toHaveTextContent(label);
    const toggle = screen.getByRole("switch", { name: "自动检查更新" });
    if (automatic) {
      expect(toggle).toBeChecked();
      await screen.findByText("有可用更新：v0.2.1");
      expect(new URL(view.fetchMock.mock.calls[0]![0].url).searchParams.get("channel")).toBe("prerelease");
    } else {
      expect(toggle).not.toBeChecked();
      expect(view.fetchMock).not.toHaveBeenCalled();
      await userEvent.setup().click(toggle);
      await screen.findByText("有可用更新：v0.2.1");
      const channel = label === "仅稳定版" ? "stable" : "prerelease";
      expect(new URL(view.fetchMock.mock.calls[0]![0].url).searchParams.get("channel")).toBe(channel);
      expect(JSON.parse(localStorage.getItem(preferencesKey)!)).toEqual({ automatic: true, channel });
    }
  });

  it("honors a saved opt-out while keeping manual checks available", async () => {
    preferences(false);
    const view = mountPanel();
    expect(screen.getByRole("switch", { name: "自动检查更新" })).not.toBeChecked();
    expect(within(screen.getByRole("region", { name: "官方更新" })).queryByRole("status")).not.toBeInTheDocument();
    expect(view.fetchMock).not.toHaveBeenCalled();
    await userEvent.setup().click(screen.getByRole("button", { name: "检查更新" }));
    await screen.findByText("有可用更新：v0.2.1");
    expect(view.fetchMock).toHaveBeenCalledTimes(1);
  });

  it("checks every six hours, pauses while hidden or offline, and catches up once", async () => {
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    const view = mountPanel();
    await advance();
    expect(view.fetchMock).toHaveBeenCalledTimes(1);
    await advance(sixHours);
    expect(view.fetchMock).toHaveBeenCalledTimes(2);
    visibility.mockReturnValue("hidden");
    act(() => fireEvent(document, new Event("visibilitychange")));
    await advance(sixHours * 2);
    expect(view.fetchMock).toHaveBeenCalledTimes(2);
    online.mockReturnValue(false);
    visibility.mockReturnValue("visible");
    act(() => fireEvent(document, new Event("visibilitychange")));
    await advance();
    expect(view.fetchMock).toHaveBeenCalledTimes(2);
    online.mockReturnValue(true);
    act(() => fireEvent(window, new Event("online")));
    await advance();
    expect(view.fetchMock).toHaveBeenCalledTimes(3);
    act(() => {
      fireEvent(document, new Event("visibilitychange"));
      fireEvent(window, new Event("online"));
    });
    await advance();
    expect(view.fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not start an initial check offline and cancels its timer on unmount", async () => {
    vi.useFakeTimers();
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const view = mountPanel();
    await advance(sixHours);
    expect(view.fetchMock).not.toHaveBeenCalled();
    online.mockReturnValue(true);
    act(() => fireEvent(window, new Event("online")));
    await advance();
    expect(view.fetchMock).toHaveBeenCalledTimes(1);
    view.unmount();
    await advance(sixHours * 2);
    act(() => fireEvent(window, new Event("online")));
    expect(view.fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops scheduled checks after opt-out even across visibility and network changes", async () => {
    vi.useFakeTimers();
    const view = mountPanel();
    await advance();
    act(() => fireEvent.click(screen.getByRole("switch", { name: "自动检查更新" })));
    expect(screen.getByRole("switch", { name: "自动检查更新" })).not.toBeChecked();
    await advance(sixHours * 2);
    act(() => {
      fireEvent(document, new Event("visibilitychange"));
      fireEvent(window, new Event("online"));
    });
    await advance();
    expect(view.fetchMock).toHaveBeenCalledTimes(1);
    act(() => fireEvent.click(screen.getByRole("button", { name: "检查更新" })));
    await advance();
    expect(view.fetchMock).toHaveBeenCalledTimes(2);
    await advance(sixHours);
    expect(view.fetchMock).toHaveBeenCalledTimes(2);
  });

  it("honors long Retry-After for both automatic and manual checks without a background alert", async () => {
    vi.useFakeTimers();
    const view = mountPanel(() => json({ error: { code: "update_check_unavailable", message: "failed" } }, 503, { "Retry-After": "28800" }));
    await advance();
    expect(view.fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "检查更新" })).toBeDisabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await advance(sixHours);
    expect(view.fetchMock).toHaveBeenCalledTimes(1);
    await advance(2 * 60 * 60 * 1000 + 10);
    expect(view.fetchMock).toHaveBeenCalledTimes(2);
  });

  it("synchronizes browser preferences, separates channel results, and waits for manual checks when disabled", async () => {
    const view = mountPanel();
    await screen.findByText("有可用更新：v0.2.1");
    act(() => preferences(false, "stable"));
    expect(screen.getByRole("switch", { name: "自动检查更新" })).not.toBeChecked();
    expect(screen.getByRole("combobox", { name: "检查通道" })).toHaveTextContent("仅稳定版");
    expect(screen.queryByText("有可用更新：v0.2.1")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "查看发布说明" })).not.toBeInTheDocument();
    expect(view.fetchMock).toHaveBeenCalledTimes(1);
    await userEvent.setup().click(screen.getByRole("button", { name: "检查更新" }));
    await screen.findByText("有可用更新：v0.2.1");
    expect(new URL(view.fetchMock.mock.calls[1]![0].url).searchParams.get("channel")).toBe("stable");
    act(() => preferences(true, "prerelease"));
    await waitFor(() => expect(view.fetchMock).toHaveBeenCalledTimes(3));
    expect(new URL(view.fetchMock.mock.calls[2]![0].url).searchParams.get("channel")).toBe("prerelease");
  });

  it("aborts a previous channel request and never flashes its late result or a cached result after switching back", async () => {
    let finishOld!: (response: Response) => void;
    let oldRequest: Request | undefined;
    const stable = { ...update, latest_version: "0.2.2", release_url: "https://github.com/Mashiro0619/PerPay/releases/tag/v0.2.2" };
    const view = mountPanel((request) => {
      if (new URL(request.url).searchParams.get("channel") === "stable") return json({ data: stable });
      oldRequest = request;
      return new Promise<Response>((resolve) => { finishOld = resolve; });
    });
    await waitFor(() => expect(oldRequest).toBeDefined());
    act(() => preferences(true, "stable"));
    await screen.findByText("有可用更新：v0.2.2");
    expect(oldRequest?.signal.aborted).toBe(true);
    await act(async () => { finishOld(json({ data: update })); });
    expect(screen.queryByText("有可用更新：v0.2.1")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "查看发布说明" })).toHaveAttribute("href", stable.release_url);
    act(() => preferences(false, "prerelease"));
    expect(screen.queryByRole("link", { name: "查看发布说明" })).not.toBeInTheDocument();
    act(() => preferences(false, "stable"));
    expect(screen.queryByRole("link", { name: "查看发布说明" })).not.toBeInTheDocument();
    expect(screen.queryByText("有可用更新：v0.2.2")).not.toBeInTheDocument();
    expect(view.fetchMock).toHaveBeenCalledTimes(2);
  });

  it("responds to storage clearing and ignores preferences in another storage area", async () => {
    preferences(false, "stable");
    const view = mountPanel();
    act(() => fireEvent(window, new StorageEvent("storage", { key: preferencesKey, newValue: JSON.stringify({ automatic: true, channel: "prerelease" }), storageArea: sessionStorage })));
    expect(screen.getByRole("switch", { name: "自动检查更新" })).not.toBeChecked();
    expect(screen.getByRole("combobox", { name: "检查通道" })).toHaveTextContent("仅稳定版");
    expect(view.fetchMock).not.toHaveBeenCalled();
    act(() => {
      localStorage.removeItem(preferencesKey);
      fireEvent(window, new StorageEvent("storage", { key: null, newValue: null, storageArea: localStorage }));
    });
    await screen.findByText("有可用更新：v0.2.1");
    expect(screen.getByRole("switch", { name: "自动检查更新" })).toBeChecked();
    expect(screen.getByRole("combobox", { name: "检查通道" })).toHaveTextContent("包含预发布版");
    expect(view.fetchMock).toHaveBeenCalledTimes(1);
  });

  it("persists controls across remounts and tolerates malformed stored values", async () => {
    localStorage.setItem(preferencesKey, '{"automatic":"no","channel":"unknown"}');
    const view = mountPanel();
    await screen.findByText("有可用更新：v0.2.1");
    const user = userEvent.setup();
    await user.click(screen.getByRole("switch", { name: "自动检查更新" }));
    await user.click(screen.getByRole("combobox", { name: "检查通道" }));
    await user.click(await screen.findByRole("option", { name: "仅稳定版" }));
    expect(JSON.parse(localStorage.getItem(preferencesKey)!)).toEqual({ automatic: false, channel: "stable" });
    view.unmount();
    const next = mountPanel();
    expect(screen.getByRole("switch", { name: "自动检查更新" })).not.toBeChecked();
    expect(screen.getByRole("combobox", { name: "检查通道" })).toHaveTextContent("仅稳定版");
    expect(next.fetchMock).not.toHaveBeenCalled();
  });

  it("retains functional in-memory preferences when browser storage is unavailable", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    const view = mountPanel();
    await screen.findByText("有可用更新：v0.2.1");
    const user = userEvent.setup();
    await user.click(screen.getByRole("switch", { name: "自动检查更新" }));
    await user.click(screen.getByRole("combobox", { name: "检查通道" }));
    await user.click(await screen.findByRole("option", { name: "仅稳定版" }));
    expect(screen.getByRole("switch", { name: "自动检查更新" })).not.toBeChecked();
    expect(screen.getByRole("combobox", { name: "检查通道" })).toHaveTextContent("仅稳定版");
    expect(view.fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses the same automatic and manual update checks in a preview without mode-specific copy", async () => {
    document.documentElement.dataset.perpayDemo = "readonly";
    const view = mountPanel();
    await screen.findByText("有可用更新：v0.2.1");
    expect(view.fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/演示模式|只读|未连接官方更新服务/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "检查更新" })).toBeEnabled();
    expect(screen.queryByText("上次检查时间")).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("switch", { name: "自动检查更新" }));
    await user.click(screen.getByRole("combobox", { name: "检查通道" }));
    await user.click(await screen.findByRole("option", { name: "仅稳定版" }));
    expect(screen.getByRole("combobox", { name: "检查通道" })).toHaveTextContent("仅稳定版");
    expect(view.fetchMock).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "检查更新" }));
    await screen.findByText("有可用更新：v0.2.1");
    expect(view.fetchMock).toHaveBeenCalledTimes(2);
    expect(new URL(view.fetchMock.mock.calls[1]![0].url).searchParams.get("channel")).toBe("stable");
    expect(screen.queryByText(/暂时无法检查更新/)).not.toBeInTheDocument();
  });

  it("shows real update failures in a preview without replacing them with a mode message", async () => {
    document.documentElement.dataset.perpayDemo = "readonly";
    mountPanel(() => apiError("update_check_unavailable", "更新服务暂不可用", 503));
    await screen.findByText("更新服务暂不可用");
    expect(screen.queryByText(/演示模式|只读|未连接官方更新服务/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "检查更新" })).toBeEnabled();
  });

  it.each([["stable", "0.3.0-rc.1"], ["prerelease", "0.3.0"]])("validates explicit %s independently of current version %s", async (channel, current) => {
    preferences(true, channel);
    const latest = "0.4.0-rc.1";
    mountPanel(() => json({ data: { ...update, current_version: current, latest_version: latest, release_url: `https://github.com/Mashiro0619/PerPay/releases/tag/v${latest}` } }), current);
    if (channel === "stable") {
      await screen.findByText(/暂时无法检查更新/);
      expect(screen.queryByRole("link", { name: "查看发布说明" })).not.toBeInTheDocument();
    } else {
      expect(await screen.findByText("有可用更新：v0.4.0-rc.1（预发布）")).toBeVisible();
    }
  });

  it("checks only after successful login, never on the login screen or rejected login", async () => {
    let rejectLogin = true;
    const view = mount(
      (request) =>
        isUpdate(request)
          ? json({ data: update })
          : request.url.endsWith("/session/login") && rejectLogin
            ? apiError("invalid_credentials", "密码错误", 401)
            : undefined,
      "/settings/collection-policy",
      false,
    );
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "登录管理后台" });
    expect(
      view.fetchMock.mock.calls.filter(([request]) => isUpdate(request)),
    ).toHaveLength(0);
    await user.type(screen.getByLabelText("管理员密码"), "password");
    await user.click(screen.getByRole("button", { name: "登录" }));
    await screen.findByText("管理员密码不正确，请检查后重试。");
    expect(
      view.fetchMock.mock.calls.filter(([request]) => isUpdate(request)),
    ).toHaveLength(0);
    rejectLogin = false;
    await user.click(screen.getByRole("button", { name: "登录" }));
    const link = await screen.findByRole("link", { name: updateLinkName });
    expect(within(screen.getByRole("navigation", { name: "全局管理" })).getByRole("link", { name: updateLinkName })).toBe(link);
    expect(within(link).getByText("运行状态")).toBeVisible();
    expect(link.querySelector("[data-update-indicator]")).toBeVisible();
    expect(link).not.toHaveTextContent("有更新");
    expect(screen.queryByRole("status", { name: "官方版本更新" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "忽略此版本" })).not.toBeInTheDocument();
    expect(
      view.fetchMock.mock.calls.filter(([request]) => isUpdate(request)),
    ).toHaveLength(1);
    expect(await editPolicy()).toBeVisible();
    expect(
      view.writes().every((request) => request.url.endsWith("/session/login")),
    ).toBe(true);
  });

  it("does not recheck when navigating, saving settings, refocusing, or reconnecting", async () => {
    const view = mount((request) =>
      isUpdate(request) ? json({ data: update }) : undefined,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole("link", { name: updateLinkName }));
    await screen.findByRole("heading", { name: "官方更新" });
    await screen.findByText("有可用更新：v0.2.1");
    const panel = within(screen.getByRole("region", { name: "官方更新" }));
    expect(panel.getByText("当前版本")).toBeVisible();
    expect(panel.getByText("v0.2.0")).toBeVisible();
    expect(panel.queryByText("发布时间")).not.toBeInTheDocument();
    expect(panel.queryByRole("button", { name: "发布信息" })).not.toBeInTheDocument();
    expect(panel.queryByText(/上次检查时间|官方稳定版|备份数据库/)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "更新方法" })).toHaveAttribute(
      "rel",
      "noopener noreferrer",
    );
    expect(
      screen.queryByRole("status", { name: "官方版本更新" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: updateLinkName })).toBeVisible();
    await act(async () => {
      fireEvent(window, new Event("focus"));
      fireEvent(window, new Event("online"));
      await refreshOperationalData();
    });
    expect(
      view.fetchMock.mock.calls.filter(([request]) => isUpdate(request)),
    ).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "检查更新" }));
    await waitFor(() =>
      expect(
        view.fetchMock.mock.calls.filter(([request]) => isUpdate(request)),
      ).toHaveLength(2),
    );
    expect(view.writes()).toHaveLength(0);
  });

  it("ignores a version from runtime status, retains it after login, and restores its sidebar indicator", async () => {
    const view = mount((request) =>
      isUpdate(request) ? json({ data: update }) : undefined,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole("link", { name: updateLinkName }));
    const panel = within(await screen.findByRole("region", { name: "官方更新" }));
    await user.click(panel.getByRole("button", { name: "忽略此版本" }));
    expect(screen.queryByRole("link", { name: updateLinkName })).not.toBeInTheDocument();
    expect(updateIndicator()).not.toBeInTheDocument();
    expect(within(screen.getByRole("navigation", { name: "全局管理" })).getByRole("link", { name: "运行状态" })).toBeVisible();
    expect(panel.queryByRole("button", { name: "忽略此版本" })).not.toBeInTheDocument();
    expect(panel.getByRole("status")).toHaveTextContent("有可用更新：v0.2.1（已忽略）");
    expect(panel.getByRole("button", { name: "恢复此通道更新提醒" })).toBeVisible();
    expect(panel.getByRole("button", { name: "恢复此通道更新提醒" })).toHaveFocus();
    expect(panel.getByRole("button", { name: "查看更新" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: /账户菜单$/ }));
    await user.click(await screen.findByRole("menuitem", { name: "退出登录" }));
    await screen.findByRole("heading", { name: "登录管理后台" });
    expect(queryClient.getQueryData(officialUpdateKey)).toBeUndefined();
    await user.type(screen.getByLabelText("管理员密码"), "password");
    await user.click(screen.getByRole("button", { name: "登录" }));
    await waitFor(() => expect(
      view.fetchMock.mock.calls.filter(([request]) => isUpdate(request)),
    ).toHaveLength(2));
    expect(screen.queryByRole("status", { name: "官方版本更新" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: updateLinkName })).not.toBeInTheDocument();
    expect(updateIndicator()).not.toBeInTheDocument();
    await user.click(within(screen.getByRole("navigation", { name: "全局管理" })).getByRole("link", { name: "运行状态" }));
    const restoredPanel = within(await screen.findByRole("region", { name: "官方更新" }));
    await user.click(restoredPanel.getByRole("button", { name: "恢复此通道更新提醒" }));
    expect(await screen.findByRole("link", { name: updateLinkName })).toBeVisible();
    expect(updateIndicator()).toBeVisible();
    expect(screen.getByRole("link", { name: updateLinkName })).not.toHaveTextContent("有更新");
    expect(restoredPanel.getByRole("button", { name: "忽略此版本" })).toBeVisible();
    expect(restoredPanel.getByRole("button", { name: "忽略此版本" })).toHaveFocus();
    expect(restoredPanel.queryByRole("button", { name: "恢复此通道更新提醒" })).not.toBeInTheDocument();
    expect(view.fetchMock.mock.calls.filter(([request]) => isUpdate(request))).toHaveLength(2);
  });

  it("does not block navigation or editing while an update check is pending", async () => {
    let finish!: (response: Response) => void;
    mount((request) =>
      isUpdate(request)
        ? new Promise<Response>((resolve) => {
            finish = resolve;
          })
        : undefined,
    );
    const user = userEvent.setup();
    const ttl = await editPolicy();
    await user.clear(ttl);
    await user.type(ttl, "450");
    expect(ttl).toHaveValue(450);
    await act(async () => {
      finish(json({ data: update }));
    });
    await screen.findByRole("link", { name: updateLinkName, hidden: true });
    expect(screen.getByLabelText("查账有效时限（秒）")).toBe(ttl);
    expect(ttl).toHaveValue(450);
    expect(screen.queryByRole("dialog", { name: "发现新版本" })).not.toBeInTheDocument();
    act(() => preferences(true, "stable"));
    expect(screen.getByLabelText("查账有效时限（秒）")).toBe(ttl);
    expect(ttl).toHaveValue(450);
    await act(async () => { finish(json({ data: update })); });
    expect(screen.getByLabelText("查账有效时限（秒）")).toBe(ttl);
    expect(ttl).toHaveValue(450);
  });

  it("keeps the sidebar reminder and runtime ignore state scoped to the selected channel", async () => {
    const view = mount(request => isUpdate(request) ? json({ data: update }) : undefined, "/system");
    const user = userEvent.setup();
    await screen.findByRole("link", { name: updateLinkName });
    const panel = within(screen.getByRole("region", { name: "官方更新" }));
    await user.click(panel.getByRole("button", { name: "忽略此版本" }));
    expect(screen.queryByRole("link", { name: updateLinkName })).not.toBeInTheDocument();
    expect(updateIndicator()).not.toBeInTheDocument();
    act(() => preferences(true, "stable"));
    expect(await screen.findByRole("link", { name: updateLinkName })).toBeVisible();
    expect(updateIndicator()).toBeVisible();
    expect(panel.queryByText(/已忽略/)).not.toBeInTheDocument();
    expect(panel.getByRole("button", { name: "忽略此版本" })).toBeVisible();
    expect(panel.queryByRole("button", { name: "恢复此通道更新提醒" })).not.toBeInTheDocument();
    act(() => preferences(true, "prerelease"));
    expect(await panel.findByText("有可用更新：v0.2.1（已忽略）")).toBeVisible();
    expect(screen.queryByRole("link", { name: updateLinkName })).not.toBeInTheDocument();
    expect(updateIndicator()).not.toBeInTheDocument();
    expect(panel.queryByRole("button", { name: "忽略此版本" })).not.toBeInTheDocument();
    expect(panel.getByRole("button", { name: "恢复此通道更新提醒" })).toBeVisible();
    expect(view.fetchMock.mock.calls.filter(([request]) => isUpdate(request))).toHaveLength(3);
  });

  it.each([
    ["network", null, null],
    ["server", 300, "5 分钟"],
    ["server", 3600, "1 小时"],
    ["server", 301, "301 秒"],
  ] as const)(
    "keeps an update %s failure non-blocking and never silently retries (%s seconds)",
    async (failure, retryAfter, waitText) => {
      const view = mount((request) =>
        isUpdate(request)
          ? failure === "network"
            ? Promise.reject(new TypeError("offline"))
            : json(
                { error: { code: "update_check_unavailable", message: "更新检查失败" } },
                503,
                { "Retry-After": String(retryAfter) },
              )
          : undefined,
      );
      const ttl = await editPolicy();
      await waitFor(() =>
        expect(queryClient.getQueryState(officialUpdateKey)?.status).toBe(
          "error",
        ),
      );
      expect(ttl).toBeVisible();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("status", { name: "官方版本更新" }),
      ).not.toBeInTheDocument();
      expect(screen.queryByRole("link", { name: updateLinkName })).not.toBeInTheDocument();
      await act(async () => {
        fireEvent(window, new Event("focus"));
        fireEvent(window, new Event("online"));
      });
      expect(
        view.fetchMock.mock.calls.filter(([request]) => isUpdate(request)),
      ).toHaveLength(1);
      await userEvent.setup().click(screen.getByRole("button", { name: "关闭对话框" }));
      await userEvent
        .setup()
        .click(screen.getByRole("link", { name: "运行状态" }));
      expect(
        await screen.findByText(failure === "network" ? "无法连接服务，请检查网络后重试。" : "更新检查失败"),
      ).toBeVisible();
      const panel = within(screen.getByRole("region", { name: "官方更新" }));
      expect(await panel.findByText("v0.2.0")).toBeVisible();
      expect(panel.queryByRole("link", { name: "查看发布说明" })).not.toBeInTheDocument();
      if (waitText !== null) {
        expect(panel.getByText(`请至少等待 ${waitText}后重试。`)).toBeVisible();
        expect(panel.getByRole("button", { name: "检查更新" })).toBeDisabled();
      }
      expect(
        view.fetchMock.mock.calls.filter(([request]) => isUpdate(request)),
      ).toHaveLength(1);
    },
  );

  it("clears pending checks on session expiry and never restores their old result", async () => {
    let finish!: (response: Response) => void;
    let oldRequest: Request | undefined;
    mount((request) =>
      isUpdate(request)
        ? new Promise<Response>((resolve) => {
            oldRequest = request;
            finish = resolve;
          })
        : undefined,
    );
    await editPolicy();
    await waitFor(() => expect(oldRequest).toBeDefined());
    fireEvent(window, new Event("perpay:session-expired"));
    await screen.findByRole("heading", { name: "登录管理后台" });
    expect(oldRequest?.signal.aborted).toBe(true);
    await act(async () => {
      finish(json({ data: update }));
    });
    expect(queryClient.getQueryData(officialUpdateKey)).toBeUndefined();
    expect(queryClient.getQueryData(sessionKey)).toBeNull();
    expect(
      screen.queryByRole("status", { name: "官方版本更新" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: updateLinkName })).not.toBeInTheDocument();
  });

  it("hides stale release links while refreshing and after a failed manual check", async () => {
    let finish!: (response: Response) => void;
    let calls = 0;
    mount(
      (request) =>
        isUpdate(request)
          ? ++calls === 1
            ? json({ data: update })
            : new Promise<Response>((resolve) => {
                finish = resolve;
              })
          : undefined,
      "/system",
    );
    await screen.findByRole("link", { name: "查看发布说明" });
    expect(screen.getByRole("link", { name: updateLinkName })).toBeVisible();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "检查更新" }));
    await screen.findByText("正在检查更新…");
    expect(screen.queryByRole("link", { name: updateLinkName })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "查看发布说明" })).not.toBeInTheDocument();
    await act(async () => {
      finish(apiError("update_check_unavailable", "failed", 503));
    });
    expect(
      await screen.findByText("暂时无法检查官方更新，请稍后重试。此检查不影响收款。"),
    ).toBeVisible();
    expect(screen.queryByRole("link", { name: updateLinkName })).not.toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "官方更新" })).getByText("v0.2.0")).toBeVisible();
    expect(screen.queryByText("已是当前通道最新版本。")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "查看发布说明" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "运行状态" })).toBeVisible();
    expect(screen.queryByText("上次检查时间")).not.toBeInTheDocument();
  });

  it.each([
    ["up_to_date", "stable"],
    ["ahead", "stable"],
    ["up_to_date", "prerelease"],
    ["ahead", "prerelease"],
  ] as const)(
    "does not add permanent status copy for %s on %s while retaining links and controls",
    async (status, channel) => {
      preferences(true, channel);
      mount(
        (request) =>
          isUpdate(request) ? json({ data: { ...update, status } }) : undefined,
        "/system",
      );
      await screen.findByRole("link", { name: "查看发布说明" });
      const panel = within(screen.getByRole("region", { name: "官方更新" }));
      expect(panel.queryByRole("status")).not.toBeInTheDocument();
      expect(panel.getByText("v0.2.0")).toBeVisible();
      expect(panel.getByRole("button", { name: "检查更新" })).toBeEnabled();
      expect(
        screen.queryByRole("status", { name: "官方版本更新" }),
      ).not.toBeInTheDocument();
      expect(screen.queryByRole("link", { name: updateLinkName })).not.toBeInTheDocument();
      expect(
        screen.getByRole("link", { name: "查看发布说明" }),
      ).toHaveAttribute("href", update.release_url);
    },
  );

  it.each([
    "javascript:alert(1)",
    "https://github.com/other/project/releases/tag/v0.2.1",
  ])("refuses unexpected release links (%s)", async (releaseUrl) => {
    mount(
      (request) =>
        isUpdate(request)
          ? json({ data: { ...update, release_url: releaseUrl } })
          : undefined,
      "/system",
    );
    await screen.findByText(/暂时无法检查更新/);
    expect(
      screen.queryByRole("link", { name: "查看发布说明" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("status", { name: "官方版本更新" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: updateLinkName })).not.toBeInTheDocument();
  });
  it.each([
    ["0.3.0-rc.2", "0.3.0-rc.10", "update_available", "有可用更新：v0.3.0-rc.10（预发布）"],
    ["0.3.0-rc.2", "0.3.0", "update_available", "有可用更新：v0.3.0"],
    ["0.3.0-rc.2", "0.3.0-rc.2", "up_to_date", null],
    ["0.3.0-rc.2", "0.3.0-rc.1", "ahead", null],
  ] as const)("displays %s -> %s with the correct channel semantics", async (current, latest, status, message) => {
    const prereleaseUpdate: OfficialUpdate = {
      ...update, current_version: current, latest_version: latest, status,
      release_url: "https://github.com/Mashiro0619/PerPay/releases/tag/v" + latest,
    };
    const view = mount(request => isUpdate(request) ? json({ data: prereleaseUpdate }) : undefined, "/system", true, current);
    await screen.findByRole("link", { name: "查看发布说明" });
    const panel = within(screen.getByRole("region", { name: "官方更新" }));
    if (message) expect(panel.getByText(message)).toBeVisible();
    else expect(panel.queryByRole("status")).not.toBeInTheDocument();
    expect(panel.getByText("当前版本")).toBeVisible();
    expect(panel.getByText("（预发布）", { exact: true })).toBeVisible();
    expect(panel.queryByRole("button", { name: "发布信息" })).not.toBeInTheDocument();
    expect(panel.queryByText("发布时间")).not.toBeInTheDocument();
    expect(panel.queryByText("当前使用预发布版本，同时检查正式版和预发布版。")).not.toBeInTheDocument();
    expect(panel.getByRole("combobox", { name: "检查通道" })).toHaveTextContent("包含预发布版");
    expect(panel.queryByText(/官方预发布版|官方稳定版/)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "查看发布说明" })).toHaveAttribute("href", prereleaseUpdate.release_url);
    expect(view.fetchMock.mock.calls.filter(([request]) => isUpdate(request))).toHaveLength(1);
  });

  it("marks a prerelease update only in the runtime navigation while settings remain usable", async () => {
    mount(request => isUpdate(request) ? json({ data: {
      ...update, current_version: "0.3.0-alpha.1", latest_version: "0.3.0-rc.1",
      release_url: "https://github.com/Mashiro0619/PerPay/releases/tag/v0.3.0-rc.1",
    } }) : undefined);
    expect(await screen.findByRole("link", { name: updateLinkName })).toBeVisible();
    expect(screen.queryByRole("status", { name: "官方版本更新" })).not.toBeInTheDocument();
    expect(screen.queryByText(/有新版本 v/)).not.toBeInTheDocument();
    await editPolicy();
    expect(screen.getByLabelText("查账有效时限（秒）")).toBeVisible();
  });

  it.each([
    ["0.3.0", "0.4.0-alpha.1", "stable"],
    ["0.3.0-rc.01", "0.3.0", "prerelease"],
    ["0.3.0-alpha.1", "0.3.0-rc.01", "prerelease"],
  ])("rejects invalid or cross-channel update data %s -> %s on %s", async (current, latest, channel) => {
    preferences(true, channel);
    mount(request => isUpdate(request) ? json({ data: {
      ...update, current_version: current, latest_version: latest,
      release_url: "https://github.com/Mashiro0619/PerPay/releases/tag/v" + latest,
    } }) : undefined, "/system");
    await screen.findByText(/暂时无法检查更新/);
    expect(screen.queryByRole("link", { name: "查看发布说明" })).not.toBeInTheDocument();
  });

});

describe("manual official update refresh", () => {
  it.each([
    ["up_to_date", "0.2.0", "已是当前通道最新版本。", "success"],
    ["ahead", "0.1.9", "当前版本高于此通道最新发布版本。", "info"],
  ] as const)("keeps automatic %s checks quiet and gives one result for an explicit refresh", async (status, latest, title, type) => {
    const notices = vi.spyOn(toast, "add");
    const data = { ...update, status, latest_version: latest, release_url: `https://github.com/Mashiro0619/PerPay/releases/tag/v${latest}` };
    const view = mountPanel(() => json({ data }));
    await screen.findByRole("link", { name: "查看发布说明" });
    expect(view.fetchMock).toHaveBeenCalledTimes(1);
    expect(new URL(view.fetchMock.mock.calls[0]![0].url).searchParams.has("refresh")).toBe(false);
    expect(notices).not.toHaveBeenCalled();

    const button = screen.getByRole("button", { name: "检查更新" });
    act(() => { fireEvent.click(button); fireEvent.click(button); });
    await waitFor(() => expect(notices).toHaveBeenCalledTimes(1));
    expect(view.fetchMock).toHaveBeenCalledTimes(2);
    expect(new URL(view.fetchMock.mock.calls[1]![0].url).searchParams.get("refresh")).toBe("true");
    expect(notices).toHaveBeenLastCalledWith(expect.objectContaining({ title, type, timeout: 4000 }));
    await act(async () => {
      fireEvent(window, new Event("focus"));
      fireEvent(window, new Event("online"));
      await refreshOperationalData();
    });
    expect(notices).toHaveBeenCalledTimes(1);
    expect(view.fetchMock).toHaveBeenCalledTimes(2);
  });

  it("disables manual checks for the server's successful-refresh interval without queuing a retry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-31T03:00:00Z"));
    preferences(false);
    const data = { ...update, status: "up_to_date", latest_version: update.current_version,
      release_url: `https://github.com/Mashiro0619/PerPay/releases/tag/v${update.current_version}` };
    const view = mountPanel(() => json({ data }, 200, { "X-PerPay-Update-Refresh-After": "60" }));
    const button = screen.getByRole("button", { name: "检查更新" });
    act(() => fireEvent.click(button));
    await advance(0);
    expect(view.fetchMock).toHaveBeenCalledTimes(1);
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription("请至少等待 1 分钟后重试。");
    expect(screen.getByText("请至少等待 1 分钟后重试。").closest('[role="status"]')).toBeNull();

    await advance(59_999);
    expect(button).toBeDisabled();
    act(() => fireEvent.click(button));
    expect(view.fetchMock).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(button).toBeEnabled();
    expect(view.fetchMock).toHaveBeenCalledTimes(1);
    act(() => fireEvent.click(button));
    await advance(0);
    expect(view.fetchMock).toHaveBeenCalledTimes(2);
    expect(view.fetchMock.mock.calls.every(([request]) => new URL(request.url).searchParams.get("refresh") === "true")).toBe(true);
    expect(button).toBeDisabled();
  });

  it("retains the successful result after a local 429 and keeps the original six-hour deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-31T03:00:00Z"));
    const startedAt = Date.now();
    const notices = vi.spyOn(toast, "add");
    const view = mountPanel(request => new URL(request.url).searchParams.get("refresh") === "true"
      ? json({ error: { code: "update_check_rate_limited", message: "刚刚检查过官方更新，请等待后重试。" } }, 429, { "Retry-After": "30" })
      : json({ data: { ...update, checked_at: new Date(Date.now()).toISOString() } }));
    await advance(0);
    const previous = queryClient.getQueryData(officialUpdateKey);
    expect(previous).toBeDefined();
    expect(view.fetchMock).toHaveBeenCalledTimes(1);
    await advance(sixHours - 60_000);
    act(() => fireEvent.click(screen.getByRole("button", { name: "检查更新" })));
    await advance(0);
    expect(view.fetchMock).toHaveBeenCalledTimes(2);
    expect(queryClient.getQueryData(officialUpdateKey)).toBe(previous);
    expect(screen.getByRole("button", { name: "检查更新" })).toBeDisabled();
    expect(notices).not.toHaveBeenCalled();

    await advance(startedAt + sixHours - Date.now() - 1);
    expect(view.fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "检查更新" })).toBeEnabled();
    await advance(1);
    expect(view.fetchMock).toHaveBeenCalledTimes(3);
    expect(new URL(view.fetchMock.mock.calls[2]![0].url).searchParams.has("refresh")).toBe(false);
    expect(notices).not.toHaveBeenCalled();
  });

  it.each(["up_to_date", "update_available"] as const)(
    "drops a late manual %s result after a channel switch and after session expiry", async (status) => {
      preferences(false);
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      const notices = vi.spyOn(toast, "add");
      const pending: { request: Request; finish: (response: Response) => void }[] = [];
      mount(request => isUpdate(request)
        ? new Promise<Response>(finish => { pending.push({ request, finish }); })
        : undefined, "/system");
      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: "检查更新" }));
      await waitFor(() => expect(pending).toHaveLength(1));
      expect(new URL(pending[0]!.request.url).searchParams.get("refresh")).toBe("true");
      act(() => preferences(false, "stable"));
      expect(pending[0]!.request.signal.aborted).toBe(true);
      await user.click(screen.getByRole("button", { name: "检查更新" }));
      await waitFor(() => expect(pending).toHaveLength(2));
      expect(new URL(pending[1]!.request.url).searchParams.get("channel")).toBe("stable");
      const latest = status === "update_available" ? "9.0.0" : update.current_version;
      const data = { ...update, status, latest_version: latest,
        release_url: `https://github.com/Mashiro0619/PerPay/releases/tag/v${latest}` };
      await act(async () => { pending[0]!.finish(json({ data }, 200, { "X-PerPay-Update-Refresh-After": "60" })); });
      expect(notices).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog", { name: "发现新版本" })).not.toBeInTheDocument();
      act(() => fireEvent(window, new Event("perpay:session-expired")));
      await screen.findByRole("heading", { name: "登录管理后台" });
      expect(pending[1]!.request.signal.aborted).toBe(true);
      await act(async () => { pending[1]!.finish(json({ data }, 200, { "X-PerPay-Update-Refresh-After": "60" })); });
      expect(notices).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog", { name: "发现新版本" })).not.toBeInTheDocument();
      expect(queryClient.getQueryData(officialUpdateKey)).toBeUndefined();
      expect(queryClient.getQueryData(["official-update", "stable"])).toBeUndefined();
      expect(queryClient.getQueryData(sessionKey)).toBeNull();
    },
  );
});
