import { QueryClientProvider } from "@tanstack/react-query";
import { act, createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
const uploadZone = () => screen.getByRole("group", { name: "二维码图片上传" });

function dropFiles(target: Element, files: File[]) {
  const event = createEvent.drop(target, { dataTransfer: { types: ["Files"], files } });
  fireEvent(target, event);
  return event;
}

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
  it("puts a clickable upload card before a separate compact editor", async () => {
    mount();
    const field = await screen.findByLabelText("支付宝经营码内容");
    const upload = screen.getByRole("button", { name: "点击或拖拽二维码图片" });
    expect(upload).toHaveAccessibleDescription("PNG、JPG、WebP，最大 10 MB");
    expect(uploadZone()).toContainElement(upload);
    expect(uploadZone()).not.toContainElement(field);
    expect(upload.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(field).toHaveAttribute("rows", "2");
    const choose = vi.spyOn(screen.getByLabelText("选择经营码二维码图片"), "click");
    await userEvent.setup().click(upload);
    expect(choose).toHaveBeenCalledOnce();
  });

  it.each(["picker", "drop"])("fills the original link locally via %s and saves only after confirmation with the current revision", async (source) => {
    vi.mocked(decodeQrImage).mockResolvedValue(recognizedLink);
    const { container, fetchMock } = mount();
    const field = await screen.findByLabelText("支付宝经营码内容");
    const user = userEvent.setup();
    const ttl = screen.getByLabelText("收银台有效期（秒）");
    await user.clear(ttl); await user.type(ttl, "450");
    if (source === "picker") await user.upload(screen.getByLabelText("选择经营码二维码图片"), imageFile());
    else expect(dropFiles(uploadZone(), [imageFile()]).defaultPrevented).toBe(true);
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
    expect(screen.getByRole("button", { name: "点击或拖拽二维码图片" })).toHaveAccessibleDescription(/未识别到二维码，请上传清晰、完整的二维码图片。/);
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

  it.each([["picker", "success"], ["picker", "failure"], ["drop", "success"], ["drop", "failure"]])("never replaces a newer manual edit with a late %s decoder %s", async (source, outcome) => {
    const pending = pendingDecode(); vi.mocked(decodeQrImage).mockReturnValue(pending.promise);
    mount();
    const field = await screen.findByLabelText("支付宝经营码内容");
    const user = userEvent.setup();
    if (source === "picker") await user.upload(screen.getByLabelText("选择经营码二维码图片"), imageFile());
    else dropFiles(uploadZone(), [imageFile()]);
    const signal = vi.mocked(decodeQrImage).mock.calls[0]![1];
    await user.clear(field); await user.type(field, "https://qr.alipay.com/manual-edit");
    expect(signal.aborted).toBe(true);
    expect(screen.getByRole("button", { name: "保存配置" })).toBeEnabled();
    await act(async () => { if (outcome === "success") pending.resolve(recognizedLink); else pending.reject(new Error("late failure")); });
    expect(field).toHaveValue("https://qr.alipay.com/manual-edit");
    expect(screen.queryByText("已识别，请核对后保存。")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each(["picker", "drop"])("ignores an older selection without ending a newer pending %s decode", async (source) => {
    const first = pendingDecode(); const second = pendingDecode();
    vi.mocked(decodeQrImage).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    mount();
    const picker = await screen.findByLabelText("选择经营码二维码图片");
    fireEvent.change(picker, { target: { files: [imageFile()] } });
    const previousSignal = vi.mocked(decodeQrImage).mock.calls[0]![1];
    if (source === "picker") fireEvent.change(picker, { target: { files: [imageFile()] } });
    else dropFiles(screen.getByRole("button", { name: "正在识别…" }), [imageFile()]);
    expect(previousSignal.aborted).toBe(true);
    await act(async () => { first.resolve("https://qr.alipay.com/older-image"); });
    expect(screen.getByLabelText("支付宝经营码内容")).toHaveValue(settings.collection!.code_payload);
    expect(screen.getByRole("button", { name: "保存配置" })).toBeDisabled();
    await act(async () => { second.resolve(recognizedLink); });
    expect(screen.getByLabelText("支付宝经营码内容")).toHaveValue(recognizedLink);
    expect(screen.getByRole("button", { name: "保存配置" })).toBeEnabled();
  });

  it.each(["picker", "drop"])("cancels %s decoding on section changes and ignores results after unmount", async (source) => {
    const pending = pendingDecode(); vi.mocked(decodeQrImage).mockReturnValue(pending.promise);
    const { router, fetchMock } = mount();
    const picker = await screen.findByLabelText("选择经营码二维码图片");
    if (source === "picker") await userEvent.setup().upload(picker, imageFile());
    else dropFiles(uploadZone(), [imageFile()]);
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

  it("keeps the drag highlight across nested controls and clears it on leaving the target", async () => {
    mount();
    await screen.findByLabelText("支付宝经营码内容");
    const zone = uploadZone();
    const nestedControl = screen.getByRole("button", { name: "点击或拖拽二维码图片" });
    const dataTransfer = { types: ["Files"], files: [], dropEffect: "none" };
    expect(screen.getByText("点击或拖拽二维码图片")).toBeVisible();
    fireEvent.dragEnter(zone, { dataTransfer });
    expect(zone).toHaveClass("is-dragging");
    expect(screen.getByText("松开即可识别")).toBeVisible();
    fireEvent.dragEnter(nestedControl, { dataTransfer });
    fireEvent.dragLeave(nestedControl, { dataTransfer });
    expect(zone).toHaveClass("is-dragging");
    const over = createEvent.dragOver(zone, { dataTransfer }); fireEvent(zone, over);
    expect(over.defaultPrevented).toBe(true);
    expect(dataTransfer.dropEffect).toBe("copy");
    fireEvent.dragLeave(zone, { dataTransfer });
    expect(zone).not.toHaveClass("is-dragging");
    expect(screen.getByText("点击或拖拽二维码图片")).toBeVisible();
    expect(decodeQrImage).not.toHaveBeenCalled();
  });

  it.each(["text/plain", "text/uri-list"])("leaves native %s dragging alone and never fetches dragged links", async (type) => {
    const { fetchMock } = mount();
    const field = await screen.findByLabelText("支付宝经营码内容");
    const dataTransfer = { types: [type], files: [], getData: () => recognizedLink };
    const over = createEvent.dragOver(field, { dataTransfer }); fireEvent(field, over);
    const drop = createEvent.drop(field, { dataTransfer }); fireEvent(field, drop);
    expect(over.defaultPrevented).toBe(false);
    expect(drop.defaultPrevented).toBe(false);
    expect(decodeQrImage).not.toHaveBeenCalled();
    expect(writes(fetchMock)).toHaveLength(0);
    expect(field).toHaveValue(settings.collection!.code_payload);
  });

  it("rejects multiple dropped files without choosing one or replacing the draft", async () => {
    const { fetchMock } = mount();
    const field = await screen.findByLabelText("支付宝经营码内容");
    expect(dropFiles(uploadZone(), [imageFile(), imageFile()]).defaultPrevented).toBe(true);
    expect(await screen.findByRole("alert")).toHaveTextContent("一次只能识别一张二维码图片，请重新选择。");
    expect(decodeQrImage).not.toHaveBeenCalled();
    expect(field).toHaveValue(settings.collection!.code_payload);
    expect(screen.queryByText("有未保存的修改")).not.toBeInTheDocument();
    expect(writes(fetchMock)).toHaveLength(0);
  });

  it.each([[0, "success"], [0, "failure"], [2, "success"], [2, "failure"]] as const)("cancels an older decode after rejecting %i dropped files and ignores its late %s", async (count, outcome) => {
    const pending = pendingDecode(); vi.mocked(decodeQrImage).mockReturnValue(pending.promise);
    const { fetchMock } = mount();
    const field = await screen.findByLabelText("支付宝经营码内容");
    dropFiles(uploadZone(), [imageFile()]);
    const signal = vi.mocked(decodeQrImage).mock.calls[0]![1];
    expect(screen.getByRole("button", { name: "保存配置" })).toBeDisabled();
    dropFiles(uploadZone(), Array.from({ length: count }, imageFile));
    expect(signal.aborted).toBe(true);
    const message = count === 0 ? "请拖入一张 PNG、JPG 或 WebP 二维码图片。" : "一次只能识别一张二维码图片，请重新选择。";
    expect(screen.getByRole("alert")).toHaveTextContent(message);
    expect(screen.getByRole("button", { name: "保存配置" })).toBeEnabled();
    await act(async () => { if (outcome === "success") pending.resolve(recognizedLink); else pending.reject(new Error("late failure")); });
    expect(field).toHaveValue(settings.collection!.code_payload);
    expect(screen.getByRole("alert")).toHaveTextContent(message);
    expect(screen.queryByText("已识别，请核对后保存。")).not.toBeInTheDocument();
    expect(screen.queryByText("有未保存的修改")).not.toBeInTheDocument();
    expect(decodeQrImage).toHaveBeenCalledOnce();
    expect(writes(fetchMock)).toHaveLength(0);
  });

  it.each(["format", "size"])("applies the existing image %s validation to dropped files", async (invalid) => {
    const actual = await vi.importActual<typeof import("../src/qr-image")>("../src/qr-image");
    vi.mocked(decodeQrImage).mockImplementation(actual.decodeQrImage);
    mount();
    const field = await screen.findByLabelText("支付宝经营码内容");
    const file = invalid === "format" ? new File(["pdf"], "code.pdf", { type: "application/pdf" })
      : new File([new Uint8Array(10 * 1024 * 1024 + 1)], "large.png", { type: "image/png" });
    dropFiles(uploadZone(), [file]);
    expect(await screen.findByRole("alert")).toHaveTextContent(invalid === "format" ? "请选择 PNG、JPG 或 WebP 图片。" : "图片不能超过 10 MB");
    expect(field).toHaveValue(settings.collection!.code_payload);
    expect(screen.getByRole("button", { name: "保存配置" })).toBeEnabled();
  });

  it("prevents accidental file navigation outside the target only while the field is mounted", async () => {
    const { unmount } = mount();
    await screen.findByLabelText("支付宝经营码内容");
    const zone = screen.getByRole("group", { name: "二维码图片上传" });
    const dataTransfer = { types: ["Files"], files: [], dropEffect: "copy" };
    fireEvent.dragEnter(zone, { dataTransfer });
    const outside = createEvent.dragOver(document.body, { dataTransfer }); fireEvent(document.body, outside);
    expect(outside.defaultPrevented).toBe(true);
    expect(dataTransfer.dropEffect).toBe("none");
    expect(zone).not.toHaveClass("is-dragging");
    expect(dropFiles(document.body, [imageFile()]).defaultPrevented).toBe(true);
    expect(decodeQrImage).not.toHaveBeenCalled();
    for (const event of ["dragend", "blur"]) {
      fireEvent.dragEnter(zone, { dataTransfer });
      fireEvent(window, new Event(event));
      expect(zone).not.toHaveClass("is-dragging");
    }
    unmount();
    expect(dropFiles(document.body, [imageFile()]).defaultPrevented).toBe(false);
  });

  it("clears the drag highlight when the browser hides file types on dragleave", async () => {
    mount();
    await screen.findByLabelText("支付宝经营码内容");
    const zone = screen.getByRole("group", { name: "二维码图片上传" });
    fireEvent.dragEnter(zone, { dataTransfer: { types: ["Files"], files: [] } });
    expect(zone).toHaveClass("is-dragging");
    fireEvent.dragLeave(zone, { dataTransfer: { types: [], files: [] } });
    expect(zone).not.toHaveClass("is-dragging");
  });

  it("ignores window drag events without a data transfer", async () => {
    mount();
    await screen.findByLabelText("支付宝经营码内容");
    for (const type of ["dragOver", "drop"] as const) {
      const event = createEvent[type](document.body, { dataTransfer: null });
      fireEvent(document.body, event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(decodeQrImage).not.toHaveBeenCalled();
  });

  it("respects the disabled fieldset while a configuration save is pending", async () => {
    const { fetchMock } = mount();
    const field = await screen.findByLabelText("支付宝经营码内容");
    let finish: (response: Response) => void = () => {};
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }));
    const zone = screen.getByRole("group", { name: "二维码图片上传" });
    fireEvent.dragEnter(uploadZone(), { dataTransfer: { types: ["Files"], files: [] } });
    expect(zone).toHaveClass("is-dragging");
    await userEvent.setup().click(screen.getByRole("button", { name: "保存配置" }));
    await waitFor(() => expect(writes(fetchMock)).toHaveLength(1));
    expect(field).toBeDisabled();
    expect(zone).not.toHaveClass("is-dragging");
    fireEvent.dragEnter(uploadZone(), { dataTransfer: { types: ["Files"], files: [] } });
    expect(screen.getByRole("group", { name: "二维码图片上传" })).not.toHaveClass("is-dragging");
    expect(dropFiles(uploadZone(), [imageFile()]).defaultPrevented).toBe(true);
    const picker = screen.getByLabelText("选择经营码二维码图片");
    expect(picker).toBeDisabled();
    fireEvent.change(picker, { target: { files: [imageFile()] } });
    expect(decodeQrImage).not.toHaveBeenCalled();
    expect(field).toHaveValue(settings.collection!.code_payload);
    await act(async () => { finish(json({ data: { ...settings, revision: 4 } })); });
    expect(screen.getByLabelText("支付宝经营码内容")).toBeEnabled();
  });

  it.each(["{Enter}", " "])("opens the picker with %s from the upload card without adding a duplicate tab stop", async (key) => {
    mount();
    const picker = await screen.findByLabelText("选择经营码二维码图片");
    const choose = vi.spyOn(picker, "click");
    const upload = screen.getByRole("button", { name: "点击或拖拽二维码图片" });
    upload.focus();
    await userEvent.setup().keyboard(key);
    expect(choose).toHaveBeenCalledOnce();
    expect(screen.getByRole("group", { name: "二维码图片上传" })).not.toHaveAttribute("tabindex");
    expect(decodeQrImage).not.toHaveBeenCalled();
  });
});
