import { useEffect, useRef, useState } from "react";
import { keepPreviousData, useIsFetching, useMutation, useQuery } from "@tanstack/react-query";
import { useLocation, useParams, useSearchParams } from "react-router";
import { beijingDate, createdDateRange } from "../../../src/shared/created-dates";
import { Archive, Download, Trash2 } from "lucide-react";
import { ApiError, queryClient } from "@/api/client";
import {
  deleteHistoryArchive, downloadHistoryArchive, getArchivedOrder, getHistoryArchive, getHistoryArchiveRecords,
  historyArchiveKey, historyArchivesKey, listHistoryArchives,
  type ArchiveOrderSummary, type HistoryArchiveRecord, type HistoryArchiveSummary,
} from "@/api/history-archives";
import { Link, useNavigate } from "@/navigation";
import { count, dateTime, money, shortId } from "@/lib/format";
import { useCursor } from "@/lib/cursor";
import { isOperationResultUnknown, useOperationWait } from "@/hooks/use-operation-wait";
import { useMaintenanceAction, useMaintenanceJobs } from "@/hooks/use-maintenance";
import { MaintenanceConfirmation, MaintenanceJobResult } from "@/components/maintenance-operation";
import { BusinessTable, type BusinessColumn } from "@/components/business-table";
import { CopyValue } from "@/components/copy-value";
import { CursorPagination } from "@/components/cursor-pagination";
import { DetailFields, DetailNavigation, DetailPage, TechnicalDetails } from "@/components/detail/DetailPrimitives";
import { StatusBadge } from "@/components/business-status";
import { useSuccessToast } from "@/components/Feedback";
import { PageHeading } from "@/components/page-heading";
import { PageHeaderActions } from "@/components/page-header-actions";
import { RefreshButton } from "@/components/refresh-button";
import { ErrorNotice, Loading, QueryView } from "@/components/request-state";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/admin-empty";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/admin-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const archivePath = (id: string) => "/settings/archives/" + encodeURIComponent(id);
const sizeFormatter = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });
function archiveSize(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const unit = bytes < 1 ? 0 : Math.min(Math.floor(Math.log2(bytes) / 10), units.length - 1);
  return sizeFormatter.format(bytes / 1024 ** unit) + " " + units[unit];
}

function archiveDateError(value: string): string {
  if (!value) return "请选择归档截止日期。";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return "请输入四位年份，日期格式为 YYYY-MM-DD。";
  try { createdDateRange(value, value); }
  catch { return "请选择有效日期。"; }
  return value > beijingDate() ? "归档截止日期不能晚于今天。" : "";
}

const archiveColumns: BusinessColumn<HistoryArchiveSummary>[] = [
  { id: "archive", label: "归档", layout: "identity", hideable: false, cell: archive => <div className="flex min-w-0 flex-col gap-1">
    {archive.status === "AVAILABLE" ? <Link global to={archivePath(archive.archive_id)} className="text-primary underline-offset-4 hover:underline">{dateTime(archive.created_at)}</Link> : <span>{dateTime(archive.created_at)}</span>}
    <span className="text-xs text-muted-foreground">{shortId(archive.archive_id)}</span>
  </div> },
  { id: "before", label: "截止时间（不含）", layout: "datetime", hideable: false, summaryDefault: true, summaryLabel: true, cell: archive => dateTime(archive.before) },
  { id: "orders", label: "订单", layout: "number", hideable: false, summaryDefault: true, summaryLabel: true, cell: archive => count(archive.order_count) },
  { id: "ledger", label: "流水", layout: "number", hideable: false, summaryDefault: true, summaryLabel: true, cell: archive => count(archive.ledger_count) },
  { id: "size", label: "文件大小", layout: "number", hideable: false, summaryDefault: true, summaryLabel: true, cell: archive => archiveSize(archive.size_bytes) },
  { id: "status", label: "状态", layout: "status", hideable: false, summaryDefault: true, cell: archive => <div className="flex flex-col items-start gap-1">
    <Badge variant={archive.deletion_pending ? "warning" : archive.status === "AVAILABLE" ? "outline" : "secondary"}>{archive.deletion_pending ? "删除待完成" : archive.status === "AVAILABLE" ? "长期保留" : "已永久删除"}</Badge>
    {archive.deleted_at !== null && <span className="text-xs text-muted-foreground">{dateTime(archive.deleted_at)}</span>}
  </div> },
  { id: "actions", label: "操作", layout: "actions", hideable: false, cell: archive => archive.deletion_pending ? <RetryArchiveDeletion archive={archive} /> : null },
];

function RetryArchiveDeletion({ archive }: { archive: HistoryArchiveSummary }) {
  const wait = useOperationWait();
  const success = useSuccessToast();
  const remove = useMutation({
    networkMode: "always", retry: false,
    mutationFn: () => wait(signal => deleteHistoryArchive(archive, signal)),
    onSuccess: () => { success("归档文件已永久删除"); },
    onSettled: () => queryClient.invalidateQueries({ queryKey: historyArchivesKey }),
  });
  return <div className="flex min-w-0 flex-col gap-2">
    <Button variant="outline" size="sm" disabled={remove.isPending} onClick={() => remove.mutate()}>{remove.isPending && <Spinner data-icon="inline-start" />}重试删除</Button>
    <ErrorNotice error={remove.error} />
  </div>;
}

function ArchiveCreator({ blocked }: { blocked: boolean }) {
  const [before, setBefore] = useState("");
  const [dateError, setDateError] = useState("");
  const [open, setOpen] = useState(false);
  const [request, setRequest] = useState<{ operation_id: string; kind: "ARCHIVE"; before: string } | null>(null);
  const operation = useMaintenanceAction(() => setOpen(false));
  const dateInput = useRef<HTMLInputElement>(null);
  useEffect(() => { dateInput.current?.setCustomValidity(dateError); }, [dateError]);
  function changeDate(input: HTMLInputElement) {
    const value = input.value;
    if (/^\d{5,}-/.test(value)) {
      input.value = before;
      setDateError("年份最多四位，请重新输入或选择日期。");
      return;
    }
    setBefore(value);
    setDateError(value ? archiveDateError(value) : "");
  }
  function confirmArchive() {
    if (operation.unknown) { setOpen(true); return; }
    const error = archiveDateError(before);
    setDateError(error);
    if (error) { dateInput.current?.focus(); return; }
    operation.reset();
    setRequest({ operation_id: crypto.randomUUID(), kind: "ARCHIVE", before });
    setOpen(true);
  }
  return <><Card size="sm">
    <CardHeader>
      <CardTitle role="heading" aria-level={2}>创建历史归档</CardTitle>
      <CardDescription>将截止日期前、已结束且无待处理事项的数据移入归档，减少主库和日常备份体积。</CardDescription>
    </CardHeader>
    <CardContent className="flex min-w-0 flex-col gap-4">
      <form noValidate onSubmit={event => { event.preventDefault(); confirmArchive(); }}>
        <FieldGroup>
          <Field className="max-w-sm" data-invalid={!!dateError} data-disabled={blocked || operation.pending || operation.unknown}>
            <FieldLabel htmlFor="archive-before">归档截止日期（北京时间，不含当天）</FieldLabel>
            <Input ref={dateInput} id="archive-before" type="date" required min="1970-01-01" max={beijingDate()} value={before}
              disabled={blocked || operation.pending || operation.unknown} aria-invalid={!!dateError}
              aria-describedby={dateError ? "archive-before-error" : "archive-before-description"}
              onChange={event => changeDate(event.currentTarget)} />
            <FieldDescription id="archive-before-description">只归档此日期之前、已结束且无待处理事项的记录。</FieldDescription>
            {dateError && <FieldError id="archive-before-error">{dateError}</FieldError>}
          </Field>
          <Field orientation="horizontal"><Button type="submit" variant="outline" disabled={operation.pending || (blocked && !operation.unknown)}>
            <Archive data-icon="inline-start" />{operation.unknown ? "查询归档任务" : "创建历史归档"}
          </Button></Field>
        </FieldGroup>
      </form>
    </CardContent>
  </Card>
    <MaintenanceConfirmation open={open} onOpenChange={setOpen} title="创建这份历史归档？"
      description={<>将 {request?.before} 零点之前符合条件的历史记录移入独立归档，随后缩小在线数据库。归档期间业务暂不可用，完成后自动恢复。归档文件长期保留，可在本页查看和下载。</>}
      confirmLabel="确认创建归档" pending={operation.pending} error={operation.error} unknown={operation.unknown}
      refreshing={operation.refreshing} onRefresh={operation.refresh}
      onConfirm={() => { if (request) operation.submit(request); }} />
  </>;
}

function ArchiveList() {
  const archives = useQuery({ queryKey: historyArchivesKey, queryFn: ({ signal }) => listHistoryArchives(signal) });
  const maintenance = useMaintenanceJobs();
  return <DetailPage>
    <PageHeading title="历史归档" description="归档长期保留，可查看、下载，或手动永久删除。" />
    <PageHeaderActions><RefreshButton busy={archives.isFetching || maintenance.isFetching} onClick={() => { void archives.refetch(); void maintenance.refetch(); }} /></PageHeaderActions>
    <DetailNavigation global back={{ to: "/settings/backup", label: "返回备份设置" }} />
    <ErrorNotice error={maintenance.error} retry={() => { void maintenance.refetch(); }} />
    <MaintenanceJobResult job={maintenance.active ?? maintenance.latest} />
    <Card size="sm">
      <CardHeader><CardTitle role="heading" aria-level={2}>归档文件</CardTitle><CardDescription>已删除的归档保留删除记录。</CardDescription></CardHeader>
      <CardContent className="min-w-0">
        <QueryView query={archives}>{items => items.length ? <BusinessTable id="history-archives" items={items} columns={items.some(archive => archive.deletion_pending) ? archiveColumns : archiveColumns.filter(column => column.id !== "actions")} rowId={archive => archive.archive_id} columnsMenu={false} density="compact" embedded aria-label="历史归档列表" /> : <Empty><EmptyHeader><EmptyTitle>暂无历史归档</EmptyTitle><EmptyDescription>选择截止日期并创建归档后，文件会显示在这里。</EmptyDescription></EmptyHeader></Empty>}</QueryView>
      </CardContent>
    </Card>
    <ArchiveCreator blocked={maintenance.blocked} />
  </DetailPage>;
}

function ArchiveActions({ archive }: { archive: HistoryArchiveSummary }) {
  const navigate = useNavigate();
  const success = useSuccessToast();
  const wait = useOperationWait();
  const [confirmation, setConfirmation] = useState<HistoryArchiveSummary | null>(null);
  const [confirmationText, setConfirmationText] = useState("");
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<Error | null>(null);
  const download = useRef<AbortController | null>(null);
  const deleteTrigger = useRef<HTMLButtonElement>(null);
  useEffect(() => () => download.current?.abort(), []);
  const remove = useMutation({
    networkMode: "always", retry: false,
    mutationFn: (confirmed: HistoryArchiveSummary) => wait(signal => deleteHistoryArchive(confirmed, signal)),
    onSuccess: async () => {
      setConfirmation(null);
      queryClient.removeQueries({ queryKey: historyArchiveKey(archive.archive_id) });
      await queryClient.invalidateQueries({ queryKey: historyArchivesKey });
      success("归档已永久删除");
      void navigate("/settings/archives");
    },
  });
  const unknown = isOperationResultUnknown(remove.error);
  const confirmedArchive = confirmation ?? archive;
  async function downloadFile() {
    if (download.current) return;
    const operation = new AbortController();
    download.current = operation;
    setDownloading(true);
    setDownloadError(null);
    try {
      const blob = await downloadHistoryArchive(archive.archive_id, operation.signal);
      if (operation.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `history-${archive.archive_id}.sqlite3`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      success("归档文件已开始下载");
    } catch (error) {
      if (!operation.signal.aborted) setDownloadError(error instanceof Error ? error : new Error("下载失败，请重试。"));
    } finally {
      if (!operation.signal.aborted) { download.current = null; setDownloading(false); }
    }
  }
  async function refreshAfterUnknown() {
    await queryClient.invalidateQueries({ queryKey: historyArchivesKey });
    queryClient.removeQueries({ queryKey: historyArchiveKey(archive.archive_id) });
    setConfirmation(null);
    void navigate("/settings/archives");
  }
  return <>
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="outline" disabled={downloading || remove.isPending} onClick={() => { void downloadFile(); }}>{downloading ? <Spinner data-icon="inline-start" /> : <Download data-icon="inline-start" />}下载归档</Button>
      <Button ref={deleteTrigger} variant="outline" disabled={downloading || remove.isPending} onClick={() => { if (!unknown) remove.reset(); setConfirmationText(""); setConfirmation(archive); }}><Trash2 data-icon="inline-start" />永久删除</Button>
    </div>
    <ErrorNotice error={downloadError} />
    <AlertDialog open={confirmation !== null} onOpenChange={(open, event) => { if (!open && remove.isPending) event.cancel(); else if (!open) setConfirmation(null); }}>
      <AlertDialogContent finalFocus={() => deleteTrigger.current}>
        <AlertDialogHeader>
          <AlertDialogTitle>永久删除这份历史归档？</AlertDialogTitle>
          <AlertDialogDescription>将永久删除 {dateTime(confirmedArchive.created_at)} 创建的归档及其中全部历史记录，包含 {count(confirmedArchive.order_count)} 笔订单、{count(confirmedArchive.ledger_count)} 条流水。删除后无法在系统中查看或恢复这些记录。</AlertDialogDescription>
        </AlertDialogHeader>
        <FieldGroup><Field data-disabled={remove.isPending || unknown}>
          <FieldLabel htmlFor="archive-delete-confirmation">输入“永久删除”确认</FieldLabel>
          <Input id="archive-delete-confirmation" autoComplete="off" value={confirmationText} onChange={event => setConfirmationText(event.target.value)} disabled={remove.isPending || unknown} />
          <FieldDescription>归档编号：{confirmedArchive.archive_id}</FieldDescription>
        </Field></FieldGroup>
        {unknown ? <Alert><AlertTitle>删除结果待确认</AlertTitle><AlertDescription>请求未完整返回，请刷新归档列表查看结果。</AlertDescription></Alert> : <ErrorNotice error={remove.error} />}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={remove.isPending}>取消</AlertDialogCancel>
          {unknown ? <Button variant="outline" onClick={() => { void refreshAfterUnknown(); }}>刷新归档列表</Button> : <AlertDialogAction variant="destructive" disabled={confirmationText !== "永久删除" || remove.isPending} onClick={() => { if (confirmation) remove.mutate(confirmation); }}>{remove.isPending && <Spinner data-icon="inline-start" />}{remove.isPending ? "正在删除…" : "确认永久删除"}</AlertDialogAction>}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>;
}

function ArchivedOrders({ archiveId, items }: { archiveId: string; items: ArchiveOrderSummary[] }) {
  const location = useLocation();
  const columns: BusinessColumn<ArchiveOrderSummary>[] = [
    { id: "order", label: "订单", layout: "identity", hideable: false, cell: order => <div className="flex min-w-0 flex-col gap-1"><Link global to={archivePath(archiveId) + "/orders/" + encodeURIComponent(order.order_id) + location.search} state={location.state} className="text-primary underline-offset-4 hover:underline">{order.merchant_order_no}</Link><span className="text-xs text-muted-foreground">{order.product_name}</span></div> },
    { id: "site", label: "业务网站", layout: "text", hideable: false, summaryDefault: true, cell: order => order.site_name },
    { id: "amount", label: "应付金额", layout: "amount", hideable: false, summaryDefault: true, summaryLabel: true, cell: order => money(order.payable_amount_cents) },
    { id: "status", label: "收款状态", layout: "status", hideable: false, summaryDefault: true, cell: order => <StatusBadge value={order.payment_status} /> },
    { id: "created", label: "创建时间", layout: "datetime", hideable: false, summaryDefault: true, cell: order => dateTime(order.created_at) },
  ];
  return items.length ? <BusinessTable id="archived-orders" items={items} columns={columns} rowId={order => order.order_id} columnsMenu={false} density="compact" embedded aria-label="归档订单列表" /> : <Empty><EmptyHeader><EmptyTitle>没有归档订单</EmptyTitle><EmptyDescription>此归档中没有订单记录。</EmptyDescription></EmptyHeader></Empty>;
}

function ArchiveDetail({ archiveId }: { archiveId: string }) {
  const cursor = useCursor();
  const archive = useQuery({ queryKey: [...historyArchiveKey(archiveId), "orders", cursor.cursor], queryFn: ({ signal }) => getHistoryArchive(archiveId, cursor.cursor ?? null, signal) });
  const recordsFetching = useIsFetching({ queryKey: [...historyArchiveKey(archiveId), "records"] });
  const unavailable = archive.error instanceof ApiError && [404, 410].includes(archive.error.status);
  return <DetailPage>
    <PageHeading title="归档详情" />
    <PageHeaderActions><RefreshButton busy={archive.isFetching || recordsFetching > 0} onClick={() => { void archive.refetch(); void queryClient.invalidateQueries({ queryKey: [...historyArchiveKey(archiveId), "records"] }); }} /></PageHeaderActions>
    <DetailNavigation global back={{ to: "/settings/archives", label: "返回历史归档" }} identifier={archiveId} identifierLabel="归档编号" />
    {unavailable ? <ErrorNotice error={archive.error} /> : <QueryView query={archive}>{data => <>
      <Card size="sm"><CardHeader><CardTitle role="heading" aria-level={2}>归档信息</CardTitle><CardDescription>长期保留，只有手动永久删除才会移除归档文件。</CardDescription></CardHeader><CardContent className="flex min-w-0 flex-col gap-4">
        <DetailFields items={[
          ["创建时间", dateTime(data.archive.created_at)], ["截止时间（不含）", dateTime(data.archive.before)],
          ["订单数量", count(data.archive.order_count)], ["流水数量", count(data.archive.ledger_count)],
          ["文件大小", archiveSize(data.archive.size_bytes)], ["归档格式版本", count(data.archive.schema_version)],
        ]} />
        <ArchiveActions archive={data.archive} />
        <TechnicalDetails title="文件校验信息" data={{ archive_id: data.archive.archive_id, sha256: data.archive.sha256, size_bytes: data.archive.size_bytes }} />
      </CardContent></Card>
      <ArchiveContents archiveId={archiveId} orderPage={data} pending={archive.isFetching} />
    </>}</QueryView>}
  </DetailPage>;
}

function ArchiveContents({ archiveId, orderPage, pending }: { archiveId: string; orderPage: Awaited<ReturnType<typeof getHistoryArchive>>; pending: boolean }) {
  const location = useLocation();
  const [search, setSearch] = useSearchParams();
  const cursor = useCursor();
  const requestedView = search.get("view") ?? (orderPage.archive.order_count === 0 ? "records" : "orders");
  const view = requestedView === "records" ? "records" : "orders";
  return <Tabs value={view} onValueChange={value => {
    setSearch(current => {
      const next = new URLSearchParams(current);
      next.set("view", String(value));
      for (const key of ["cursor", "page", "records_cursor", "records_cursor_page"]) next.delete(key);
      return next;
    }, { replace: true, state: location.state });
  }}>
    <TabsList aria-label="归档内容"><TabsTrigger value="orders">订单</TabsTrigger><TabsTrigger value="records">全部记录</TabsTrigger></TabsList>
    <TabsContent value="orders">
      <Card size="sm"><CardHeader><CardTitle role="heading" aria-level={2}>归档订单</CardTitle><CardDescription>共 {count(orderPage.archive.order_count)} 笔订单。</CardDescription></CardHeader><CardContent className="flex min-w-0 flex-col gap-4">
        <ArchivedOrders archiveId={archiveId} items={orderPage.orders} />
        <CursorPagination page={cursor.page} count={orderPage.orders.length} hasNext={orderPage.next_cursor !== null} pending={pending} previousLabel={cursor.previousLabel} onPrevious={cursor.previous} onNext={() => cursor.next(orderPage.next_cursor)} />
      </CardContent></Card>
    </TabsContent>
    <TabsContent value="records">{view === "records" && <ArchiveRecords archiveId={archiveId} />}</TabsContent>
  </Tabs>;
}

const recordColumns: BusinessColumn<HistoryArchiveRecord>[] = [
  { id: "record", label: "记录", layout: "identity", hideable: false, cell: record => <span title={record.key}>{shortId(record.key)}</span> },
  { id: "table", label: "数据表", layout: "text", hideable: false, summaryDefault: true, summaryLabel: true, cell: record => record.table },
  { id: "detail", label: "内容", layout: "actions", hideable: false, cell: record => <TechnicalDetails title="查看记录" data={record.data} identifiers={[["数据表", record.table], ["记录键", record.key]]} /> },
];

function ArchiveRecords({ archiveId }: { archiveId: string }) {
  const location = useLocation();
  const [search, setSearch] = useSearchParams();
  const table = search.get("table") ?? "";
  const cursor = useCursor("records_cursor");
  const records = useQuery({
    queryKey: [...historyArchiveKey(archiveId), "records", table, cursor.cursor],
    queryFn: ({ signal }) => getHistoryArchiveRecords(archiveId, table, cursor.cursor, signal),
    placeholderData: keepPreviousData,
  });
  const unavailable = records.error instanceof ApiError && [404, 410].includes(records.error.status);
  return <Card size="sm">
    <CardHeader><CardTitle role="heading" aria-level={2}>全部归档记录</CardTitle><CardDescription>查看订单、流水、采集批次和请求检查点等归档内容。</CardDescription></CardHeader>
    <CardContent className="min-w-0">
      {unavailable ? <ErrorNotice error={records.error} /> : <QueryView query={records}>{data => {
        const choices = [{ value: "", label: "全部数据表 · " + count(data.tables.reduce((total, item) => total + item.count, 0)) + " 条" },
          ...data.tables.map(item => ({ value: item.table, label: item.table + " · " + count(item.count) + " 条" }))];
        return <div className="flex min-w-0 flex-col gap-4">
          <FieldGroup><Field className="max-w-sm"><FieldLabel htmlFor="archive-record-table">数据表</FieldLabel>
            <Select items={choices} value={table} onValueChange={value => {
              setSearch(current => {
                const next = new URLSearchParams(current);
                if (value) next.set("table", value); else next.delete("table");
                next.delete("records_cursor"); next.delete("records_cursor_page");
                return next;
              }, { replace: true, state: location.state });
            }}>
              <SelectTrigger id="archive-record-table" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent align="start"><SelectGroup>{choices.map(choice => <SelectItem key={choice.value} value={choice.value}>{choice.label}</SelectItem>)}</SelectGroup></SelectContent>
            </Select>
          </Field></FieldGroup>
          {records.isPlaceholderData ? <Loading label="正在读取归档记录…" /> : data.records.length ? <BusinessTable id="archive-records" items={data.records} columns={recordColumns} rowId={record => record.table + ":" + record.key} columnsMenu={false} density="compact" embedded aria-label="全部归档记录列表" /> : <Empty><EmptyHeader><EmptyTitle>没有归档记录</EmptyTitle><EmptyDescription>当前数据表中没有记录。</EmptyDescription></EmptyHeader></Empty>}
          <CursorPagination page={cursor.page} count={data.records.length} hasNext={data.next_cursor !== null} pending={records.isFetching} previousLabel={cursor.previousLabel} onPrevious={cursor.previous} onNext={() => cursor.next(data.next_cursor)} />
        </div>;
      }}</QueryView>}
    </CardContent>
  </Card>;
}

function ArchivedOrderDetail({ archiveId, orderId }: { archiveId: string; orderId: string }) {
  const location = useLocation();
  const order = useQuery({ queryKey: [...historyArchiveKey(archiveId), "order", orderId], queryFn: ({ signal }) => getArchivedOrder(archiveId, orderId, signal) });
  const unavailable = order.error instanceof ApiError && [404, 410].includes(order.error.status);
  return <DetailPage>
    <PageHeading title="归档订单详情" />
    <PageHeaderActions><RefreshButton busy={order.isFetching} onClick={() => { void order.refetch(); }} /></PageHeaderActions>
    <DetailNavigation global back={{ to: archivePath(archiveId) + location.search, state: location.state, label: "返回归档" }} identifier={orderId} identifierLabel="订单编号" />
    {unavailable ? <ErrorNotice error={order.error} /> : <QueryView query={order}>{data => <>
      <Card size="sm"><CardHeader><CardTitle role="heading" aria-level={2}>订单信息</CardTitle><CardDescription>归档时保存的订单记录。</CardDescription></CardHeader><CardContent>
        <DetailFields items={[
          ["商户订单号", <CopyValue value={data.order.merchant_order_no} label="复制商户订单号" />], ["业务网站", data.order.site_name],
          ["商品名称", data.order.product_name], ["收款状态", <StatusBadge value={data.order.payment_status} />],
          ["请求金额", money(data.order.requested_amount_cents)], ["应付金额", money(data.order.payable_amount_cents)],
          ["实收金额", money(data.order.received_amount_cents)], ["退款状态", <StatusBadge value={data.order.refund_status} />],
          ["创建时间", dateTime(data.order.created_at)], ["最后更新时间", dateTime(data.order.updated_at)],
        ]} />
      </CardContent></Card>
      <Card size="sm"><CardHeader><CardTitle role="heading" aria-level={2}>关联记录</CardTitle><CardDescription>共 {count(data.records.length)} 条归档记录，包含订单及其相关业务记录。</CardDescription></CardHeader><CardContent><TechnicalDetails title="查看完整归档记录" data={data.records} /></CardContent></Card>
    </>}</QueryView>}
  </DetailPage>;
}

export default function HistoryArchives() {
  const { archiveId, orderId } = useParams();
  if (archiveId && orderId) return <ArchivedOrderDetail key={archiveId + ":" + orderId} archiveId={archiveId} orderId={orderId} />;
  if (archiveId) return <ArchiveDetail key={archiveId} archiveId={archiveId} />;
  return <ArchiveList />;
}
