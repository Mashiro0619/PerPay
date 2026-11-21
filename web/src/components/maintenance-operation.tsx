import { useEffect, useId, useState, useSyncExternalStore, type ReactNode } from "react";
import { CircleCheck } from "lucide-react";
import { maintenanceJobRequiresLogin, type MaintenanceJob } from "@/api/maintenance";
import { getRestoreSessionHold, subscribeRestoreSessionHold } from "@/api/client";
import { dateTime } from "@/lib/format";
import { Link } from "@/navigation";
import { CopyValue } from "@/components/copy-value";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/admin-dialog";
import { ErrorNotice } from "@/components/request-state";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";

export function MaintenanceJobNotice({ title, message, running, failed, startedAt, finishedAt, children }: {
  title: string;
  message: string;
  running: boolean;
  failed: boolean;
  startedAt: number;
  finishedAt: number | null;
  children?: ReactNode;
}) {
  return <Alert variant={failed ? "destructive" : "default"} role={failed ? "alert" : "status"}>
    {running ? <Spinner /> : !failed ? <CircleCheck /> : null}
    <AlertTitle>{title}</AlertTitle>
    <AlertDescription className="flex min-w-0 flex-col gap-2">
      <span>{message}</span>
      <span>{finishedAt === null ? "开始于 " + dateTime(startedAt) : (failed ? "失败于 " : "完成于 ") + dateTime(finishedAt)}</span>
      {children}
    </AlertDescription>
  </Alert>;
}

const operationNames = { BACKUP: "备份", RESTORE: "恢复备份", DELETE_BACKUP: "删除备份", ARCHIVE: "历史归档" } as const;

export function MaintenanceJobResult({ job }: { job: MaintenanceJob | null }) {
  const restoreSessionHold = useSyncExternalStore(subscribeRestoreSessionHold, getRestoreSessionHold);
  if (!job) return null;
  const running = job.status === "QUEUED" || job.status === "RUNNING";
  const name = operationNames[job.kind];
  return <MaintenanceJobNotice title={name + (running ? "进行中" : job.status === "FAILED" ? "失败" : "已完成")}
    message={job.error ?? job.message} running={running} failed={job.status === "FAILED"}
    startedAt={job.started_at} finishedAt={job.finished_at}>
    {running && (job.kind === "ARCHIVE" || job.kind === "RESTORE") && <span>业务暂不可用，任务完成后自动恢复。可留在本页查看进度。</span>}
    {job.result?.backup_name && <CopyValue value={job.result.backup_name} label="复制备份文件名" />}
    {job.result?.safety_backup_name && <span>恢复前副本：<CopyValue value={job.result.safety_backup_name} label="复制恢复前备份文件名" /></span>}
    {job.result?.archive_id && <Link global to={"/settings/archives/" + encodeURIComponent(job.result.archive_id)}>查看归档</Link>}
    {maintenanceJobRequiresLogin(job) && restoreSessionHold === job.id && <><span>请重新登录后继续使用系统。</span><Button variant="outline" size="sm" className="self-start" onClick={() => window.dispatchEvent(new Event("perpay:session-expired"))}>重新登录</Button></>}
  </MaintenanceJobNotice>;
}

export function MaintenanceConfirmation({ open, onOpenChange, title, description, confirmLabel, confirmPhrase,
  destructive = false, pending, error, unknown, refreshing, onConfirm, onRefresh }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  confirmPhrase?: string;
  destructive?: boolean;
  pending: boolean;
  error: Error | null;
  unknown: boolean;
  refreshing: boolean;
  onConfirm: () => void;
  onRefresh: () => void;
}) {
  const id = useId();
  const [text, setText] = useState("");
  useEffect(() => { if (open) setText(""); }, [open]);
  return <AlertDialog open={open} onOpenChange={(next, event) => {
    if (!next && pending) event.cancel();
    else onOpenChange(next);
  }}>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>{title}</AlertDialogTitle>
        <AlertDialogDescription>{description}</AlertDialogDescription>
      </AlertDialogHeader>
      {confirmPhrase && <FieldGroup><Field data-disabled={pending || unknown}>
        <FieldLabel htmlFor={id}>输入“{confirmPhrase}”确认</FieldLabel>
        <Input id={id} autoComplete="off" value={text} onChange={event => setText(event.target.value)} disabled={pending || unknown} />
      </Field></FieldGroup>}
      {unknown && <Alert>
        <AlertTitle>提交结果待确认</AlertTitle>
        <AlertDescription>请求未完整返回，请查询任务状态后再继续。</AlertDescription>
      </Alert>}
      <ErrorNotice error={error} />
      <AlertDialogFooter>
        <AlertDialogCancel disabled={pending}>取消</AlertDialogCancel>
        {unknown ? <Button variant="outline" disabled={refreshing} onClick={onRefresh}>
          {refreshing && <Spinner data-icon="inline-start" />}查询任务状态
        </Button> : <AlertDialogAction variant={destructive ? "destructive" : "default"}
          disabled={pending || (!!confirmPhrase && text !== confirmPhrase)} onClick={onConfirm}>
          {pending && <Spinner data-icon="inline-start" />}{pending ? "正在提交…" : confirmLabel}
        </AlertDialogAction>}
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}
