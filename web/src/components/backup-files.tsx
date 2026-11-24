import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RotateCcw, Trash2 } from "lucide-react";
import { listManagedBackupFiles, type ManagedBackupFile, type MaintenanceRequest } from "@/api/maintenance";
import { useMaintenanceAction } from "@/hooks/use-maintenance";
import { count, dateTime } from "@/lib/format";
import { BusinessTable, type BusinessColumn } from "@/components/business-table";
import { CopyValue } from "@/components/copy-value";
import { QueryView } from "@/components/request-state";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/admin-empty";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { MaintenanceConfirmation } from "@/components/maintenance-operation";

export const backupFilesKey = ["backup-files"] as const;

const sizeFormatter = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });

function backupSize(bytes: number | null): string {
  if (bytes === null) return "无法读取";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const unit = bytes < 1 ? 0 : Math.min(Math.floor(Math.log2(bytes) / 10), units.length - 1);
  return sizeFormatter.format(bytes / 1024 ** unit) + " " + units[unit];
}

const columns: BusinessColumn<ManagedBackupFile>[] = [
  { id: "name", label: "文件名", layout: "identity", hideable: false,
    cell: file => <div className="flex min-w-0 flex-col items-start gap-1"><CopyValue value={file.name} label="复制备份文件名" />{file.safety_backup && <Badge variant="outline">恢复前备份</Badge>}</div> },
  { id: "created_at", label: "生成时间", layout: "datetime", hideable: false, summaryDefault: true,
    cell: file => <time dateTime={file.created_at}>{dateTime(file.created_at)}</time> },
  { id: "size_bytes", label: "文件大小", layout: "number", hideable: false, summaryDefault: true, summaryLabel: true,
    cell: file => <span title={file.size_bytes === null ? undefined : count(file.size_bytes) + " 字节"}>{backupSize(file.size_bytes)}</span> },
];

export function BackupFiles({ blocked }: { blocked: boolean }) {
  const [open, setOpen] = useState(false);
  const [selection, setSelection] = useState<{ file: ManagedBackupFile; kind: "RESTORE" | "DELETE_BACKUP"; request: MaintenanceRequest } | null>(null);
  const operation = useMaintenanceAction(() => setOpen(false));
  const files = useQuery({
    queryKey: backupFilesKey,
    queryFn: ({ signal }) => listManagedBackupFiles(signal),
    refetchOnMount: "always",
    retry: false,
  });
  function choose(file: ManagedBackupFile, kind: "RESTORE" | "DELETE_BACKUP") {
    if (!file.sha256 || !operation.reset()) return;
    setSelection({ file, kind, request: { operation_id: crypto.randomUUID(), kind, name: file.name, expected_sha256: file.sha256 } });
    setOpen(true);
  }
  const fileColumns: BusinessColumn<ManagedBackupFile>[] = [...columns, {
    id: "actions", label: "操作", layout: "actions", hideable: false,
    cell: file => <div className="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" aria-label={"恢复 " + file.name} disabled={blocked || operation.pending || operation.unknown || !file.sha256} onClick={() => choose(file, "RESTORE")}>
        <RotateCcw data-icon="inline-start" />恢复
      </Button>
      <Button variant="outline" size="sm" aria-label={"永久删除 " + file.name} disabled={blocked || operation.pending || operation.unknown || !file.sha256} onClick={() => choose(file, "DELETE_BACKUP")}>
        <Trash2 data-icon="inline-start" />永久删除
      </Button>
    </div>,
  }];
  return <><Card size="sm" data-backup-files>
    <CardHeader>
      <CardTitle role="heading" aria-level={2}>备份文件</CardTitle>
      <CardDescription>{files.data ? "共 " + count(files.data.data.items.length) + " 份，按生成时间倒序排列。" : "查看备份目录中保存的文件。"}</CardDescription>
    </CardHeader>
    <CardContent className="flex min-w-0 flex-col gap-3">
      {operation.unknown && <Button variant="outline" className="self-start" onClick={() => setOpen(true)}>查询上次提交的任务</Button>}
      <QueryView query={files}>
        {({ data }) => data.items.length ? <BusinessTable
          id="backup-files"
          items={data.items}
          columns={fileColumns}
          rowId={file => file.name}
          columnsMenu={false}
          density="compact"
          embedded
          aria-label="备份文件列表"
        /> : <Empty><EmptyHeader>
          <EmptyTitle>暂无备份文件</EmptyTitle>
          <EmptyDescription>首次备份完成后，文件会显示在这里。</EmptyDescription>
        </EmptyHeader></Empty>}
      </QueryView>
    </CardContent>
  </Card>
    <MaintenanceConfirmation open={open} onOpenChange={setOpen}
      title={selection?.kind === "RESTORE" ? "恢复这份备份？" : "永久删除这份备份？"}
      description={selection?.kind === "RESTORE" ? <>
        将恢复到 {dateTime(selection.file.created_at)} 的数据，覆盖当前业务记录和系统配置。系统会先备份当前数据；恢复期间暂停服务，完成后需要重新登录。
        <span className="mt-2 block break-all">备份文件：{selection.file.name}</span>
      </> : <>
        将永久删除这份备份文件，删除后无法使用它恢复数据。
        <span className="mt-2 block break-all">备份文件：{selection?.file.name}</span>
      </>}
      confirmLabel={selection?.kind === "RESTORE" ? "确认恢复备份" : "确认永久删除"}
      confirmPhrase={selection?.kind === "RESTORE" ? "恢复备份" : "永久删除"} destructive
      pending={operation.pending} error={operation.error} unknown={operation.unknown} refreshing={operation.refreshing}
      onRefresh={operation.refresh} onConfirm={() => { if (selection) operation.submit(selection.request); }} />
  </>;
}
