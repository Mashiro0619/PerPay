import { api, ApiError, getSessionRequestGeneration, result, type HistoryArchiveSummary } from "./client";

export type { ArchiveOrderSummary, HistoryArchiveRecord, HistoryArchiveSummary } from "./client";

export const historyArchivesKey = ["history-archives"] as const;
export const historyArchiveKey = (id: string) => ["history-archive", id] as const;

export async function listHistoryArchives(signal: AbortSignal) {
  const response = await result(api.listHistoryArchives({ signal }));
  return response.data;
}

export async function getHistoryArchive(id: string, cursor: string | null, signal: AbortSignal) {
  const response = await result(api.getHistoryArchive({ path: { archiveId: id }, query: { limit: 30, ...(cursor ? { cursor } : {}) }, signal }));
  return response.data;
}

export async function getArchivedOrder(archiveId: string, orderId: string, signal: AbortSignal) {
  const response = await result(api.getArchivedOrder({ path: { archiveId, orderId }, signal }));
  return response.data;
}

export async function getHistoryArchiveRecords(archiveId: string, table: string, cursor: string | undefined, signal: AbortSignal) {
  const response = await result(api.getHistoryArchiveRecords({
    path: { archiveId }, query: { limit: 20, ...(table ? { table } : {}), ...(cursor ? { cursor } : {}) }, signal,
  }));
  return response.data;
}

export async function deleteHistoryArchive(archive: HistoryArchiveSummary, signal: AbortSignal) {
  const response = await result(api.deleteHistoryArchive({
    path: { archiveId: archive.archive_id },
    body: { expected_sha256: archive.sha256 },
    signal,
  }));
  return response.data;
}

export async function downloadHistoryArchive(id: string, signal: AbortSignal): Promise<Blob> {
  const generation = getSessionRequestGeneration();
  const response = await api.downloadHistoryArchive({ path: { archiveId: id }, parseAs: "blob", signal });
  signal.throwIfAborted();
  if (generation !== getSessionRequestGeneration()) throw new DOMException("管理员会话已变化，已忽略旧请求结果。", "AbortError");
  if (response.error instanceof Error && response.error.name === "AbortError") throw response.error;
  if (!response.response?.ok) throw new ApiError(response.response, response.error);
  if (response.error !== undefined || !(response.data instanceof Blob) ||
      !/^(application\/vnd\.sqlite3|application\/octet-stream)(;|$)/i.test(response.response.headers.get("content-type") ?? "")) {
    throw new Error("未收到完整的归档文件，请重新下载。");
  }
  return response.data;
}
