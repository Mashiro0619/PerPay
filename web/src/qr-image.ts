const maximumFileBytes = 10 * 1024 * 1024;
const maximumPixels = 24_000_000;
const maximumImageEdge = 8192;

export const qrImageAccept = "image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp";

export async function decodeQrImage(file: File, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) &&
    !(file.type === "" && /\.(png|jpe?g|webp)$/i.test(file.name))) {
    throw new Error("请选择 PNG、JPG 或 WebP 图片。");
  }
  if (file.size === 0) throw new Error("图片为空，请重新选择。");
  if (file.size > maximumFileBytes) throw new Error("图片不能超过 10 MB，请压缩或裁剪后重试。");
  if (typeof createImageBitmap !== "function") throw new Error("当前浏览器不支持图片识别，请更新浏览器或手动粘贴经营码内容。");

  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file); }
  catch { throw new Error("无法读取图片，请重新导出为 PNG、JPG 或 WebP 后重试。"); }
  const canvas = document.createElement("canvas");
  try {
    signal.throwIfAborted();
    const longestEdge = Math.max(bitmap.width, bitmap.height);
    if (!bitmap.width || !bitmap.height || longestEdge > maximumImageEdge || bitmap.width * bitmap.height > maximumPixels) {
      throw new Error("图片尺寸过大或无效，请裁剪到二维码区域后重试。");
    }
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("当前浏览器无法读取图片，请换一个浏览器或手动粘贴经营码内容。");
    const { default: readQr } = await import("jsqr").catch(() => {
      throw new Error("识别组件加载失败，请重试或手动粘贴经营码内容。");
    });
    for (const edge of [1024, 2048]) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      signal.throwIfAborted();
      const scale = Math.min(1, edge / longestEdge);
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const image = context.getImageData(0, 0, canvas.width, canvas.height);
      const code = readQr(image.data, image.width, image.height, { inversionAttempts: "attemptBoth" });
      if (code) {
        const payload = code.data;
        if (Array.from(payload).length < 8 || /[\ud800-\udfff]/u.test(payload) ||
          payload !== payload.trim() || /[\u0000-\u001f\u007f]/.test(payload)) {
          throw new Error("二维码内容格式不正确，请换一张经营码图片。");
        }
        if (new TextEncoder().encode(payload).length > 2331) throw new Error("二维码内容超过 2331 个 UTF-8 字节，请换一张经营码图片。");
        return payload;
      }
      if (longestEdge <= edge) break;
    }
    throw new Error("未识别到二维码，请上传清晰、完整的二维码图片。");
  } finally {
    bitmap.close();
    canvas.width = 0;
    canvas.height = 0;
  }
}
