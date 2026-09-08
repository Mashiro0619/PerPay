import { useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";

import { useOperationKey } from "../lib/idempotency";
import { Button, Dialog, ErrorNotice, Field } from "./ui";

export function ReasonDialog({ title, description, action, children, execute, onClose, onSuccess }: {
  title: string; description: string; action: string; children?: ReactNode;
  execute: (reason: string, operationId: string) => Promise<unknown>;
  onClose: () => void; onSuccess: () => void;
}) {
  const [reason, setReason] = useState("");
  const [accepted, setAccepted] = useState(false);
  const operationKey = useOperationKey();
  const mutation = useMutation({ mutationFn: () => execute(reason.trim(), operationKey(reason.trim())), onSuccess });
  return <Dialog title={title} description={description} onClose={onClose} busy={mutation.isPending}>
    {children}
    <form className="form-stack" onSubmit={(event) => { event.preventDefault(); if (reason.trim() && accepted) mutation.mutate(); }}>
      <Field label="操作理由"><textarea name="reason" required maxLength={500} rows={3} value={reason} disabled={mutation.isPending} onChange={(event) => setReason(event.target.value)} /></Field>
      <label className="checkbox-field"><input type="checkbox" required checked={accepted} disabled={mutation.isPending} onChange={(event) => setAccepted(event.target.checked)} /><span>我已核对信息，确认执行此操作。</span></label>
      <ErrorNotice error={mutation.error} />
      <div className="form-actions"><Button onClick={onClose} disabled={mutation.isPending}>取消</Button><Button type="submit" variant="danger" pending={mutation.isPending} disabled={!accepted || !reason.trim()}>{action}</Button></div>
    </form>
  </Dialog>;
}
