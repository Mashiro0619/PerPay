import { useState } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Site } from "../src/api/client";
import {
  AlertDialog, AlertDialogAction, AlertDialogContent, AlertDialogDescription, AlertDialogTitle,
  Dialog, DialogContent, DialogDescription, DialogTitle,
} from "../src/components/admin-dialog";
import { WorkspaceSwitchingContext } from "../src/lib/workspace-navigation-state";
import { json } from "./fixtures";
import { mountOnboarding } from "./onboarding-fixture";

function site(clientId: string): Site {
  return {
    client_id: clientId, revision: 1,
    configuration: {
      name: "网站 " + clientId.toUpperCase(), accepting_orders: true, notifications_enabled: false,
      notification_origin: null, return_origin: null,
      policy: {
        orders: { order_ttl_seconds: 300, amount_offset_maximum_cents: 99, amount_reuse_cooldown_seconds: 600, pending_order_limit: null },
        display: { checkout_name: "网站收银台", checkout_help_url: null, checkout_show_product_name: true },
        notification_delivery: { timeout_milliseconds: 5000, maximum_attempts: 12, retry_base_seconds: 5, retry_maximum_seconds: 3600 },
      },
    },
    created_at: "2026-10-06T00:00:00Z", updated_at: "2026-10-06T00:00:00Z", deleted_at: null,
  };
}

describe("business dialogs during workspace navigation", () => {
  it("suspends an open delete confirmation during browser back and restores it when the switch is cancelled", async () => {
    const sites = [site("a"), site("b")];
    let delayDestination = false;
    let release!: (response: Response) => void;
    const delayed = new Promise<Response>(resolve => { release = resolve; });
    const view = mountOnboarding({
      stage: 4,
      path: "/sites/b/settings/basic",
      handle(request) {
        const path = new URL(request.url).pathname;
        if (path === "/api/admin/v1/sites") return json({ data: sites, page: { next_cursor: null } });
        if (request.method !== "GET") return new Response(null, { status: 204 });
        if (path === "/api/admin/v1/sites/b" && delayDestination) return delayed.then(response => response.clone());
        const selected = sites.find(value => path === "/api/admin/v1/sites/" + value.client_id);
        return selected ? json({ data: selected }) : undefined;
      },
    });
    const user = userEvent.setup();
    await screen.findByLabelText("业务网站名称");
    await act(async () => { await view.router.navigate("/sites/a/settings/basic"); });
    await waitFor(() => expect(screen.getByLabelText("业务网站名称")).toHaveValue("网站 A"));
    await user.click(screen.getByRole("button", { name: "删除空业务网站" }));
    const dialog = await screen.findByRole("alertdialog", { name: "确认删除业务网站？" });
    expect(dialog.closest("main")).toBeNull();

    delayDestination = true;
    act(() => { void view.router.navigate(-1); });
    await waitFor(() => expect(view.router.state.navigation.state).toBe("loading"));
    await waitFor(() => expect(dialog).not.toBeVisible());
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(view.router.state.location.pathname).toBe("/sites/a/settings/basic");
    expect(view.writes()).toHaveLength(0);
    const currentSite = screen.getByRole("link", { name: "网站 A" });
    expect(currentSite).toBeVisible();
    await user.click(currentSite);
    await waitFor(() => expect(view.router.state.navigation.state).toBe("idle"));
    expect(await screen.findByRole("alertdialog", { name: "确认删除业务网站？" })).toBe(dialog);
    expect(dialog).toBeVisible();
    expect(dialog).toHaveAccessibleDescription("仅限无历史订单的网站。删除后不可恢复，客户端 ID 不可复用。");
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "取消" })).toHaveFocus());
    expect(view.router.state.location.pathname).toBe("/sites/a/settings/basic");
    expect(view.writes()).toHaveLength(0);

    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    await act(async () => { release(json({ data: sites[1] })); await delayed; });
  });

  it.each(["dialog", "alertdialog"] as const)("preserves nested draft state while suspending a %s and releases its modal lock", async kind => {
    const submit = vi.fn();
    function Draft() {
      const [value, setValue] = useState("");
      return <input aria-label="未提交理由" value={value} onChange={event => setValue(event.target.value)} />;
    }
    function Example({ switching }: { switching: boolean }) {
      return <>
        <button>取消切换</button>
        <WorkspaceSwitchingContext value={switching}>
          {kind === "dialog" ? <Dialog open>
            <DialogContent>
              <DialogTitle>旧网站操作</DialogTitle>
              <DialogDescription>保留尚未提交的内容。</DialogDescription>
              <Draft />
              <button onClick={submit}>提交操作</button>
            </DialogContent>
          </Dialog> : <AlertDialog open>
            <AlertDialogContent>
              <AlertDialogTitle>旧网站操作</AlertDialogTitle>
              <AlertDialogDescription>保留尚未提交的内容。</AlertDialogDescription>
              <Draft />
              <AlertDialogAction onClick={submit}>提交操作</AlertDialogAction>
            </AlertDialogContent>
          </AlertDialog>}
        </WorkspaceSwitchingContext>
      </>;
    }
    const view = render(<Example switching={false} />);
    const user = userEvent.setup();
    const dialog = await screen.findByRole(kind, { name: "旧网站操作" });
    await user.type(within(dialog).getByLabelText("未提交理由"), "原始核查理由");
    view.rerender(<Example switching />);
    await waitFor(() => expect(screen.queryByRole(kind)).not.toBeInTheDocument());
    const cancel = screen.getByRole("button", { name: "取消切换" });
    await user.click(cancel);
    expect(cancel).toHaveFocus();
    expect(submit).not.toHaveBeenCalled();

    view.rerender(<Example switching={false} />);
    expect(await screen.findByRole(kind, { name: "旧网站操作" })).toBe(dialog);
    expect(dialog).toHaveAccessibleDescription("保留尚未提交的内容。");
    expect(within(dialog).getByLabelText("未提交理由")).toHaveValue("原始核查理由");
    await user.click(within(dialog).getByRole("button", { name: "提交操作" }));
    expect(submit).toHaveBeenCalledOnce();
  });
});
