import { useEffect, useId, useRef, useState, type ChangeEvent } from "react";
import { Check, ImageUp } from "lucide-react";

import { decodeQrImage, qrImageAccept } from "../qr-image";
import { Button, Field } from "./ui";

type Feedback = { kind: "idle" | "pending" | "success" } | { kind: "error"; message: string };

export function CollectionCodeField({ defaultValue, onDecoded, onPendingChange }: {
  defaultValue: string; onDecoded: () => void; onPendingChange: (pending: boolean) => void;
}) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const request = useRef<AbortController | null>(null);
  const feedbackId = useId();
  const [feedback, setFeedback] = useState<Feedback>({ kind: "idle" });
  useEffect(() => () => { request.current?.abort(); request.current = null; }, []);

  function cancelReading() {
    request.current?.abort();
    request.current = null;
    setFeedback({ kind: "idle" });
    onPendingChange(false);
  }

  async function selectImage(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    request.current?.abort();
    const current = new AbortController();
    request.current = current;
    setFeedback({ kind: "pending" });
    onPendingChange(true);
    try {
      const payload = await decodeQrImage(file, current.signal);
      if (current.signal.aborted || !textarea.current) return;
      textarea.current.value = payload;
      onDecoded();
      setFeedback({ kind: "success" });
    } catch (error) {
      if (!current.signal.aborted) setFeedback({ kind: "error", message: error instanceof Error ? error.message : "图片识别失败，请换一张图片重试。" });
    } finally {
      if (request.current === current) {
        request.current = null;
        onPendingChange(false);
      }
    }
  }

  return <Field label="支付宝经营码内容">
    <textarea ref={textarea} name="code_payload" rows={4} required minLength={8} maxLength={2331} defaultValue={defaultValue}
      onChange={cancelReading} autoComplete="off" spellCheck={false} placeholder="粘贴链接，或上传二维码图片识别" />
    <div className="collection-code-actions">
      <input ref={picker} type="file" accept={qrImageAccept} hidden aria-label="选择经营码二维码图片" onChange={(event) => { void selectImage(event); }} />
      <Button pending={feedback.kind === "pending"} onClick={() => picker.current?.click()} aria-describedby={feedback.kind === "error" ? feedbackId : undefined}>
        {feedback.kind !== "pending" && <ImageUp size={16} aria-hidden="true" />}{feedback.kind === "pending" ? "正在识别…" : "上传二维码图片"}
      </Button>
      <span className={feedback.kind === "success" ? "collection-code-status" : "sr-only"} role="status">{feedback.kind === "success" && <><Check size={16} aria-hidden="true" />已识别，请核对后保存。</>}</span>
      {feedback.kind === "error" && <span id={feedbackId} className="field-error" role="alert">{feedback.message}</span>}
    </div>
  </Field>;
}
