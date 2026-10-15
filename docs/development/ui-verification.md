<!-- SPDX-License-Identifier: MIT -->

# 界面回归

运行 `npm run build` 后，以 `npm run test:ui -- --project core` 验证核心流程，
以 `npm run test:ui:full` 执行完整页面矩阵。首次使用执行 `npx playwright install chromium`。

回归进程只绑定 127.0.0.1:6196，使用独立临时数据库、合成二维码和模拟健康信息，禁止外部请求。
有效订单、投递、五类对账详情及网站 ID 从本轮夹具生成；普通演示仍使用推进时钟。
私有测试时钟由父进程 IPC 控制，不增加生产控制端点。

截图、trace、构建和源码摘要、浏览器及实际视口量测写入 `.ui-audit/runs/`，不进入版本库。
axe 的未确定项需人工复核，不能计入通过；页面仿真不是 iOS Safari 真机证据。
