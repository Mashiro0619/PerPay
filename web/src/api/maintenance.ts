import { result, type BackupFile } from "@/api/client";
import { client } from "@/api/generated/client.gen";

export type MaintenanceKind = "BACKUP" | "RESTORE" | "DELETE_BACKUP" | "ARCHIVE";
export type MaintenanceJob = {
  id: string;
  kind: MaintenanceKind;
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";
  stage: string;
  message: string;
  started_at: number;
  finished_at: number | null;
  error: string | null;
  result: { archive_id?: string; backup_name?: string; safety_backup_name?: string; requires_login?: boolean } | null;
};
export type MaintenanceState = { active: MaintenanceJob | null; latest: MaintenanceJob | null };
export type MaintenanceRequest = { operation_id: string } & (
  { kind: "BACKUP" } |
  { kind: "ARCHIVE"; before: string } |
  { kind: "RESTORE" | "DELETE_BACKUP"; name: string; expected_sha256: string }
);
export type ManagedBackupFile = BackupFile & { sha256: string | null; safety_backup?: boolean };
export const maintenanceKey = ["maintenance"] as const;

export function maintenanceJobRequiresLogin(job: MaintenanceJob | null | undefined): boolean {
  return (job?.status === "SUCCEEDED" || job?.status === "FAILED") && job.result?.requires_login === true;
}

export async function getMaintenanceState(signal: AbortSignal): Promise<MaintenanceState> {
  const response = await result(client.get<{ 200: { data: MaintenanceState } }>({ url: "/api/admin/v1/maintenance/jobs", signal }));
  return response.data;
}

export async function getMaintenanceJob(id: string, signal: AbortSignal): Promise<MaintenanceJob> {
  const response = await result(client.get<{ 200: { data: MaintenanceJob } }>({ url: "/api/admin/v1/maintenance/jobs/{id}", path: { id }, signal }));
  return response.data;
}

export async function startMaintenance(request: MaintenanceRequest, signal: AbortSignal): Promise<MaintenanceJob> {
  const response = await result(client.post<{ 202: { data: MaintenanceJob } }>({
    url: "/api/admin/v1/maintenance/jobs", body: request, headers: { "Content-Type": "application/json" }, signal,
  }));
  return response.data;
}

export async function listManagedBackupFiles(signal: AbortSignal): Promise<{ data: { items: ManagedBackupFile[] } }> {
  return result(client.get<{ 200: { data: { items: ManagedBackupFile[] } } }>({ url: "/api/admin/v1/system/backups", signal }));
}
