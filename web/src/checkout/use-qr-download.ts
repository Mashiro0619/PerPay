import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
export function useQrDownload(
  image: RefObject<HTMLImageElement | null>,
  available: boolean,
) {
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const generation = useRef(0),
    canvas = useRef<HTMLCanvasElement | null>(null),
    url = useRef<string | null>(null),
    timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const allowed = useRef(available);
  allowed.current = available;
  const cancel = useCallback(() => {
    generation.current++;
    if (canvas.current) {
      canvas.current.width = 0;
      canvas.current.height = 0;
      canvas.current = null;
    }
    if (url.current) URL.revokeObjectURL(url.current);
    url.current = null;
    clearTimeout(timer.current);
    setBusy(false);
    setMessage("");
  }, []);
  useEffect(() => {
    if (!available) cancel();
  }, [available, cancel]);
  useEffect(() => {
    const hidden = () => {
      if (document.hidden) cancel();
    };
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", cancel);
    return () => {
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", cancel);
      cancel();
    };
  }, [cancel]);
  function save() {
    if (busy || !allowed.current || document.hidden) return;
    cancel();
    const current = ++generation.current;
    const valid = () =>
      current === generation.current && allowed.current && !document.hidden;
    const failed = () => {
      if (!valid()) return;
      cancel();
      setMessage("无法生成 PNG，请重试或截图保存二维码。");
    };
    const img = image.current;
    if (
      !img ||
      !img.complete ||
      img.naturalWidth < 1 ||
      new URL(img.currentSrc || img.src, location.origin).origin !==
        location.origin
    ) {
      failed();
      return;
    }
    setBusy(true);
    try {
      const target = document.createElement("canvas");
      canvas.current = target;
      const size =
        img.naturalWidth * Math.max(1, Math.ceil(960 / img.naturalWidth));
      target.width = size;
      target.height = size;
      const context = target.getContext("2d");
      if (!context) {
        failed();
        return;
      }
      context.imageSmoothingEnabled = false;
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, size, size);
      context.drawImage(img, 0, 0, size, size);
      target.toBlob((blob) => {
        if (!valid()) return;
        if (!blob || blob.type !== "image/png") {
          failed();
          return;
        }
        try {
          url.current = URL.createObjectURL(blob);
          const link = document.createElement("a");
          link.href = url.current;
          link.download = "perpay-collection-code.png";
          document.body.append(link);
          link.click();
          link.remove();
          target.width = 0;
          target.height = 0;
          canvas.current = null;
          setBusy(false);
          setMessage("已发起 PNG 下载");
          timer.current = setTimeout(() => {
            if (url.current) URL.revokeObjectURL(url.current);
            url.current = null;
          }, 60000);
        } catch {
          failed();
        }
      }, "image/png");
    } catch {
      failed();
    }
  }
  return { busy, message, save, cancel };
}
