import { useEffect, useId, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { Check, ImageUp, LoaderCircle } from "lucide-react";

import { decodeQrImage, qrImageAccept } from "../qr-image";
import { collectionCodeError } from "../../../src/shared/collection-code";
import { Field } from "./ui";

type Feedback = { kind: "idle" | "pending" | "success" } | { kind: "error"; message: string };

function hasFiles(dataTransfer: DataTransfer | null): dataTransfer is DataTransfer {
  return Boolean(dataTransfer && (dataTransfer.types.includes("Files") || dataTransfer.files.length > 0));
}

export function CollectionCodeField({ defaultValue, onDecoded, onPendingChange, disabled = false, error }: {
  defaultValue: string; onDecoded: () => void; onPendingChange: (pending: boolean) => void; disabled?: boolean; error?: string | undefined;
}) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const request = useRef<AbortController | null>(null);
  const dropzone = useRef<HTMLDivElement>(null);
  const dragDepth = useRef(0);
  const feedbackId = useId();
  const uploadLabelId = `${feedbackId}-label`;
  const uploadHintId = `${feedbackId}-hint`;
  const [feedback, setFeedback] = useState<Feedback>({ kind: "idle" });
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    const resetDragging = () => { dragDepth.current = 0; setDragging(false); };
    if (disabled) resetDragging();
    const preventFileNavigation = (event: globalThis.DragEvent) => {
      if (!hasFiles(event.dataTransfer)) return;
      event.preventDefault();
      const inside = event.target instanceof Node && dropzone.current?.contains(event.target);
      event.dataTransfer.dropEffect = inside && !disabled ? "copy" : "none";
      if (!inside || event.type === "drop") resetDragging();
    };
    window.addEventListener("dragover", preventFileNavigation);
    window.addEventListener("drop", preventFileNavigation);
    window.addEventListener("blur", resetDragging);
    window.addEventListener("dragend", resetDragging);
    return () => {
      window.removeEventListener("dragover", preventFileNavigation);
      window.removeEventListener("drop", preventFileNavigation);
      window.removeEventListener("blur", resetDragging);
      window.removeEventListener("dragend", resetDragging);
    };
  }, [disabled]);
  useEffect(() => () => { request.current?.abort(); request.current = null; }, []);

  function cancelReading() {
    request.current?.abort();
    request.current = null;
    setFeedback({ kind: "idle" });
    onPendingChange(false);
  }

  async function processImage(file: File) {
    if (disabled) return;
    request.current?.abort();
    const current = new AbortController();
    request.current = current;
    setFeedback({ kind: "pending" });
    onPendingChange(true);
    try {
      const payload = await decodeQrImage(file, current.signal);
      if (current.signal.aborted || !textarea.current) return;
      const issue = collectionCodeError(payload);
      if (issue) throw new Error(issue);
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

  async function selectImage(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (file) await processImage(file);
  }

  function handleDragEnter(event: DragEvent<HTMLDivElement>) {
    if (!hasFiles(event.dataTransfer) || disabled) return;
    event.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  }

  function handleDragLeave() {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    if (!hasFiles(event.dataTransfer) || disabled) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDragging(true);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    if (!hasFiles(event.dataTransfer)) return;
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (disabled) return;
    const files = Array.from(event.dataTransfer.files);
    const file = files[0];
    if (files.length !== 1 || !file) {
      cancelReading();
      setFeedback({ kind: "error", message: files.length === 0 ? "请拖入一张 PNG、JPG 或 WebP 二维码图片。" : "一次只能识别一张二维码图片，请重新选择。" });
      return;
    }
    void processImage(file);
  }

  return <div className="collection-code">
    <div ref={dropzone} className={`collection-code-dropzone${dragging ? " is-dragging" : ""}`} role="group" aria-label="二维码图片上传" aria-disabled={disabled}
      onDragEnter={handleDragEnter} onDragLeave={handleDragLeave} onDragOver={handleDragOver} onDrop={handleDrop}>
      <input ref={picker} type="file" accept={qrImageAccept} hidden disabled={disabled} aria-label="选择经营码二维码图片" onChange={(event) => { void selectImage(event); }} />
      <button type="button" className="collection-code-upload" disabled={disabled || feedback.kind === "pending"} aria-busy={feedback.kind === "pending"}
        onClick={() => picker.current?.click()} aria-labelledby={uploadLabelId} aria-describedby={[uploadHintId, feedback.kind === "error" && feedbackId].filter(Boolean).join(" ")}>
        {feedback.kind === "pending" ? <LoaderCircle size={28} className="spinner" aria-hidden="true" /> : <ImageUp size={28} aria-hidden="true" />}
        <span id={uploadLabelId} className="collection-code-upload-title">{feedback.kind === "pending" ? "正在识别…" : dragging ? "松开即可识别" : "点击或拖拽二维码图片"}</span>
        <span id={uploadHintId} className="collection-code-upload-hint">PNG、JPG、WebP，最大 10 MB</span>
      </button>
      <span className={feedback.kind === "success" ? "collection-code-status" : "sr-only"} role="status">{feedback.kind === "success" ? <><Check size={16} aria-hidden="true" />已识别，请核对后保存。</> : feedback.kind === "pending" ? "正在识别二维码图片。" : dragging ? "松开即可识别。" : ""}</span>
      {feedback.kind === "error" && <span id={feedbackId} className="field-error" role="alert">{feedback.message}</span>}
    </div>
    <Field label="支付宝经营码内容" className="collection-code-editor" error={error}>
      <textarea ref={textarea} name="code_payload" rows={2} required minLength={8} maxLength={2331} defaultValue={defaultValue} disabled={disabled}
        onChange={cancelReading} autoComplete="off" spellCheck={false} placeholder="识别后自动填入，也可直接粘贴或修改" />
    </Field>
  </div>;
}
