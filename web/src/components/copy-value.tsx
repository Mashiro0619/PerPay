import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
export function CopyValue({
  value,
  label,
  secret = false,
}: {
  value: string;
  label?: string;
  secret?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const block = secret || /[\r\n]/.test(value);
  const copy = () => {
    if (!navigator.clipboard) {
      setFailed(true);
      return;
    }
    void navigator.clipboard
      .writeText(value)
      .then(() => {
        setCopied(true);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  };
  const action = (
    <Button
      variant="ghost"
      size="icon-sm"
      type="button"
      aria-label={label ?? "复制内容"}
      title={label ?? "复制内容"}
      onClick={copy}
    >
      {copied ? <Check /> : <Copy />}
    </Button>
  );
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      {block ? (
        <div className="flex w-full flex-col gap-2">
          <div className="flex justify-end">{action}</div>
          <Textarea
            readOnly
            value={value}
            rows={8}
            aria-label={secret ? "密钥内容" : "可复制内容"}
            spellCheck={false}
          />
        </div>
      ) : (
        <>
          <span className="min-w-0 break-all">{value}</span>
          {action}
        </>
      )}
      <span
        role="status"
        className={failed ? "text-sm text-destructive" : "sr-only"}
      >
        {failed ? "无法自动复制，请选中文本手动复制。" : copied ? "已复制" : ""}
      </span>
    </div>
  );
}
