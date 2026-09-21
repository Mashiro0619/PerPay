import { ApiError, api, result, type AdminWorkItem } from "@/api/client";
export type RestoreOutcome = "restored" | "already" | "ended" | "missing";
export type RestoreCommand = {
  type: AdminWorkItem["type"];
  resourceId: string;
  operationId: string;
};
export async function restoreReminder(
  command: RestoreCommand,
  signal: AbortSignal,
): Promise<RestoreOutcome> {
  try {
    const response = await result(
      api.restoreAdministratorWorkItem({
        path: { type: command.type, resourceId: command.resourceId },
        body: { operation_id: command.operationId },
        signal,
      }),
    );
    const data = response?.data;
    if (
      !data ||
      data.operation_id !== command.operationId ||
      data.type !== command.type ||
      data.resource_id !== command.resourceId ||
      typeof data.restored !== "boolean"
    )
      throw new Error(
        "恢复响应不完整，暂时无法确认结果。请重试同一请求或刷新列表核查。",
      );
    return data.restored ? "restored" : "already";
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.status === 409 &&
      error.code === "work_item_ended"
    )
      return "ended";
    if (
      error instanceof ApiError &&
      error.status === 404 &&
      error.code === "work_item_not_found"
    )
      return "missing";
    throw error;
  }
}
export const restoreMessages: Record<RestoreOutcome, string> = {
  restored: "本次提醒恢复已完成。",
  already: "这条提醒已恢复，无需重复操作。",
  ended: "事项已结束，无需恢复提醒。",
  missing: "提醒对应的记录已不存在。",
};
