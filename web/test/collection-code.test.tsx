import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { queryClient } from "../src/api/client";
import { DraftProvider } from "../src/drafts";
import Settings from "../src/pages/Settings";
import { decodeQrImage } from "../src/qr-image";
import { apiError, json, settings } from "./fixtures";

vi.mock("../src/qr-image", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/qr-image")>(), decodeQrImage: vi.fn(),
}));

const recognizedLink = "https://qr.alipay.com/fkx-upload-test?value=a%2Fb&amount=0.01";
const imageFile = () => new File(["image"], "支付宝经营码.png", { type: "image/png" });

function pendingDecode() {
  let resolve: (value: string) => void = () => {};
  let reject: (reason: Error) => void = () => {};
  const promise = new Promise<string>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

function mount(conflict = false) {
  const fetchMock = vi.fn(async (request: Request) => {
    if (request.method === "PUT") {
      if (conflict) return apiError("settings_revision_conflict", "配置版本冲突，请重新读取");
      const { revision, ...collection } = await request.clone().json();
      return json({ data: { ...settings, revision: revision + 1, collection } });
    }
    return json({ data: settings });
  });
  vi.stubGlobal("fetch", fetchMock);
  const router = createMemoryRouter([{ element: <DraftProvider><Outlet /></DraftProvider>, children: [
    { path: "/settings/:section", element: <Settings /> },
    { path: "/orders", element: <h1>订单</h1> },
  ] }], { initialEntries: ["/settings/collection"] });
  const view = render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
  return { router, fetchMock, ...view };
}

function writes(fetchMock: ReturnType<typeof mount>["fetchMock"]) {
  return fetchMock.mock.calls.map(([request]) => request).filter((request) => request.method === "PUT");
}

beforeEach(() => { vi.mocked(decodeQrImage).mockReset(); });

describe("collection QR image upload", () => {
  it("fills the original link locally and saves only after confirmation with the current revision", async () => {
    vi.mocked(decodeQrImage).mockResolvedValue(recognizedLink);
    const { container, fetchMock } = mount();
    const field = await screen.findByLabelText("支付宝经营码内容");
    const user = userEvent.setup();
    const ttl = screen.getByLabelText("收银台有效期（秒）");
    await user.clear(ttl); await user.type(ttl, "450");
    await user.upload(screen.getByLabelText("选择经营码二维码图片"), imageFile());
    expect(await screen.findByText("已识别，请核对后保存。")).toBeVisible();
    expect(field).toHaveValue(recognizedLink);
    expect(ttl).toHaveValue(450);
    expect(screen.getByText("有未保存的修改")).toBeVisible();
    expect(writes(fetchMock)).toHaveLength(0);
    expect(container.querySelector("[style]")).toBeNull();
    const unload = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    await user.click(screen.getByRole("button", { name: "保存配置" }));
    expect(await screen.findByText(/配置已保存/)).toBeVisible();
    expect(writes(fetchMock)).toHaveLength(1);
    expect(await writes(fetchMock)[0]!.json()).toEqual({ revision: 3, code_payload: recognizedLink, order_ttl_seconds: 450, amount_offset_maximum_cents: 99 });
    expect(screen.getByLabelText("支付宝经营码内容")).toHaveValue(recognizedLink);
    expect(screen.queryByText("有未保存的修改")).not.toBeInTheDocument();
  });

  it("allows selecting the same image again and does not make an unchanged payload dirty", async () => {
    vi.mocked(decodeQrImage).mockResolvedValue(settings.collection!.code_payload);
    mount();
    const picker = await screen.findByLabelText("选择经营码二维码图片");
    const user = userEvent.setup();
    const file = imageFile();
    await user.upload(picker, file);
    await screen.findByText("已识别，请核对后保存。");
    expect(picker).toHaveValue("");
    expect(picker).not.toHaveAttribute("name");
    await user.upload(picker, file);
    await waitFor(() => expect(decodeQrImage).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("有未保存的修改")).not.toBeInTheDocument();
  });

  it("keeps existing content on failure and supports retrying the same file", async () => {
    vi.mocked(decodeQrImage).mockRejectedValueOnce(new Error("未识别到二维码，请上传清晰、完整的二维码图片。")).mockResolvedValueOnce(recognizedLink);
    const { fetchMock } = mount();
    const field = await screen.findByLabelText("支付宝经营码内容");
    const picker = screen.getByLabelText("选择经营码二维码图片");
    const user = userEvent.setup(); const file = imageFile();
    await user.upload(picker, file);
    expect(await screen.findByRole("alert")).toHaveTextContent("未识别到二维码");
    expect(screen.getByRole("button", { name: "上传二维码图片" })).toHaveAccessibleDescription("未识别到二维码，请上传清晰、完整的二维码图片。");
    expect(field).toHaveValue(settings.collection!.code_payload);
    expect(field).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByText("有未保存的修改")).not.toBeInTheDocument();
    expect(writes(fetchMock)).toHaveLength(0);
    await user.upload(picker, file);
    expect(await screen.findByText("已识别，请核对后保存。")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("prevents saving the old payload while an image is being decoded", async () => {
    const pending = pendingDecode(); vi.mocked(decodeQrImage).mockReturnValue(pending.promise);
    const { fetchMock } = mount();
    const picker = await screen.findByLabelText("选择经营码二维码图片");
    await userEvent.setup().upload(picker, imageFile());
    expect(screen.getByRole("button", { name: "正在识别…" })).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "保存配置" })).toBeDisabled();
    fireEvent.submit(picker.closest("form")!);
    expect(writes(fetchMock)).toHaveLength(0);
    await act(async () => { pending.resolve(recognizedLink); });
    expect(screen.getByRole("button", { name: "保存配置" })).toBeEnabled();
    expect(writes(fetchMock)).toHaveLength(0);
  });

  it.each(["success", "failure"])("never replaces a newer manual edit with a late decoder %s", async (outcome) => {
    const pending = pendingDecode(); vi.mocked(decodeQrImage).mockReturnValue(pending.promise);
    mount();
    const field = await screen.findByLabelText("支付宝经营码内容");
    const user = userEvent.setup();
    await user.upload(screen.getByLabelText("选择经营码二维码图片"), imageFile());
    const signal = vi.mocked(decodeQrImage).mock.calls[0]![1];
    await user.clear(field); await user.type(field, "https://qr.alipay.com/manual-edit");
    expect(signal.aborted).toBe(true);
    expect(screen.getByRole("button", { name: "保存配置" })).toBeEnabled();
    await act(async () => { if (outcome === "success") pending.resolve(recognizedLink); else pending.reject(new Error("late failure")); });
    expect(field).toHaveValue("https://qr.alipay.com/manual-edit");
    expect(screen.queryByText("已识别，请核对后保存。")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("ignores an older selection without ending a newer pending decode", async () => {
    const first = pendingDecode(); const second = pendingDecode();
    vi.mocked(decodeQrImage).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    mount();
    const picker = await screen.findByLabelText("选择经营码二维码图片");
    fireEvent.change(picker, { target: { files: [imageFile()] } });
    const previousSignal = vi.mocked(decodeQrImage).mock.calls[0]![1];
    fireEvent.change(picker, { target: { files: [imageFile()] } });
    expect(previousSignal.aborted).toBe(true);
    await act(async () => { first.resolve("https://qr.alipay.com/older-image"); });
    expect(screen.getByLabelText("支付宝经营码内容")).toHaveValue(settings.collection!.code_payload);
    expect(screen.getByRole("button", { name: "保存配置" })).toBeDisabled();
    await act(async () => { second.resolve(recognizedLink); });
    expect(screen.getByLabelText("支付宝经营码内容")).toHaveValue(recognizedLink);
    expect(screen.getByRole("button", { name: "保存配置" })).toBeEnabled();
  });

  it("cancels decoding on section changes and ignores results after unmount", async () => {
    const pending = pendingDecode(); vi.mocked(decodeQrImage).mockReturnValue(pending.promise);
    const { router, fetchMock } = mount();
    await userEvent.setup().upload(await screen.findByLabelText("选择经营码二维码图片"), imageFile());
    const signal = vi.mocked(decodeQrImage).mock.calls[0]![1];
    await act(async () => { await router.navigate("/settings/backup"); });
    expect(signal.aborted).toBe(true);
    await act(async () => { pending.resolve(recognizedLink); });
    expect(screen.queryByText("已识别，请核对后保存。")).not.toBeInTheDocument();
    await act(async () => { await router.navigate("/settings/collection"); });
    expect(screen.getByLabelText("支付宝经营码内容")).toHaveValue(settings.collection!.code_payload);
    expect(screen.queryByText("有未保存的修改")).not.toBeInTheDocument();
    expect(writes(fetchMock)).toHaveLength(0);
  });

  it("protects a decoded draft when navigating away", async () => {
    vi.mocked(decodeQrImage).mockResolvedValue(recognizedLink);
    mount();
    const user = userEvent.setup();
    await user.upload(await screen.findByLabelText("选择经营码二维码图片"), imageFile());
    await screen.findByText("已识别，请核对后保存。");
    await user.click(screen.getByRole("link", { name: "自动备份" }));
    expect(await screen.findByRole("dialog", { name: "放弃未保存的修改？" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "继续编辑" }));
    expect(screen.getByLabelText("支付宝经营码内容")).toHaveValue(recognizedLink);
    await user.click(screen.getByRole("link", { name: "自动备份" }));
    await user.click(await screen.findByRole("button", { name: "放弃修改并继续" }));
    expect(await screen.findByLabelText("备份间隔（秒）")).toBeVisible();
  });

  it("retains the decoded draft after a revision conflict", async () => {
    vi.mocked(decodeQrImage).mockResolvedValue(recognizedLink);
    const { fetchMock } = mount(true);
    const user = userEvent.setup();
    await user.upload(await screen.findByLabelText("选择经营码二维码图片"), imageFile());
    await screen.findByText("已识别，请核对后保存。");
    await user.click(screen.getByRole("button", { name: "保存配置" }));
    expect(await screen.findByText("配置版本冲突，请重新读取")).toBeVisible();
    expect(screen.getByLabelText("支付宝经营码内容")).toHaveValue(recognizedLink);
    expect(screen.getByText("有未保存的修改")).toBeVisible();
    expect(await writes(fetchMock)[0]!.json()).toMatchObject({ revision: 3, code_payload: recognizedLink });
  });

  it("leaves the current content untouched when file selection is cancelled", async () => {
    mount();
    const picker = await screen.findByLabelText("选择经营码二维码图片");
    fireEvent.change(picker, { target: { files: [] } });
    expect(decodeQrImage).not.toHaveBeenCalled();
    expect(screen.getByLabelText("支付宝经营码内容")).toHaveValue(settings.collection!.code_payload);
    expect(screen.queryByText("有未保存的修改")).not.toBeInTheDocument();
  });
});
