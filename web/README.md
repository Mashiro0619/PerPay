# 前端开发

仅供修改源码。部署请看[项目说明](../README.md)，无需单独部署前端。

## 目录

以下路径相对仓库根目录：

| 路径 | 内容 |
| --- | --- |
| `web/src/pages/` | 后台页面 |
| `web/src/components/` | 共用组件与配置表单 |
| `web/src/api/` | API 客户端；`generated/` 由接口文档生成，不要手改 |
| `web/src/styles/` | 样式 |
| `web/public/` | 静态资源 |
| `web/test/` | 前端测试 |

公开收银台不在 `web/`：模板位于 `src/http/web/checkout.ts`，样式和脚本位于 `static/app/checkout.*`。

## 本地开发

需要 Node.js 24.15+（24.x）。以下命令均在仓库根目录执行。

先启动独立开发后端，再运行：

```sh
npm ci --ignore-scripts
npm run dev:admin
```

打开 [http://127.0.0.1:6191/admin/](http://127.0.0.1:6191/admin/)。Vite 默认代理到 `http://localhost:6190`；换后端时设置 `PERPAY_DEV_API_URL`，与该后端的 `PERPAY_PUBLIC_URL` 一致。不要连接生产收款实例。

## 构建与测试

| 命令 | 用途 |
| --- | --- |
| `npm run build` | 构建前后端，产物为 `dist/` 和 `web-dist/admin/` |
| `npm run build:admin` | 只构建管理前端 |
| `npm run api:types` | 修改 `openapi.yaml` 后重新生成 API 类型与客户端 |
| `npm run test:admin` | 运行前端测试 |
| `npm run check` | 完整检查：版本、API 类型、类型检查、全部测试和服务端构建 |
