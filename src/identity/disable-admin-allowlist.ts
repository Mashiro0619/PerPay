import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { disableAdministratorAllowlist } from "./allowlist-recovery.ts";
export async function runAllowlistRecovery(args: string[]): Promise<void> {
  if (args.length === 1 && args[0] === "--help") {
    console.log(
      "先停止 app 和 backup，运行 node dist/identity/disable-admin-allowlist.js --confirm-disable-admin-allowlist。数据目录由 PERPAY_DATA_DIR 指定；保留规则、密码和支付数据。",
    );
    return;
  }
  if (args.length !== 1 || args[0] !== "--confirm-disable-admin-allowlist")
    throw new Error(
      "请先停服，并传入 --confirm-disable-admin-allowlist 确认。",
    );
  await disableAdministratorAllowlist({
    dataDirectory: process.env.PERPAY_DATA_DIR ?? "./data",
    confirmed: true,
  });
  console.log("管理员 IP 白名单已关闭，原规则保留。可以重新启动服务并登录。");
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  runAllowlistRecovery(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : "恢复失败");
    process.exitCode = 1;
  });
}
