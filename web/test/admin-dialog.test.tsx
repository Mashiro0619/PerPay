import { render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction, DialogBody, Dialog, DialogContent, DialogHeader, DialogTitle } from "../src/components/admin-dialog";
describe("administrator dialog presentation", () => {
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
  it.each(["form", "technical"] as const)("has an explicit %s size without changing the dialog role", kind => {
    render(<Dialog open><DialogContent kind={kind}><DialogHeader><DialogTitle>查看内容</DialogTitle></DialogHeader><DialogBody>内容</DialogBody></DialogContent></Dialog>);
    const dialog = screen.getByRole("dialog", { name: "查看内容" });
    expect(dialog).toHaveClass(kind === "form" ? "sm:max-w-xl" : "sm:max-w-3xl");
    expect(dialog).toHaveAttribute("data-admin-dialog", kind);
  });
});
