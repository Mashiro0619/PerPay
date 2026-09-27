import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { alipayApplicationUrl } from "../src/lib/application-key";
import {
  clearOnboardingDeferrals,
  onboardingPath,
} from "../src/lib/onboarding";
import { json } from "./fixtures";
import {
  configuredThrough,
  mountOnboarding,
  pendingApplicationKey,
  systemStatus,
} from "./onboarding-fixture";

beforeEach(() => clearOnboardingDeferrals());
const managementUrl = "https://open.alipay.com/develop/manage";
const detailsUrl = "https://open.alipay.com/develop/pm/sub/appinfo";

describe("Alipay application shortcuts", () => {
  it.each([undefined, null, "", " \n "])(
    "uses application management before an App ID exists (%j)",
    (appId) => {
      expect(alipayApplicationUrl(appId)).toBe(managementUrl);
    },
  );
  it("opens the supplied App ID using the official application details URL", () => {
    expect(alipayApplicationUrl(" 2026000000000001 ")).toBe(
      detailsUrl + "?appId=2026000000000001",
    );
  });
  it("encodes the App ID without permitting injected query parameters or a different host", () => {
    const id = "app&redirect=https://other.invalid/#fragment?x=1";
    const url = new URL(alipayApplicationUrl(id));
    expect(url.origin + url.pathname).toBe(detailsUrl);
    expect([...url.searchParams.entries()]).toEqual([["appId", id]]);
    expect(url.hash).toBe("");
  });
  it("keeps the management entry for first-time setup", async () => {
    const view = mountOnboarding({
      stage: 1,
      path: onboardingPath("provider"),
    });
    const link = await screen.findByRole("link", { name: "支付宝应用管理" });
    expect(link).toHaveAttribute("href", managementUrl);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(view.writes()).toHaveLength(0);
  });
  it("targets the saved application, not an unsubmitted App ID draft, and updates after refresh", async () => {
    let saved = configuredThrough(4);
    saved.provider!.app_id = "2026000000000001";
    const view = mountOnboarding({
      stage: 4,
      path: onboardingPath("provider"),
      handle: (request) =>
        request.method === "GET" && request.url.endsWith("/settings")
          ? json({ data: saved })
          : undefined,
      status: () => systemStatus(saved),
    });
    const link = await screen.findByRole("link", { name: "支付宝应用管理" });
    expect(link).toHaveAttribute(
      "href",
      detailsUrl + "?appId=2026000000000001",
    );
    fireEvent.change(screen.getByLabelText("应用 ID（App ID）"), {
      target: { value: "unsubmitted-id" },
    });
    expect(link).toHaveAttribute(
      "href",
      detailsUrl + "?appId=2026000000000001",
    );
    saved = structuredClone(saved);
    saved.provider!.app_id = "2026000000000002";
    saved.revision++;
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "刷新" }));
    await user.click(
      await screen.findByRole("button", { name: "放弃修改并继续" }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("link", { name: "支付宝应用管理" }),
      ).toHaveAttribute("href", detailsUrl + "?appId=2026000000000002"),
    );
    expect(view.writes()).toHaveLength(0);
  });
  it.each([
    [onboardingPath("application"), "打开支付宝应用管理"],
    [onboardingPath("provider"), "支付宝应用管理"],
    ["/settings/provider", "打开支付宝应用管理"],
  ])("targets the pending key's application at %s", async (path, name) => {
    const saved = pendingApplicationKey();
    saved.provider!.app_id = "saved-application";
    saved.pending_application_key!.app_id = "pending-application";
    const view = mountOnboarding({
      pendingKey: true,
      path,
      handle: (request) =>
        request.method === "GET" && request.url.endsWith("/settings")
          ? json({ data: saved })
          : undefined,
      status: () => systemStatus(saved),
    });
    const link = await screen.findByRole("link", { name });
    expect(link).toHaveAttribute(
      "href",
      detailsUrl + "?appId=pending-application",
    );
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(view.writes()).toHaveLength(0);
  });
});
