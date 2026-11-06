import { useEffect, useId, useRef, useState } from "react";
import { api, ApiError, result, type Site } from "@/api/client";
import { useDirtyDraft, useDraftGuard, useOperationNavigation } from "@/drafts";
import { useFixedOperation } from "@/lib/fixed-operation";
import { useOperationKey } from "@/lib/idempotency";
import { ErrorNotice } from "@/components/request-state";
import { OperationRecoveryNotice } from "@/components/operation-recovery-notice";
import { OperationNavigationDialog } from "@/components/operation-navigation-dialog";
import { CopyValue } from "@/components/copy-value";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogBody, DialogFooter,
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription,
  AlertDialogFooter, AlertDialogCancel, AlertDialogAction,
} from "@/components/admin-dialog";

type ChangeCommand = { operation_id: string; revision: number; client_id: string };

export function SiteClientIdChange({ site, onChanged, onClose, finalFocus }: {
  site: Site;
  onChanged: (site: Site) => void;
  onClose: (refresh: boolean) => void;
  finalFocus: () => HTMLElement | null;
}) {
  const [snapshot] = useState(site);
  const currentId = snapshot.api_client_id ?? snapshot.client_id;
  const [nextId, setNextId] = useState(currentId);
  const [validation, setValidation] = useState<string>();
  const [confirmation, setConfirmation] = useState<ChangeCommand | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const fieldId = useId();
  const operationKey = useOperationKey();
  const guard = useDraftGuard();
  const clearDraft = useDirtyDraft(nextId !== currentId);
  const change = useFixedOperation({
    execute: (body: ChangeCommand, signal) => result(api.changeSiteClientId({
      path: { clientId: snapshot.client_id }, body, signal,
    })),
    onSuccess: response => { clearDraft(); onChanged(response.data); },
    isSafeRejection: error => error instanceof ApiError && error.status === 422,
  });
  const navigation = useOperationNavigation(change.isPending || !!change.recovery,
    () => change.isBusy() || !!change.recovery);
  const fieldRejection = !change.recovery && change.error instanceof ApiError
    && (change.error.status === 422 || change.error.status === 409) && !!change.error.fields.client_id;
  const fieldError = validation ?? (fieldRejection && change.error instanceof ApiError ? change.error.fields.client_id : undefined);
  const needsRefresh = change.conflict || !!change.recovery;
  const locked = change.isPending || !!change.recovery || (change.conflict && !fieldRejection);
  useEffect(() => { if (fieldRejection) input.current?.focus(); }, [change.error, fieldRejection]);

  function close() {
    if (change.isBusy()) return;
    if (needsRefresh) { clearDraft(); onClose(true); }
    else {
      guard.setDialogFinalFocus(input.current);
      guard.requestDiscard(() => { clearDraft(); onClose(false); });
    }
  }
  function submit() {
    if (change.isBusy() || change.conflict) return;
    if (change.recovery) { change.submit(change.recovery); return; }
    const clientId = nextId.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(clientId)) {
      setValidation("请填写 3–64 位客户端 ID，首位为英文字母或数字，其余仅可包含英文字母、数字、点、下划线或连字符。");
      input.current?.focus();
      return;
    }
    if (clientId === currentId) return;
    const payload = { revision: snapshot.revision, client_id: clientId };
    setConfirmation({ ...payload, operation_id: operationKey(payload) });
  }
  return <Dialog open onOpenChange={(open, event) => {
      if (!open) { if (change.isBusy()) event.cancel(); else close(); }
    }}>
      <DialogContent ref={content} showCloseButton={!change.isPending} finalFocus={finalFocus}>
        <DialogHeader><DialogTitle>更换客户端 ID</DialogTitle></DialogHeader>
        <form className="contents" onSubmit={event => { event.preventDefault(); submit(); }}>
          <DialogBody>
            <DialogDescription>更换后立即生效，请同步更新业务端接入配置。旧 ID 保留占用，无法再次分配。</DialogDescription>
            <FieldGroup>
              <Field><FieldLabel>当前客户端 ID</FieldLabel><CopyValue value={currentId} label="复制当前客户端 ID" /></Field>
              <Field data-invalid={!!fieldError} data-disabled={locked}>
                <FieldLabel htmlFor={fieldId}>新客户端 ID</FieldLabel>
                <Input ref={input} id={fieldId} value={nextId} disabled={locked} autoCapitalize="none" autoCorrect="off" spellCheck={false}
                  aria-invalid={!!fieldError} aria-describedby={fieldId + "-help" + (fieldError ? " " + fieldId + "-error" : "")}
                  onChange={event => {
                    if (!change.reset()) return;
                    setNextId(event.target.value);
                    setValidation(undefined);
                  }} />
                <FieldDescription id={fieldId + "-help"}>区分大小写。3–64 位，首位为英文字母或数字，其余可用英文字母、数字、点、下划线和连字符。</FieldDescription>
                {fieldError && <FieldError id={fieldId + "-error"}>{fieldError}</FieldError>}
              </Field>
              {change.recovery ? <OperationRecoveryNotice heading="更换结果待确认" operationId={change.recovery.operation_id}
                error={change.error} conflict={change.conflict} focusOnError={!navigation.blocked} />
                : <ErrorNotice error={fieldRejection ? null : change.error} />}
            </FieldGroup>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={change.isPending} onClick={close}>{needsRefresh ? "关闭并刷新" : "取消"}</Button>
            <Button type="submit" disabled={change.isPending || change.conflict || change.isSuccess || (!change.recovery && nextId.trim() === currentId)}>
              {change.isPending ? "正在更换…" : change.recovery ? "重试上一次操作" : "继续核对"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    <AlertDialog open={!!confirmation} onOpenChange={open => { if (!open) setConfirmation(null); }}>
      <AlertDialogContent finalFocus={() => locked ? content.current : input.current}>
        <AlertDialogHeader><AlertDialogTitle>确认更换客户端 ID？</AlertDialogTitle></AlertDialogHeader>
        <DialogBody>
          <AlertDialogDescription>{snapshot.configuration.name} 的接入 ID 将立即更换，请同步更新业务端。旧 ID 将停止用于接入并继续保留占用。</AlertDialogDescription>
          <FieldGroup>
            <Field><FieldLabel>原客户端 ID</FieldLabel><CopyValue value={currentId} label="复制原客户端 ID" /></Field>
            <Field><FieldLabel>新客户端 ID</FieldLabel><CopyValue value={confirmation?.client_id ?? ""} label="复制新客户端 ID" /></Field>
          </FieldGroup>
        </DialogBody>
        <AlertDialogFooter>
          <AlertDialogCancel>返回修改</AlertDialogCancel>
          <AlertDialogAction onClick={() => { if (confirmation) change.submit(confirmation); setConfirmation(null); }}>确认更换</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    <OperationNavigationDialog navigation={navigation} operationId={change.submitted?.operation_id} pending={change.isPending}
      finalFocus={() => content.current} onLeave={() => { change.stopWaiting(); clearDraft(); onClose(true); }} />
  </Dialog>;
}
