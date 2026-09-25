import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import {
  queryClient,
  refreshOperationalData,
  sessionKey,
  type OfficialUpdate,
} from "../src/api/client";
import { officialUpdateKey } from "../src/updates";
import { apiError, json } from "./fixtures";
import { mountOnboarding } from "./onboarding-fixture";

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
const mount = (
  handle: (request: Request) => Response | Promise<Response> | undefined,
  path = "/settings/collection",
  signedIn = true,
) => mountOnboarding({ stage: 4, path, signedIn, handle });

describe("automatic official update checks", () => {
  it("checks only after successful login, never on the login screen or rejected login", async () => {
    let rejectLogin = true;
    const view = mount(
      (request) =>
        isUpdate(request)
          ? json({ data: update })
          : request.url.endsWith("/session/login") && rejectLogin
            ? apiError("invalid_credentials", "密码错误", 401)
            : undefined,
      "/settings/collection",
      false,
    );
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "登录管理后台" });
    expect(
      view.fetchMock.mock.calls.filter(([request]) => isUpdate(request)),
    ).toHaveLength(0);
    await user.type(screen.getByLabelText("管理员密码"), "password");
    await user.click(screen.getByRole("button", { name: "登录" }));
    await screen.findByText("密码错误");
    expect(
      view.fetchMock.mock.calls.filter(([request]) => isUpdate(request)),
    ).toHaveLength(0);
    rejectLogin = false;
    await user.click(screen.getByRole("button", { name: "登录" }));
    const notice = await screen.findByRole("status", { name: "官方版本更新" });
    expect(notice).toHaveTextContent("有新版本 v0.2.1");
    expect(
      within(notice).getByRole("link", { name: "查看更新" }),
    ).toHaveAttribute("href", update.release_url);
    expect(within(notice).getByRole("link")).toHaveAttribute(
      "rel",
      "noopener noreferrer",
    );
    expect(
      view.fetchMock.mock.calls.filter(([request]) => isUpdate(request)),
    ).toHaveLength(1);
    expect(await screen.findByLabelText("收银台有效期（秒）")).toBeVisible();
    expect(
      view.writes().every((request) => request.url.endsWith("/session/login")),
    ).toBe(true);
  });

  it("does not recheck when navigating, saving settings, refocusing, or reconnecting", async () => {
    const view = mount((request) =>
      isUpdate(request) ? json({ data: update }) : undefined,
    );
    const user = userEvent.setup();
    await screen.findByRole("status", { name: "官方版本更新" });
    await user.click(screen.getByRole("link", { name: "运行状态" }));
    await screen.findByRole("heading", { name: "官方更新" });
    await screen.findByText("有可用更新：v0.2.1");
    expect(
      screen.queryByRole("status", { name: "官方版本更新" }),
    ).not.toBeInTheDocument();
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

  it("dismisses for this login only and checks again after logout and login", async () => {
    const view = mount((request) =>
      isUpdate(request) ? json({ data: update }) : undefined,
    );
    const user = userEvent.setup();
    await screen.findByRole("status", { name: "官方版本更新" });
    await user.click(screen.getByRole("button", { name: "关闭更新提示" }));
    expect(
      screen.queryByRole("status", { name: "官方版本更新" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "账户菜单" }));
    await user.click(await screen.findByRole("menuitem", { name: "退出登录" }));
    await screen.findByRole("heading", { name: "登录管理后台" });
    expect(queryClient.getQueryData(officialUpdateKey)).toBeUndefined();
    await user.type(screen.getByLabelText("管理员密码"), "password");
    await user.click(screen.getByRole("button", { name: "登录" }));
    await screen.findByRole("status", { name: "官方版本更新" });
    expect(
      view.fetchMock.mock.calls.filter(([request]) => isUpdate(request)),
    ).toHaveLength(2);
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
    const ttl = await screen.findByLabelText("收银台有效期（秒）");
    await user.clear(ttl);
    await user.type(ttl, "450");
    expect(ttl).toHaveValue(450);
    await act(async () => {
      finish(json({ data: update }));
    });
    await screen.findByRole("status", { name: "官方版本更新" });
    expect(screen.getByLabelText("收银台有效期（秒）")).toBe(ttl);
    expect(ttl).toHaveValue(450);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it.each(["network", "server"])(
    "keeps an update %s failure non-blocking and never silently retries",
    async (failure) => {
      const view = mount((request) =>
        isUpdate(request)
          ? failure === "network"
            ? Promise.reject(new TypeError("offline"))
            : apiError("update_check_unavailable", "更新检查失败", 503)
          : undefined,
      );
      const ttl = await screen.findByLabelText("收银台有效期（秒）");
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
      await act(async () => {
        fireEvent(window, new Event("focus"));
        fireEvent(window, new Event("online"));
      });
      expect(
        view.fetchMock.mock.calls.filter(([request]) => isUpdate(request)),
      ).toHaveLength(1);
      await userEvent
        .setup()
        .click(screen.getByRole("link", { name: "运行状态" }));
      expect(
        await screen.findByText(/暂时无法检查更新，不影响收款/),
      ).toBeVisible();
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
    await screen.findByLabelText("收银台有效期（秒）");
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
  });

  it("hides stale success while refreshing and after a failed manual check", async () => {
    let finish!: (response: Response) => void;
    let calls = 0;
    mount(
      (request) =>
        isUpdate(request)
          ? ++calls === 1
            ? json({ data: { ...update, status: "up_to_date" } })
            : new Promise<Response>((resolve) => {
                finish = resolve;
              })
          : undefined,
      "/system",
    );
    await screen.findByText("已是最新稳定版。");
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "检查更新" }));
    await screen.findByText("正在检查更新…");
    expect(screen.queryByText("已是最新稳定版。")).not.toBeInTheDocument();
    await act(async () => {
      finish(apiError("update_check_unavailable", "failed", 503));
    });
    expect(
      await screen.findByText(/暂时无法检查更新，不影响收款/),
    ).toBeVisible();
    expect(screen.queryByText("已是最新稳定版。")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "查看发布说明" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "运行状态" })).toBeVisible();
  });

  it.each(["up_to_date", "ahead"] as const)(
    "does not prompt for %s and still explains the result",
    async (status) => {
      mount(
        (request) =>
          isUpdate(request) ? json({ data: { ...update, status } }) : undefined,
        "/system",
      );
      expect(
        await screen.findByText(
          status === "ahead" ? "当前版本高于官方稳定版。" : "已是最新稳定版。",
        ),
      ).toBeVisible();
      expect(
        screen.queryByRole("status", { name: "官方版本更新" }),
      ).not.toBeInTheDocument();
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
    await screen.findByText(/暂时无法检查更新，不影响收款/);
    expect(
      screen.queryByRole("link", { name: "查看发布说明" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("status", { name: "官方版本更新" }),
    ).not.toBeInTheDocument();
  });
  it.each([
    ["0.3.0-rc.2", "0.3.0-rc.10", "update_available", "有可用更新：v0.3.0-rc.10（预发布）"],
    ["0.3.0-rc.2", "0.3.0", "update_available", "有可用更新：v0.3.0"],
    ["0.3.0-rc.2", "0.3.0-rc.2", "up_to_date", "已是当前通道最新版本。"],
    ["0.3.0-rc.2", "0.3.0-rc.1", "ahead", "当前版本高于官方已发布版本。"],
  ] as const)("displays %s -> %s with the correct channel semantics", async (current, latest, status, message) => {
    const prereleaseUpdate: OfficialUpdate = {
      ...update, current_version: current, latest_version: latest, status,
      release_url: "https://github.com/Mashiro0619/PerPay/releases/tag/v" + latest,
    };
    const view = mount(request => isUpdate(request) ? json({ data: prereleaseUpdate }) : undefined, "/system");
    expect(await screen.findByText(message)).toBeVisible();
    expect(screen.getByText("当前使用预发布版本，同时检查正式版和预发布版。")).toBeVisible();
    await userEvent.setup().click(screen.getByRole("button", { name: "版本信息" }));
    expect(screen.getByText(latest.includes("-") ? "官方预发布版" : "官方稳定版")).toBeVisible();
    expect(screen.getByRole("link", { name: "查看发布说明" })).toHaveAttribute("href", prereleaseUpdate.release_url);
    expect(view.fetchMock.mock.calls.filter(([request]) => isUpdate(request))).toHaveLength(1);
  });

  it("labels a prerelease update in the nonblocking banner", async () => {
    mount(request => isUpdate(request) ? json({ data: {
      ...update, current_version: "0.3.0-alpha.1", latest_version: "0.3.0-rc.1",
      release_url: "https://github.com/Mashiro0619/PerPay/releases/tag/v0.3.0-rc.1",
    } }) : undefined);
    const notice = await screen.findByRole("status", { name: "官方版本更新" });
    expect(notice).toHaveTextContent("有新版本 v0.3.0-rc.1（预发布）");
    expect(screen.getByLabelText("收银台有效期（秒）")).toBeVisible();
  });

  it.each([
    ["0.3.0", "0.4.0-alpha.1"],
    ["0.3.0-rc.01", "0.3.0"],
    ["0.3.0-alpha.1", "0.3.0-rc.01"],
  ])("rejects invalid or cross-channel update data %s -> %s", async (current, latest) => {
    mount(request => isUpdate(request) ? json({ data: {
      ...update, current_version: current, latest_version: latest,
      release_url: "https://github.com/Mashiro0619/PerPay/releases/tag/v" + latest,
    } }) : undefined, "/system");
    await screen.findByText(/暂时无法检查更新，不影响收款/);
    expect(screen.queryByRole("link", { name: "查看发布说明" })).not.toBeInTheDocument();
  });

});
