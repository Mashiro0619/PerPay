import { useId, useLayoutEffect, useRef, type ComponentProps } from "react";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/admin-dialog";
import { CopyValue } from "@/components/copy-value";
import { ErrorNotice, Loading } from "@/components/request-state";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupTextarea } from "@/components/ui/input-group";

export type SecretDialogValue = { label: string; value: string; multiline?: boolean };

export function SecretViewDialog({ open, title, values = [], pending = false, error = null, onClose, onRetry, finalFocus }: {
  open: boolean;
  title: string;
  values?: SecretDialogValue[];
  pending?: boolean;
  error?: unknown;
  onClose: () => void;
  onRetry?: () => void;
  finalFocus?: ComponentProps<typeof DialogContent>["finalFocus"];
}) {
  const id = useId();
  const closeButton = useRef<HTMLButtonElement>(null);
  const fields = useRef<HTMLDivElement>(null);
  const firstValue = values[0]?.value;
  const compact = values.length < 2 && !values.some(field => field.multiline ?? /[\r\n]/.test(field.value));
  useLayoutEffect(() => {
    if (open && !pending && !error && firstValue !== undefined) {
      fields.current?.querySelector<HTMLInputElement | HTMLTextAreaElement>("input, textarea")?.focus({ preventScroll: true });
    }
  }, [open, pending, error, firstValue]);
  return <Dialog presentation="dialog" open={open} onOpenChange={next => { if (!next) onClose(); }}>
    <DialogContent kind={compact ? "compact" : "form"} initialFocus={() => fields.current?.querySelector<HTMLInputElement | HTMLTextAreaElement>("input, textarea") ?? closeButton.current} finalFocus={finalFocus}>
      <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
      <DialogBody>
        {pending ? <Loading label="正在读取密钥…" /> : error ? <>
          <ErrorNotice error={error} showDiagnostics={false} />
          {onRetry && <Button type="button" variant="outline" className="self-start" onClick={onRetry}>重新读取</Button>}
        </> : <FieldGroup ref={fields} className="min-w-0">
          {values.map((field, index) => {
            const multiline = field.multiline ?? /[\r\n]/.test(field.value);
            const inputId = id + "-" + index;
            return <Field key={field.label} className="min-w-0">
              <FieldLabel htmlFor={inputId} className={values.length === 1 ? "sr-only" : undefined}>{field.label}</FieldLabel>
              <InputGroup>
                {multiline
                  ? <InputGroupTextarea id={inputId} readOnly value={field.value} rows={6}
                    className="max-h-[min(16rem,40dvh)] overflow-y-auto" spellCheck={false} autoComplete="off" />
                  : <InputGroupInput id={inputId} readOnly value={field.value} spellCheck={false} autoComplete="off" />}
                <InputGroupAddon align={multiline ? "block-end" : "inline-end"} className={multiline ? "justify-end" : undefined}>
                  <CopyValue value={field.value} label={"复制" + field.label} buttonOnly />
                </InputGroupAddon>
              </InputGroup>
            </Field>;
          })}
        </FieldGroup>}
      </DialogBody>
      <DialogFooter><Button ref={closeButton} type="button" variant="outline" onClick={onClose}>关闭</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
