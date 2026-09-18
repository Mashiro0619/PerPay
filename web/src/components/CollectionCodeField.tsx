import { cn } from "cn";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Badge } from "@/components/ui/badge";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
  EmptyMedia,
} from "@/components/ui/empty";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from "react";
import { Check, ImageUp } from "lucide-react";
import { decodeQrImage, qrImageAccept } from "../qr-image";
import { collectionCodeError } from "../../../src/shared/collection-code";
import {
  Field,
  FieldLabel,
  FieldError,
  FieldGroup,
} from "@/components/ui/field";
type Feedback =
  | {
      kind: "idle" | "pending" | "success";
    }
  | {
      kind: "error";
      message: string;
    };
function hasFiles(
  dataTransfer: DataTransfer | null,
): dataTransfer is DataTransfer {
  return Boolean(
    dataTransfer &&
    (dataTransfer.types.includes("Files") || dataTransfer.files.length > 0),
  );
}
export function CollectionCodeField({
  defaultValue,
  onDecoded,
  onPendingChange,
  disabled = false,
  error,
}: {
  defaultValue: string;
  onDecoded: () => void;
  onPendingChange: (pending: boolean) => void;
  disabled?: boolean;
  error?: string | undefined;
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
    const resetDragging = () => {
      dragDepth.current = 0;
      setDragging(false);
    };
    if (disabled) resetDragging();
    const preventFileNavigation = (event: globalThis.DragEvent) => {
      if (!hasFiles(event.dataTransfer)) return;
      event.preventDefault();
      const inside =
        event.target instanceof Node &&
        dropzone.current?.contains(event.target);
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
  useEffect(
    () => () => {
      request.current?.abort();
      request.current = null;
    },
    [],
  );
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
      if (!current.signal.aborted)
        setFeedback({
          kind: "error",
          message:
            error instanceof Error
              ? error.message
              : "图片识别失败，请换一张图片重试。",
        });
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
      setFeedback({
        kind: "error",
        message:
          files.length === 0
            ? "请拖入一张 PNG、JPG 或 WebP 二维码图片。"
            : "一次只能识别一张二维码图片，请重新选择。",
      });
      return;
    }
    void processImage(file);
  }
  return (
    <FieldGroup>
      <Empty
        ref={dropzone}
        className={cn("border border-dashed", dragging && "bg-accent")}
        role="group"
        aria-label="二维码图片上传"
        aria-disabled={disabled}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        <EmptyHeader>
          <EmptyMedia variant="icon">
            {feedback.kind === "pending" ? (
              <Spinner aria-hidden="true" />
            ) : (
              <ImageUp />
            )}
          </EmptyMedia>
          <EmptyTitle id={uploadLabelId}>
            {feedback.kind === "pending"
              ? "正在识别…"
              : dragging
                ? "松开即可识别"
                : "拖入经营码二维码"}
          </EmptyTitle>
          <EmptyDescription id={uploadHintId}>
            PNG、JPG、WebP，最大 10 MB
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Input
            ref={picker}
            type="file"
            accept={qrImageAccept}
            hidden
            disabled={disabled}
            aria-label="选择经营码二维码图片"
            onChange={(event) => {
              void selectImage(event);
            }}
          />
          <Button
            type="button"
            variant="outline"
            disabled={disabled || feedback.kind === "pending"}
            aria-busy={feedback.kind === "pending"}
            onClick={() => picker.current?.click()}
            aria-describedby={[
              uploadHintId,
              feedback.kind === "error" && feedbackId,
            ]
              .filter(Boolean)
              .join(" ")}
          >
            上传二维码
          </Button>
          {feedback.kind === "success" && (
            <Badge variant="outline" role="status">
              <Check data-icon="inline-start" />
              已识别
            </Badge>
          )}
          {feedback.kind === "pending" && (
            <span className="sr-only" role="status">
              正在识别二维码图片。
            </span>
          )}
          {feedback.kind === "error" && (
            <FieldError id={feedbackId}>{feedback.message}</FieldError>
          )}
        </EmptyContent>
      </Empty>
      <Field data-invalid={!!error}>
        <FieldLabel htmlFor={feedbackId + "-code"}>支付宝经营码内容</FieldLabel>
        <Textarea
          ref={textarea}
          id={feedbackId + "-code"}
          name="code_payload"
          rows={2}
          required
          minLength={8}
          maxLength={2331}
          defaultValue={defaultValue}
          disabled={disabled}
          onChange={cancelReading}
          autoComplete="off"
          spellCheck={false}
          placeholder="https://qr.alipay.com/…"
          aria-invalid={!!error}
          aria-describedby={error ? feedbackId + "-code-error" : undefined}
        />
        {error && (
          <FieldError id={feedbackId + "-code-error"}>{error}</FieldError>
        )}
      </Field>
    </FieldGroup>
  );
}
