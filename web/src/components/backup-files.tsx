import { useQuery } from "@tanstack/react-query";
import { api, result, type BackupFile } from "@/api/client";
import { count, dateTime } from "@/lib/format";
import { BusinessTable, type BusinessColumn } from "@/components/business-table";
import { CopyValue } from "@/components/copy-value";
import { QueryView } from "@/components/request-state";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/admin-empty";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const backupFilesKey = ["backup-files"] as const;

const sizeFormatter = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });

function backupSize(bytes: number | null): string {
  if (bytes === null) return "无法读取";
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  const unit = bytes < 1 ? 0 : Math.min(Math.floor(Math.log2(bytes) / 10), units.length - 1);
  return sizeFormatter.format(bytes / 1024 ** unit) + " " + units[unit];
}

const columns: BusinessColumn<BackupFile>[] = [
  { id: "name", label: "文件名", layout: "identity", hideable: false,
    cell: file => <CopyValue value={file.name} label="复制备份文件名" /> },
  { id: "created_at", label: "生成时间", layout: "datetime", hideable: false, summaryDefault: true,
    cell: file => <time dateTime={file.created_at}>{dateTime(file.created_at)}</time> },
  { id: "size_bytes", label: "文件大小", layout: "number", hideable: false, summaryDefault: true, summaryLabel: true,
    cell: file => <span title={file.size_bytes === null ? undefined : count(file.size_bytes) + " 字节"}>{backupSize(file.size_bytes)}</span> },
];

export function BackupFiles() {
  const files = useQuery({
    queryKey: backupFilesKey,
    queryFn: ({ signal }) => result(api.listBackupFiles({ signal })),
    refetchOnMount: "always",
    retry: false,
  });
  return <Card size="sm" data-backup-files>
    <CardHeader>
      <CardTitle role="heading" aria-level={2}>备份文件</CardTitle>
      <CardDescription>{files.data ? "共 " + count(files.data.data.items.length) + " 份，按生成时间倒序排列。" : "查看备份目录中保存的文件。"}</CardDescription>
    </CardHeader>
    <CardContent className="min-w-0">
      <QueryView query={files}>
        {({ data }) => data.items.length ? <BusinessTable
          id="backup-files"
          items={data.items}
          columns={columns}
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
  </Card>;
}
