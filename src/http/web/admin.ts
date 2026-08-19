import { WEB_ASSET_URLS } from "./assets.ts";

export type AdminPageMode = "setup" | "login" | "application";

export function renderAdminPage(mode: AdminPageMode = "application", nonce = ""): string {
  const title = mode === "setup"
    ? "设置管理员密码 - PerPay"
    : mode === "login"
      ? "管理员登录 - PerPay"
      : "管理后台 - PerPay";
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <meta name="theme-color" content="#f6f7f8">
  <meta name="csp-nonce" content="${escapeHtmlAttribute(nonce)}">
  <title>${title}</title>
  <script src="${WEB_ASSET_URLS.adminScript}" defer></script>
</head>
<body>
  <div id="perpay-admin-root" data-mode="${mode}"></div>
</body>
</html>`;
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
