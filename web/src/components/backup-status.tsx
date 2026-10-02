import { useQuery } from "@tanstack/react-query";
import { api, result } from "@/api/client";
import { dateTime } from "@/lib/format";
import { FieldDescription } from "@/components/ui/field";
import { useOptionalSystemStatus } from "@/features/system-status";
export function BackupStatus() {
  const shared = useOptionalSystemStatus();
  const fallback = useQuery({
    queryKey: ["status", "backup-settings"],
    queryFn: ({ signal }) =>
      result(api.getAdministratorSystemStatus({ signal })),
    enabled: !shared,
    retry: false,
  });
  const status = shared?.status ?? fallback;
  const backup = status.data?.data.backup;
  return (
    <div className="flex flex-col gap-2" aria-label="备份任务状态">
      <FieldDescription>
        {status.isError || !backup
          ? "备份任务状态暂不可用；保存只修改策略。"
          : !backup.enabled
            ? "备份任务未启用；保存策略不会启动备份进程。"
            : backup.configuration_mismatch
              ? "备份配置与任务不一致，请检查服务器备份任务。"
              : backup.last_error_stage
                ? "最近备份失败（" +
                  backup.last_error_stage +
                  "），请查看备份日志。"
                : !backup.backup_available
                  ? "尚无可用备份，请先完成一次备份验证。"
                  : backup.backup_in_progress
                    ? "正在备份"
                    : "备份任务已启用"}
      </FieldDescription>
      {backup && (
        <FieldDescription>
          最近成功 {dateTime(backup.last_success_at)} · 可用备份{" "}
          {backup.retained_count ?? 0} 份
        </FieldDescription>
      )}
      <FieldDescription>
        <a
          href="https://github.com/Mashiro0619/PerPay/blob/main/docs/maintenance.md#启用与验证备份"
          target="_blank"
          rel="noopener noreferrer"
        >
          启用与验证备份
        </a>{" "}
        · 主密钥须另行保管。
      </FieldDescription>
    </div>
  );
}
