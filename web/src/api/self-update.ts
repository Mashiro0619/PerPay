import { api, result, type SelfUpdateApplyRequest, type SelfUpdateStatus, type UpdateExecutionJob } from "@/api/client";

export type { SelfUpdateApplyRequest, SelfUpdateStatus, UpdateExecutionJob };

export const selfUpdateStatusKey = ["self-update-status"] as const;
export const UPDATER_ENABLE_COMMAND = "docker compose -f docker-compose.yml -f docker-compose.updater.yml up -d";
export const SELF_UPDATE_DOCS_URL = "https://github.com/Mashiro0619/PerPay/blob/main/docs/maintenance.md#在线一键更新";
const ACTIVE_UPDATE_STORAGE_KEY = "perpay:self-update-active";

export interface ActiveSelfUpdateHint {
  readonly id: string;
  readonly target_version: string;
  readonly previous_version: string;
  readonly create_backup: boolean;
}

export function buildOneLineUpgradeCommand(version: string): string {
  return `sed -i 's|^x-perpay-image:.*|x-perpay-image: \\&perpay-image ghcr.io/mashiro0619/perpay:${version}|' docker-compose.yml && docker compose pull && docker compose up -d`;
}

export async function getSelfUpdateStatus(signal?: AbortSignal): Promise<SelfUpdateStatus> {
  const response = await result(api.getSelfUpdateStatus(signal ? { signal } : undefined));
  return response.data;
}

export async function applySelfUpdate(
  body: SelfUpdateApplyRequest,
  signal?: AbortSignal,
): Promise<UpdateExecutionJob> {
  const response = await result(api.applySelfUpdate({
    body,
    ...(signal ? { signal } : {}),
  }));
  return response.data;
}

export function readActiveSelfUpdateHint(): ActiveSelfUpdateHint | null {
  try {
    const raw = window.sessionStorage.getItem(ACTIVE_UPDATE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ActiveSelfUpdateHint>;
    if (
      typeof parsed.id === "string" &&
      typeof parsed.target_version === "string" &&
      typeof parsed.previous_version === "string"
    ) {
      return {
        id: parsed.id,
        target_version: parsed.target_version,
        previous_version: parsed.previous_version,
        create_backup: parsed.create_backup !== false,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function writeActiveSelfUpdateHint(hint: ActiveSelfUpdateHint): void {
  try {
    window.sessionStorage.setItem(ACTIVE_UPDATE_STORAGE_KEY, JSON.stringify(hint));
  } catch {
    // Ignore storage quota / privacy restrictions.
  }
}

export function clearActiveSelfUpdateHint(): void {
  try {
    window.sessionStorage.removeItem(ACTIVE_UPDATE_STORAGE_KEY);
  } catch {
    // Ignore storage restrictions.
  }
}
