import { emitKeypressEvents, type Key } from "node:readline";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import { PasswordInputError } from "./crypto.ts";
import { AdminRecoveryError, recoverAdministratorPassword } from "./recovery.ts";

const confirmation = "--confirm-reset-admin-password";

export async function runRecovery(arguments_: string[]): Promise<void> {
  if (arguments_.length === 1 && arguments_[0] === "--help") {
    console.log("离线重设管理员密码：先停止 app 和 backup，再运行 node dist/identity/recover.js " + confirmation + "。\n默认隐藏输入并确认两次；自动化可加 --password-stdin，从标准输入读取一行密码。数据目录由 PERPAY_DATA_DIR 指定。");
    return;
  }
  if (!arguments_.includes(confirmation) || new Set(arguments_).size !== arguments_.length ||
      arguments_.some((argument) => ![confirmation, "--password-stdin"].includes(argument))) {
    throw new AdminRecoveryError("请先停服，再加 " + confirmation + " 确认。密码不能放在命令参数里。");
  }
  let password = "";
  let repeated = "";
  try {
    if (arguments_.includes("--password-stdin")) password = await passwordFromStdin();
    else {
      if (!process.stdin.isTTY || !process.stderr.isTTY) throw new AdminRecoveryError("请在交互终端运行；自动化需显式指定 --password-stdin。");
      process.stderr.write("只重设管理员密码并注销旧会话，订单和密钥保留。\n");
      password = await hiddenPassword("新密码（至少 6 个字符，输入不显示）：");
      repeated = await hiddenPassword("再次输入新密码：");
      if (password !== repeated) throw new AdminRecoveryError("两次密码不一致，未作修改。");
    }
    const result = await recoverAdministratorPassword({ dataDirectory: process.env.PERPAY_DATA_DIR ?? "./data", password, confirmed: true });
    console.log("管理员密码已重设，已注销 " + result.revokedSessions + " 个旧会话。可以重新启动服务并登录。");
  } finally { password = ""; repeated = ""; }
}

async function passwordFromStdin(): Promise<string> {
  if (process.stdin.isTTY) throw new AdminRecoveryError("--password-stdin 只接受管道输入；交互输入请去掉此参数。");
  const chunks: Buffer[] = [];
  let total = 0;
  let buffer: Buffer | undefined;
  try {
    for await (const chunk of process.stdin) {
      const bytes = Buffer.from(chunk);
      chunks.push(bytes); total += bytes.length;
      if (total > 1026) throw new AdminRecoveryError("密码不能超过 1024 个 UTF-8 字节。");
    }
    buffer = Buffer.concat(chunks);
    let password: string;
    try { password = new TextDecoder("utf-8", { fatal: true }).decode(buffer).replace(/\r?\n$/, ""); }
    catch { throw new AdminRecoveryError("密码必须是有效 UTF-8 文本。"); }
    if (/[\r\n]/.test(password)) throw new AdminRecoveryError("标准输入只能包含一行密码。");
    return password;
  } finally { for (const chunk of chunks) chunk.fill(0); buffer?.fill(0); }
}

function hiddenPassword(prompt: string): Promise<string> {
  return new Promise((resolvePassword, reject) => {
    const input = process.stdin;
    const wasRaw = input.isRaw;
    let value = "";
    function cleanup() {
      input.off("keypress", onKey); input.off("end", onEnd); input.off("error", onEnd);
      input.setRawMode(wasRaw); input.pause(); process.stderr.write("\n");
    }
    function onEnd() { cleanup(); value = ""; reject(new AdminRecoveryError("输入已取消，未作修改。")); }
    function onKey(text: string, key: Key) {
      if (key.ctrl && ["c", "d"].includes(key.name ?? "")) { onEnd(); return; }
      if (key.name === "return" || key.name === "enter") { const password = value; value = ""; cleanup(); resolvePassword(password); return; }
      if (key.name === "backspace") { value = Array.from(value).slice(0, -1).join(""); return; }
      if (!key.ctrl && !key.meta && text && !/[\u0000-\u001f\u007f]/.test(text)) value += text;
      if (Buffer.byteLength(value, "utf8") > 1024) { cleanup(); value = ""; reject(new AdminRecoveryError("密码不能超过 1024 个 UTF-8 字节。")); }
    }
    process.stderr.write(prompt);
    emitKeypressEvents(input); input.setRawMode(true); input.resume();
    input.on("keypress", onKey); input.once("end", onEnd); input.once("error", onEnd);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await runRecovery(process.argv.slice(2)); }
  catch (error) {
    console.error(error instanceof AdminRecoveryError ? error.message : error instanceof PasswordInputError ? "密码需至少 6 个字符，最多 1024 个 UTF-8 字节。" : "恢复失败：请检查数据路径、权限、数据库版本及维护锁；不会自动重试。");
    process.exitCode = 1;
  }
}
