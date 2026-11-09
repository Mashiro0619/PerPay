import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
export function CopyValue({
  value,
  label,
  secret = false,
  tooltip = false,
  buttonOnly = false,
}: {
  value: string;
  label?: string;
  secret?: boolean;
  tooltip?: boolean;
  buttonOnly?: boolean;
}) {
  const [state, setState] = useState<"idle" | "success" | "error">("idle");
  const request = useRef(0);
  const copied = state === "success";
  const failed = state === "error";
  useLayoutEffect(() => {
    setState("idle");
    return () => { request.current++; };
  }, [value]);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setState("idle"), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const block = secret || /[\r\n]/.test(value);
  const copy = () => {
    const current = ++request.current;
    setState("idle");
    if (!navigator.clipboard) {
      setState("error");
      return;
    }
    void navigator.clipboard
      .writeText(value)
      .then(() => {
        if (current === request.current) setState("success");
      })
      .catch(() => {
        if (current === request.current) setState("error");
      });
  };
  const button = (
    <Button
      variant="ghost"
      size="icon-sm"
      type="button"
      data-copy-state={state}
      aria-label={label ?? "复制内容"}
      title={tooltip ? undefined : label ?? "复制内容"}
      onClick={copy}
    >
      {copied ? <Check data-copy-feedback aria-hidden="true" /> : <Copy aria-hidden="true" />}
    </Button>
  );
  const action = tooltip ? (
    <Tooltip><TooltipTrigger render={button} /><TooltipContent>{label ?? "复制内容"}</TooltipContent></Tooltip>
  ) : button;
  return (
    <div className="relative flex min-w-0 flex-wrap items-center gap-1">
      {buttonOnly ? action : block ? (
        <div className="flex w-full flex-col gap-2">
          <div className="flex justify-end">{action}</div>
          <Textarea
            readOnly
            value={value}
            rows={8}
            className="max-h-[min(16rem,40dvh)] resize-none overflow-y-auto"
            aria-label={secret ? "密钥内容" : "可复制内容"}
            spellCheck={false}
          />
        </div>
      ) : (
        <div className="flex min-w-0 max-w-full items-center gap-1">
          <span className="min-w-0 break-all">{value}</span>
          {action}
        </div>
      )}
      <span
        role="status"
        className={failed ? "text-sm text-destructive" : "sr-only"}
      >
        {failed ? "复制失败，请选中文本手动复制。" : copied ? "已复制" : ""}
      </span>
    </div>
  );
}
