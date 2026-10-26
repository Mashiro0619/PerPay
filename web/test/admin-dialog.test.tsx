import { render, screen, waitFor, within } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction, DialogBody, Dialog, DialogContent, DialogHeader, DialogTitle } from "../src/components/admin-dialog";

afterEach(() => vi.restoreAllMocks());

function stubConfirmationViewport(overflowing: boolean) {
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute("data-admin-dialog-scroll") ? 240 : 0;
  });
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute("data-admin-dialog-scroll") ? overflowing ? 900 : 200 : 0;
  });
}

describe("administrator dialog presentation", () => {
  it("starts a long read dialog at its explanation before its first action", async () => {
    stubConfirmationViewport(true);
    render(<Dialog open><DialogContent><DialogHeader><DialogTitle>查看支付宝公钥</DialogTitle></DialogHeader><DialogBody><p>阅读查看范围和时限后再复制。</p><button>复制公钥</button></DialogBody></DialogContent></Dialog>);
    const dialog = screen.getByRole("dialog", { name: "查看支付宝公钥" });
    const scroll = dialog.querySelector<HTMLElement>("[data-admin-dialog-scroll]")!;
    await waitFor(() => expect(scroll).toHaveFocus());
    expect(scroll).toHaveAttribute("tabindex", "0");
    expect(within(dialog).getByRole("button", { name: "复制公钥" })).not.toHaveFocus();
    expect(scroll.scrollTop).toBe(0);
  });
  it("uses confirmation semantics and focuses cancellation without an icon", async () => {
    render(<AlertDialog open><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>确认操作</AlertDialogTitle></AlertDialogHeader><DialogBody><AlertDialogDescription>操作说明</AlertDialogDescription></DialogBody><AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction variant="destructive">确认</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>);
    const dialog = screen.getByRole("alertdialog", { name: "确认操作" });
    expect(dialog).toHaveAttribute("data-admin-dialog", "confirm");
    expect(dialog).toHaveClass("overflow-hidden", "data-[size=default]:sm:max-w-lg");
    expect(dialog.querySelector("[data-admin-dialog-body]")).toHaveClass("min-h-0", "overflow-y-auto");
    expect(dialog.querySelector("[data-slot=alert-dialog-header]")).toHaveClass("text-left");
    expect(dialog.querySelector("[data-slot=alert-dialog-footer]")).toHaveClass("flex-col-reverse", "sm:flex-row");
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "取消" })).toHaveFocus());
    expect(within(dialog).queryByRole("button", { name: "关闭对话框" })).not.toBeInTheDocument();
  });
  it.each(["default", "explicit"] as const)("starts a long confirmation at its explanation with %s cancellation focus", async (focus) => {
    stubConfirmationViewport(true);
    const cancel = createRef<HTMLButtonElement>();
    render(<AlertDialog open><AlertDialogContent initialFocus={focus === "explicit" ? cancel : undefined}><AlertDialogHeader><AlertDialogTitle>确认保存访问规则？</AlertDialogTitle></AlertDialogHeader><DialogBody><AlertDialogDescription>{"保存后立即生效，请确认允许当前客户端，并保留服务器离线恢复权限。".repeat(12)}</AlertDialogDescription></DialogBody><AlertDialogFooter><AlertDialogCancel ref={cancel}>取消</AlertDialogCancel><AlertDialogAction>确认保存</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>);

    const dialog = screen.getByRole("alertdialog", { name: "确认保存访问规则？" });
    const scroll = dialog.querySelector<HTMLElement>("[data-admin-dialog-scroll]")!;
    await waitFor(() => expect(scroll).toHaveFocus());
    expect(scroll).toHaveAttribute("tabindex", "0");
    expect(cancel.current).not.toHaveFocus();
    expect(scroll.scrollTop).toBe(0);
    expect(within(dialog).getByText(/^保存后立即生效/)).toBeVisible();
  });
  it("keeps an explicit cancellation ref as the initial focus when the confirmation fits", async () => {
    stubConfirmationViewport(false);
    const cancel = createRef<HTMLButtonElement>();
    render(<AlertDialog open><AlertDialogContent initialFocus={cancel}><AlertDialogHeader><AlertDialogTitle>确认保存？</AlertDialogTitle></AlertDialogHeader><DialogBody><AlertDialogDescription>保存后立即生效。</AlertDialogDescription></DialogBody><AlertDialogFooter><AlertDialogCancel ref={cancel}>暂不保存</AlertDialogCancel><AlertDialogAction>确认保存</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>);

    const dialog = screen.getByRole("alertdialog", { name: "确认保存？" });
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "暂不保存" })).toHaveFocus());
    expect(dialog.querySelector("[data-admin-dialog-scroll]")).toHaveAttribute("tabindex", "-1");
    expect(dialog).not.toHaveFocus();
  });
  it.each(["form", "technical"] as const)("has an explicit %s size without changing the dialog role", kind => {
    render(<Dialog open><DialogContent kind={kind}><DialogHeader><DialogTitle>查看内容</DialogTitle></DialogHeader><DialogBody>内容</DialogBody></DialogContent></Dialog>);
    const dialog = screen.getByRole("dialog", { name: "查看内容" });
    expect(dialog).toHaveClass(kind === "form" ? "sm:max-w-xl" : "sm:max-w-3xl");
    expect(dialog).toHaveAttribute("data-admin-dialog", kind);
  });
});
