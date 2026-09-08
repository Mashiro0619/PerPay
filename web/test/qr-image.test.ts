import { encode } from "uqr";
import { afterEach, describe, expect, it, vi } from "vitest";

import { decodeQrImage } from "../src/qr-image";

const paymentLink = "https://qr.alipay.com/fkx-local-test?value=a%2Fb&note=收款";
const imageFile = () => new File(["image"], "经营码.png", { type: "image/png" });

function pixels(width: number, height: number, payload: string | null, inverted = false): ImageData {
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  if (payload === null) return { data, width, height } as ImageData;
  const code = encode(payload, { border: 4, invert: inverted });
  const moduleSize = Math.floor(Math.min(width, height) / code.size);
  const left = Math.floor((width - code.size * moduleSize) / 2);
  const top = Math.floor((height - code.size * moduleSize) / 2);
  for (let row = 0; row < code.size; row++) {
    for (let column = 0; column < code.size; column++) {
      if (!code.data[row]![column]) continue;
      for (let offsetY = 0; offsetY < moduleSize; offsetY++) {
        for (let offsetX = 0; offsetX < moduleSize; offsetX++) {
          const index = ((top + row * moduleSize + offsetY) * width + left + column * moduleSize + offsetX) * 4;
          data[index] = 0; data[index + 1] = 0; data[index + 2] = 0;
        }
      }
    }
  }
  return { data, width, height } as ImageData;
}

function mockImage(payload: string | null = paymentLink, options: { width?: number; height?: number; inverted?: boolean } = {}) {
  const size = payload ? encode(payload, { border: 4 }).size * 6 : 200;
  const bitmap = { width: options.width ?? size, height: options.height ?? size, close: vi.fn() };
  const createBitmap = vi.fn(async () => bitmap);
  vi.stubGlobal("createImageBitmap", createBitmap);
  const context = {
    fillStyle: "", fillRect: vi.fn(), drawImage: vi.fn(),
    getImageData: vi.fn((_left: number, _top: number, width: number, height: number) => pixels(width, height, payload, options.inverted)),
  };
  const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
  return { bitmap, createBitmap, context, getContext };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("local QR image decoding", () => {
  it.each([false, true])("decodes real QR pixels without rewriting links (inverted: %s)", async (inverted) => {
    const { bitmap, context, getContext } = mockImage(paymentLink, { inverted });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(decodeQrImage(imageFile(), new AbortController().signal)).resolves.toBe(paymentLink);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(context.fillStyle).toBe("#ffffff");
    expect(context.fillRect).toHaveBeenCalled();
    expect(bitmap.close).toHaveBeenCalledOnce();
    expect(getContext.mock.contexts[0]).toMatchObject({ width: 0, height: 0 });
  });

  it("accepts a supported filename when the browser omits its MIME type", async () => {
    mockImage();
    await expect(decodeQrImage(new File(["image"], "code.PNG"), new AbortController().signal)).resolves.toBe(paymentLink);
  });

  it("retries at higher resolution while bounding scan size and preserving aspect ratio", async () => {
    const { bitmap, context } = mockImage(paymentLink, { width: 3000, height: 1500 });
    context.getImageData.mockImplementationOnce((_left, _top, width, height) => pixels(width, height, null));
    await expect(decodeQrImage(imageFile(), new AbortController().signal)).resolves.toBe(paymentLink);
    expect(context.drawImage.mock.calls).toEqual([[bitmap, 0, 0, 1024, 512], [bitmap, 0, 0, 2048, 1024]]);
    expect(bitmap.close).toHaveBeenCalledOnce();
  });

  it.each([
    [new File(["text"], "code.txt", { type: "text/plain" }), "请选择 PNG、JPG 或 WebP 图片。"],
    [new File(["<svg/>"], "code.png", { type: "image/svg+xml" }), "请选择 PNG、JPG 或 WebP 图片。"],
    [new File([], "empty.png", { type: "image/png" }), "图片为空，请重新选择。"],
    [new File([new Uint8Array(10 * 1024 * 1024 + 1)], "large.png", { type: "image/png" }), "图片不能超过 10 MB，请压缩或裁剪后重试。"],
  ])("rejects invalid files before allocating an image: %s", async (file, message) => {
    const { createBitmap } = mockImage();
    await expect(decodeQrImage(file, new AbortController().signal)).rejects.toThrow(message);
    expect(createBitmap).not.toHaveBeenCalled();
  });

  it("reports corrupt images without exposing browser errors", async () => {
    const { createBitmap } = mockImage();
    createBitmap.mockRejectedValueOnce(new Error("bitmap decoding failed"));
    await expect(decodeQrImage(imageFile(), new AbortController().signal)).rejects.toThrow("无法读取图片");
  });

  it.each([[0, 200], [200, 0], [9000, 1000], [6000, 5000]])("rejects excessive or invalid dimensions %s by %s and releases the bitmap", async (width, height) => {
    const { bitmap, getContext } = mockImage(null, { width, height });
    await expect(decodeQrImage(imageFile(), new AbortController().signal)).rejects.toThrow("图片尺寸过大或无效");
    expect(getContext).not.toHaveBeenCalled();
    expect(bitmap.close).toHaveBeenCalledOnce();
  });

  it("reports a missing QR code and releases pixel storage", async () => {
    const { bitmap, getContext } = mockImage(null);
    await expect(decodeQrImage(imageFile(), new AbortController().signal)).rejects.toThrow("未识别到二维码");
    expect(bitmap.close).toHaveBeenCalledOnce();
    expect(getContext.mock.contexts[0]).toMatchObject({ width: 0, height: 0 });
  });

  it.each(["short", "😀😀😀😀", " https://qr.alipay.com/test", "https://qr.alipay.com/test ", "https://qr.alipay.com/test\nnext"])("rejects invalid decoded content without trimming or rewriting it: %s", async (payload) => {
    const { bitmap } = mockImage(payload);
    await expect(decodeQrImage(imageFile(), new AbortController().signal)).rejects.toThrow("二维码内容格式不正确");
    expect(bitmap.close).toHaveBeenCalledOnce();
  });

  it("enforces the UTF-8 byte limit rather than JavaScript string length", async () => {
    mockImage("界".repeat(780));
    await expect(decodeQrImage(imageFile(), new AbortController().signal)).rejects.toThrow("2331 个 UTF-8 字节");
  });

  it("does not start a cancelled request", async () => {
    const { createBitmap } = mockImage();
    const controller = new AbortController(); controller.abort();
    await expect(decodeQrImage(imageFile(), controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(createBitmap).not.toHaveBeenCalled();
  });

  it("releases an image that finishes loading after cancellation", async () => {
    const { bitmap, createBitmap, getContext } = mockImage();
    let finish: (image: typeof bitmap) => void = () => {};
    createBitmap.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const controller = new AbortController();
    const decoding = decodeQrImage(imageFile(), controller.signal);
    controller.abort(); finish(bitmap);
    await expect(decoding).rejects.toMatchObject({ name: "AbortError" });
    expect(getContext).not.toHaveBeenCalled();
    expect(bitmap.close).toHaveBeenCalledOnce();
  });

  it("gives a manual-entry fallback when image decoding is unavailable", async () => {
    vi.stubGlobal("createImageBitmap", undefined);
    await expect(decodeQrImage(imageFile(), new AbortController().signal)).rejects.toThrow("手动粘贴经营码内容");
  });

  it("releases the bitmap when canvas access is unavailable", async () => {
    const { bitmap, getContext } = mockImage();
    getContext.mockReturnValue(null);
    await expect(decodeQrImage(imageFile(), new AbortController().signal)).rejects.toThrow("当前浏览器无法读取图片");
    expect(bitmap.close).toHaveBeenCalledOnce();
  });
});
