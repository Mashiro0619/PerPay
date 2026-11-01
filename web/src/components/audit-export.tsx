import { useEffect, useRef, useState } from "react";
import { Download, RefreshCw } from "lucide-react";
import { api, csvResult } from "@/api/client";
import type { AuditFilters } from "../../../src/shared/audit";
import { createdDateRange } from "../../../src/shared/created-dates";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { ListActionsMenu } from "@/components/list-actions-menu";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";

export function useAuditExport(filters: AuditFilters) {
  const active = useRef<AbortController | null>(null);
  const [pending, setPending] = useState(false);
  const [generated, setGenerated] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const scope = JSON.stringify(filters);
  useEffect(() => {
    setError(null);
    setPending(false);
    setGenerated(false);
    return () => { active.current?.abort(); active.current = null; };
  }, [scope]);

  async function download() {
    if (active.current) return;
    setGenerated(false);
    setError(null);
    try {
      const range = createdDateRange(filters.created_from, filters.created_to);
      if (!range) throw new Error("请先选择发生日期范围，再导出全部匹配日志。");
      if (range.days > 366) throw new Error("导出日期跨度最多 366 天，请缩小范围。");
    } catch (reason) {
      setError(reason instanceof Error ? reason : new Error("请检查发生日期范围。"));
      return;
    }
    const operation = new AbortController();
    active.current = operation;
    setPending(true);
    try {
      const blob = await csvResult(api.exportAuditEvents({
        signal: operation.signal,
        parseAs: "text",
        headers: { Origin: window.location.origin },
        body: { ...filters, created_from: filters.created_from!, created_to: filters.created_to! },
      }));
      if (active.current !== operation || operation.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `audit-${filters.created_from}-${filters.created_to}.csv`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setGenerated(true);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (reason) {
      if (active.current === operation && !operation.signal.aborted) setError(reason instanceof Error ? reason : new Error("导出失败，请重试。"));
    } finally {
      if (active.current === operation) { active.current = null; setPending(false); }
    }
  }
  return { pending, generated, error, download };
}
type ExportState = ReturnType<typeof useAuditExport>;

export function AuditExportButton({ state }: { state: ExportState }) {
  return <Button variant="outline" disabled={state.pending} onClick={() => { void state.download(); }}>
    {state.pending ? <Spinner data-icon="inline-start" /> : <Download data-icon="inline-start" />}导出 CSV
  </Button>;
}

export function AuditActions({ state, refresh, refreshing }: { state: ExportState; refresh: () => void; refreshing: boolean }) {
  return <ListActionsMenu label="更多审计日志操作">
    {() => <>
      <DropdownMenuItem disabled={state.pending} onClick={() => { void state.download(); }}>{state.pending ? <Spinner /> : <Download />}导出 CSV</DropdownMenuItem>
      <DropdownMenuItem disabled={refreshing} onClick={refresh}><RefreshCw />刷新日志</DropdownMenuItem>
    </>}
  </ListActionsMenu>;
}
