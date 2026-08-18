import { WEB_ASSET_URLS } from "./assets.ts";

export type AdminPageMode = "setup" | "login" | "application";

export function renderAdminPage(mode: AdminPageMode = "application"): string {
  const title = mode === "setup"
    ? "设置管理员密码 - PerPay"
    : mode === "login"
      ? "管理员登录 - PerPay"
      : "管理后台 - PerPay";
  const body = mode === "setup" ? setupBody() : mode === "login" ? loginBody() : applicationBody();
  return `<!doctype html>
<html class="uzu-root" lang="zh-CN" data-theme="light" data-uzu-theme-key="perpay-admin-theme">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <meta name="theme-color" content="#f4f3f0">
  <title>${title}</title>
  <link rel="stylesheet" href="${WEB_ASSET_URLS.usuzumiStylesheet}">
  <link rel="stylesheet" href="${WEB_ASSET_URLS.adminStylesheet}">
  <script src="${WEB_ASSET_URLS.usuzumiScript}" defer></script>
  <script src="${WEB_ASSET_URLS.adminScript}" defer></script>
</head>
<body class="uzu-app" data-perpay-admin-page="${mode}">
${body}
</body>
</html>`;
}

function setupBody(): string {
  return `
  <main class="uzu-center perpay-auth-shell">
    <section class="uzu-card perpay-auth-panel" aria-labelledby="setup-title">
      <a class="uzu-brand-link perpay-wordmark" href="/admin/setup" aria-label="PerPay 管理后台">PerPay</a>
      <div class="uzu-title-pair">
        <h1 id="setup-title">设置管理员密码</h1>
        <p>这是首次启动。设置完成后会转到登录页，请使用刚设置的密码登录。</p>
      </div>
      <div class="uzu-alert uzu-alert-danger" id="setup-error" role="alert" hidden></div>
      <form class="uzu-form" id="setup-form" action="/api/admin/v1/setup" method="post" data-uzu-form novalidate>
        <label class="uzu-field" data-uzu-field>
          <span class="uzu-label">管理员密码</span>
          <span class="uzu-password" data-uzu-password>
            <input class="uzu-input uzu-password-input" id="setup-password" name="password" type="password" autocomplete="new-password" minlength="12" required autofocus>
            <button class="uzu-icon-button uzu-password-toggle" type="button" data-uzu-password-toggle aria-label="显示密码"></button>
          </span>
          <span class="uzu-help">至少 12 个字符。</span>
          <span class="uzu-form-error" data-uzu-form-error hidden>请输入至少 12 个字符的密码。</span>
        </label>
        <label class="uzu-field" data-uzu-field>
          <span class="uzu-label">确认密码</span>
          <span class="uzu-password" data-uzu-password>
            <input class="uzu-input uzu-password-input" id="setup-password-confirmation" type="password" autocomplete="new-password" minlength="12" required>
            <button class="uzu-icon-button uzu-password-toggle" type="button" data-uzu-password-toggle aria-label="显示密码"></button>
          </span>
          <span class="uzu-form-error" data-uzu-form-error hidden>请再次输入相同的密码。</span>
        </label>
        <button class="uzu-button uzu-button-primary perpay-full-button" id="setup-submit" type="submit">完成设置</button>
      </form>
    </section>
  </main>`;
}

function loginBody(): string {
  return `
  <main class="uzu-center perpay-auth-shell">
    <section class="uzu-card perpay-auth-panel" aria-labelledby="login-title">
      <a class="uzu-brand-link perpay-wordmark" href="/admin/login" aria-label="PerPay 管理后台">PerPay</a>
      <div class="uzu-title-pair">
        <h1 id="login-title">管理员登录</h1>
        <p>进入收款运行与异常处理后台。</p>
      </div>
      <div class="uzu-alert uzu-alert-danger" id="login-error" role="alert" hidden></div>
      <form class="uzu-form" id="login-form" action="/api/admin/v1/session/login" method="post" data-uzu-form novalidate>
        <label class="uzu-field" data-uzu-field>
          <span class="uzu-label">密码</span>
          <span class="uzu-password" data-uzu-password>
            <input class="uzu-input uzu-password-input" id="login-password" name="password" type="password" autocomplete="current-password" required autofocus>
            <button class="uzu-icon-button uzu-password-toggle" type="button" data-uzu-password-toggle aria-label="显示密码"></button>
          </span>
          <span class="uzu-form-error" data-uzu-form-error hidden>请输入密码。</span>
        </label>
        <button class="uzu-button uzu-button-primary perpay-full-button" id="login-submit" type="submit">登录</button>
      </form>
      <p class="perpay-auth-meta">仅限系统管理员</p>
    </section>
  </main>`;
}

function applicationBody(): string {
  return `
  <header class="uzu-topbar perpay-topbar" data-uzu-topbar-overflow>
    <div class="uzu-topbar-leading">
      <a class="uzu-brand-link perpay-wordmark" href="/admin">PerPay</a>
      <span class="perpay-environment">自托管</span>
    </div>
    <div class="uzu-topbar-actions">
      <span class="perpay-top-status" id="global-status"><span class="perpay-status-dot"></span><span>正在连接</span></span>
      <button class="uzu-icon-button uzu-theme-toggle" type="button" data-uzu-theme-toggle aria-label="切换主题"></button>
      <button class="uzu-button uzu-button-ghost" id="logout-button" type="button">退出</button>
    </div>
  </header>
  <div class="uzu-sidebar-layout perpay-admin-layout" data-uzu-sidebar-layout data-uzu-sidebar-default="auto" data-uzu-sidebar-mobile="dropdown" data-uzu-sidebar-collapse-on-select="narrow">
    <div class="uzu-sidebar-layout-controls perpay-sidebar-controls">
      <button class="uzu-button uzu-sidebar-layout-toggle" type="button" data-uzu-sidebar-toggle aria-controls="admin-sidebar">导航</button>
    </div>
    <aside class="uzu-sidebar perpay-sidebar" id="admin-sidebar">
      <nav class="uzu-sidebar-nav" aria-label="管理后台">
        <a href="/admin" data-admin-nav="overview">系统状态</a>
        <a href="/admin/orders" data-admin-nav="orders">订单</a>
        <a href="/admin/exceptions" data-admin-nav="exceptions"><span>异常处理</span><span class="uzu-badge uzu-badge-warning" id="nav-exception-count" hidden></span></a>
        <a href="/admin/settlements" data-admin-nav="settlements">结算历史</a>
        <a href="/admin/ledger-conflicts" data-admin-nav="ledger-conflicts"><span>账务冲突</span><span class="uzu-badge uzu-badge-danger" id="nav-conflict-count" hidden></span></a>
        <a href="/admin/notifications" data-admin-nav="notifications">通知投递</a>
        <a href="/admin/settings" data-admin-nav="settings">设置</a>
        <a href="/admin/security" data-admin-nav="security">安全</a>
      </nav>
      <div class="perpay-session-summary">
        <span class="uzu-muted">当前会话</span>
        <strong id="session-username">-</strong>
        <time id="session-expiry">-</time>
      </div>
    </aside>
    <main class="perpay-admin-main" id="admin-main" tabindex="-1">
      <div class="perpay-route-loading" id="route-loading" role="status">
        <span class="uzu-spinner" aria-hidden="true"></span>
        <span>正在读取最新状态</span>
      </div>
    </main>
  </div>
  <div class="uzu-dialog-overlay" id="step-up-overlay" data-uzu-dialog-overlay hidden>
    <section class="uzu-modal" id="step-up-dialog" data-uzu-dialog role="dialog" aria-modal="true" aria-labelledby="step-up-title">
      <header class="uzu-dialog-header">
        <div class="uzu-title-pair">
          <h2 id="step-up-title">确认管理员身份</h2>
          <p>此操作会改变资金或安全状态。</p>
        </div>
        <button class="uzu-icon-button" type="button" data-uzu-dialog-close aria-label="取消"></button>
      </header>
      <div class="uzu-alert uzu-alert-danger" id="step-up-error" role="alert" hidden></div>
      <form class="uzu-form" id="step-up-form" data-uzu-form novalidate>
        <label class="uzu-field" data-uzu-field>
          <span class="uzu-label">当前密码</span>
          <span class="uzu-password" data-uzu-password>
            <input class="uzu-input uzu-password-input" id="step-up-password" type="password" autocomplete="current-password" required>
            <button class="uzu-icon-button uzu-password-toggle" type="button" data-uzu-password-toggle aria-label="显示密码"></button>
          </span>
        </label>
        <div class="uzu-dialog-actions">
          <button class="uzu-button" type="button" data-uzu-dialog-close>取消</button>
          <button class="uzu-button uzu-button-primary" id="step-up-submit" type="submit">验证</button>
        </div>
      </form>
    </section>
  </div>
  <div class="uzu-dialog-overlay" id="action-overlay" data-uzu-dialog-overlay hidden>
    <section class="uzu-modal perpay-action-dialog" id="action-dialog" data-uzu-dialog role="dialog" aria-modal="true" aria-labelledby="action-title">
      <header class="uzu-dialog-header">
        <div class="uzu-title-pair">
          <h2 id="action-title">执行操作</h2>
          <p id="action-description"></p>
        </div>
        <button class="uzu-icon-button" type="button" data-uzu-dialog-close aria-label="关闭"></button>
      </header>
      <div id="action-content"></div>
    </section>
  </div>
  <div class="uzu-toast-stack" id="toast-stack" data-uzu-toast-stack aria-live="polite"></div>`;
}
