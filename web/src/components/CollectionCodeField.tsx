import { cn } from "cn";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Badge } from "@/components/ui/badge";
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
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
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from "react";
import { Check, ChevronDown, ImageUp } from "lucide-react";
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
  required = true,
  onValueChange,
  error,
}: {
  defaultValue: string;
  onDecoded: () => void;
  onPendingChange: (pending: boolean) => void;
  disabled?: boolean;
  required?: boolean;
  onValueChange?: (value: string) => void;
  error?: string | undefined;
}) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const contentTrigger = useRef<HTMLButtonElement>(null);
  const handoffFocus = useRef(false);
  const request = useRef<AbortController | null>(null);
  const dropzone = useRef<HTMLDivElement>(null);
  const dragDepth = useRef(0);
  const feedbackId = useId();
  const uploadLabelId = `${feedbackId}-label`;
  const uploadHintId = `${feedbackId}-hint`;
  const [feedback, setFeedback] = useState<Feedback>({ kind: "idle" });
  const [dragging, setDragging] = useState(false);
  const [value, setValue] = useState(defaultValue);
  const [contentOpen, setContentOpen] = useState(false);
  const hasCode = value !== "" && collectionCodeError(value) === null;
  const contentVisible = !hasCode || contentOpen || !!error;
  useLayoutEffect(() => {
    const shouldHandoff = handoffFocus.current;
    handoffFocus.current = false;
    if (shouldHandoff && !contentVisible) contentTrigger.current?.focus();
  }, [contentVisible, feedback.kind]);
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
      if (current.signal.aborted) return;
      const issue = collectionCodeError(payload);
      if (issue) throw new Error(issue);
      setValue(payload);
      onValueChange?.(payload);
      onDecoded();
      handoffFocus.current = document.activeElement === textarea.current;
      setContentOpen(false);
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
    <FieldGroup data-collection-code-field>
      <Input
        ref={picker}
        type="file"
        accept={qrImageAccept}
        hidden
        disabled={disabled}
        aria-label="选择收款码二维码图片"
        onChange={(event) => {
          void selectImage(event);
        }}
      />
      <Collapsible
        open={contentVisible}
        onOpenChange={setContentOpen}
        className="flex min-w-0 flex-col gap-3"
      >
        {hasCode ? (
          <Item
            ref={dropzone}
            variant="outline"
            className={cn("min-w-0", dragging && "bg-accent")}
            role="group"
            aria-label="已配置的收款码"
            aria-disabled={disabled}
            onDragEnter={handleDragEnter}
            onDragLeave={handleDragLeave}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
          >
            <ItemContent className="min-w-0 flex-[1_1_12rem]">
              <ItemTitle className="min-w-0 max-w-full line-clamp-none">
                {dragging ? "松开即可更换" : "收款码已配置"}
              </ItemTitle>
              <ItemDescription className="line-clamp-none">
                更换二维码后保存账号配置。
              </ItemDescription>
            </ItemContent>
            <ItemActions className="max-w-full flex-wrap">
              <Button
                type="button"
                variant="outline"
                className="h-auto min-h-8 max-w-full whitespace-normal"
                disabled={disabled || feedback.kind === "pending"}
                aria-busy={feedback.kind === "pending"}
                aria-describedby={feedback.kind === "error" ? feedbackId : undefined}
                onClick={() => picker.current?.click()}
              >
                {feedback.kind === "pending" ? <Spinner data-icon="inline-start" /> : <ImageUp data-icon="inline-start" />}
                {feedback.kind === "pending" ? "正在识别…" : "更换二维码"}
              </Button>
              <CollapsibleTrigger
                ref={contentTrigger}
                render={<Button type="button" variant="ghost" className="h-auto min-h-8 max-w-full whitespace-normal" disabled={disabled} />}
              >
                {contentVisible ? "收起内容" : "查看内容"}
                <ChevronDown data-icon="inline-end" />
              </CollapsibleTrigger>
            </ItemActions>
          </Item>
        ) : (
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
                {feedback.kind === "pending" ? <Spinner aria-hidden="true" /> : <ImageUp />}
              </EmptyMedia>
              <EmptyTitle id={uploadLabelId}>
                {feedback.kind === "pending"
                  ? "正在识别…"
                  : dragging
                    ? "松开即可识别"
                    : "收款码图片"}
              </EmptyTitle>
              <EmptyDescription id={uploadHintId}>
                PNG、JPG、WebP，最大 10 MB
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button
                type="button"
                variant="outline"
                disabled={disabled || feedback.kind === "pending"}
                aria-busy={feedback.kind === "pending"}
                onClick={() => picker.current?.click()}
                aria-describedby={[
                  uploadHintId,
                  feedback.kind === "error" && feedbackId,
                ].filter(Boolean).join(" ")}
              >
                上传二维码
              </Button>
            </EmptyContent>
          </Empty>
        )}
        {feedback.kind === "success" && (
          <Badge variant="outline" role="status" className="self-start">
            <Check data-icon="inline-start" />已识别
          </Badge>
        )}
        {feedback.kind === "pending" && <span className="sr-only" role="status">正在识别二维码图片。</span>}
        {feedback.kind === "error" && <FieldError id={feedbackId}>{feedback.message}</FieldError>}
        <CollapsibleContent keepMounted>
          <Field data-invalid={!!error}>
            <FieldLabel htmlFor={feedbackId + "-code"}>支付宝收款码内容</FieldLabel>
            <Textarea
              ref={textarea}
              id={feedbackId + "-code"}
              name="code_payload"
              rows={2}
              required={required}
              minLength={8}
              maxLength={2331}
              value={value}
              disabled={disabled}
              onChange={event => {
                cancelReading();
                setContentOpen(true);
                setValue(event.currentTarget.value);
                onValueChange?.(event.currentTarget.value);
              }}
              autoComplete="off"
              spellCheck={false}
              placeholder="https://qr.alipay.com/…"
              aria-invalid={!!error}
              aria-describedby={error ? feedbackId + "-code-error" : undefined}
            />
            {error && <FieldError id={feedbackId + "-code-error"}>{error}</FieldError>}
          </Field>
        </CollapsibleContent>
      </Collapsible>
    </FieldGroup>
  );
}
