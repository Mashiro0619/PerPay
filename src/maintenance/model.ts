import { z } from "zod";

const archiveDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).refine(value => {
  const timestamp = Date.parse(value + "T00:00:00+08:00");
  return Number.isFinite(timestamp) && new Date(timestamp + 8 * 60 * 60 * 1_000).toISOString().slice(0, 10) === value && timestamp <= Date.now();
}, "请选择有效且不晚于今天的日期");
const operation = { operation_id: z.uuid() };
const backup = { name: z.string().min(1).max(255), expected_sha256: z.string().regex(/^[0-9a-f]{64}$/u) };

export const maintenanceRequestSchema = z.discriminatedUnion("kind", [
  z.object({ ...operation, kind: z.literal("BACKUP") }).strict(),
  z.object({ ...operation, kind: z.literal("ARCHIVE"), before: archiveDate }).strict(),
  z.object({ ...operation, ...backup, kind: z.literal("RESTORE") }).strict(),
  z.object({ ...operation, ...backup, kind: z.literal("DELETE_BACKUP") }).strict(),
]);

export type MaintenanceRequest = z.infer<typeof maintenanceRequestSchema>;
export type MaintenanceKind = MaintenanceRequest["kind"];
export interface MaintenanceResult {
  archive_id?: string;
  backup_name?: string;
  safety_backup_name?: string;
  requires_login?: boolean;
}
export interface MaintenanceJob {
  id: string;
  kind: MaintenanceKind;
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";
  stage: string;
  message: string;
  started_at: number;
  finished_at: number | null;
  error: string | null;
  result: MaintenanceResult | null;
}
export interface MaintenanceState {
  active: MaintenanceJob | null;
  latest: MaintenanceJob | null;
}
export class MaintenanceError extends Error {
  readonly status: 404 | 409 | 503;
  readonly code: "maintenance_job_not_found" | "maintenance_operation_conflict" | "maintenance_in_progress" | "maintenance_unavailable";
  constructor(status: MaintenanceError["status"], code: MaintenanceError["code"],
    message: string) {
    super(message);
    this.name = "MaintenanceError";
    this.status = status;
    this.code = code;
  }
}
