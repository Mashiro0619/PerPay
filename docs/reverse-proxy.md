<!-- SPDX-License-Identifier: MIT -->

# 反向代理部署

公网收款必须使用 HTTPS。推荐在 PerPay 前置 Nginx 处理 TLS 终止并将请求反向代理至容器。

| 部署方式 | 适用场景 | 章节 |
| --- | --- | --- |
| 宿主机代理 | Nginx 直接运行在宿主机，通过 `127.0.0.1:6190` 转发 | [宿主机代理](#宿主机代理) |
| 同网络容器代理 | Nginx 以容器方式运行并与 PerPay 共享自定义 Docker 网络 | [同网络容器代理](#同网络容器代理) |

配置前先在 `docker-compose.yml` 顶部确认以下两个参数：

- `x-perpay-public-url`：外部访问地址，如 `https://pay.example.com`（必须为 HTTPS 且不含路径）。
- `x-perpay-trusted-proxy-cidrs`：可信反向代理来源网段（CIDR），用于正确解析 `X-Forwarded-For` 中的真实客户端 IP（登录限流、审计日志与管理员 IP 白名单均依赖该值）。

---

## 宿主机代理

适用于宿主机 Nginx 通过本机端口转发给 PerPay 容器。

### 1. 查询 Docker 网关 IP

在 `docker-compose.yml` 中配置 `x-perpay-public-url`，保持 `x-perpay-host-port` 为默认的 `127.0.0.1:6190:6190`，创建网络并查询网关地址（暂不启动容器）：

```sh
docker compose config --quiet
docker compose create app
docker network inspect perpay_default --format '{{range .IPAM.Config}}{{println .Gateway}}{{end}}'
```

若使用 `-p` 指定了自定义 Compose 项目名，请将 `perpay_default` 替换为 `<项目名>_default`。

### 2. 配置可信代理网段

将上述网关 IP 写入 `x-perpay-trusted-proxy-cidrs`：IPv4 附加 `/32`（例如 `172.18.0.1/32`），IPv6 附加 `/128`。

> **警告**：容器看到的宿主机代理来源通常是上述 Docker 网桥网关，不应随意填写 `127.0.0.1/32`，且严禁填写 `0.0.0.0/0`（会导致任意客户端伪造 `X-Forwarded-For`）。

### 3. 配置 Nginx

替换域名和证书路径：

```nginx
server {
    listen 443 ssl;
    server_name pay.example.com;

    ssl_certificate /etc/nginx/tls/fullchain.pem;
    ssl_certificate_key /etc/nginx/tls/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:6190;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For $remote_addr;
    }
}
```

> **说明**：若 Nginx 前端还接入了 CDN，须先在 Nginx 中通过 `set_real_ip_from` 与 `real_ip_header` 还原真实客户端 IP，上述 `$remote_addr` 即可正确传递访客地址。

### 4. 启动与验证

```sh
sudo nginx -t && sudo systemctl reload nginx
docker compose up -d
curl -fsS https://pay.example.com/healthz
```

健康检查通过后，访问 `https://你的域名/admin/` 完成 [初始化](../README.md#初始化)。登录后进入 **系统设置 → 密钥与安全 → 管理员 IP 白名单 → 编辑**，核对页面显示的 **当前识别 IP** 是否为客户端真实公网 IP。

---

## 首次访问控制

默认配置开启了一次性初始化口令（`x-perpay-setup-token-enabled: "true"`），防止公网暴露期间被他人抢先初始化：

```sh
docker compose logs --tail=100 app
```

在最新一条 `administrator_setup_required` 日志中获取 `setup_token` 并提交至初始化页面。管理员创建完成后口令立即失效；未创建前重启容器会重新生成口令。

### 安装阶段临时限制来源 IP（可选）

如需在初始化期间通过 Nginx 仅允许管理员 IP 访问，可在 `server` 块中、`location /` 之前临时加入（替换为实际公网 IP）：

```nginx
allow 203.0.113.10;
deny all;
```

重载 Nginx 后其余来源将返回 `403`。管理员初始化并登录确认后，务必移除这两行规则并重载 Nginx，避免拦截公开收银台和业务回调请求。

---

## 同网络容器代理

若 Nginx 同样运行在 Docker 中，可将代理容器与 `app` 置于同一自定义网络并分配固定内网 IP，无需映射宿主机 `6190` 端口：

1. 修改 `docker-compose.yml`：
   - 移除 `app` 服务下的 `ports`。
   - 设置 `x-perpay-public-url` 为 HTTPS 地址，`x-perpay-trusted-proxy-cidrs` 为 `"172.30.61.2/32"`。
   - 合并以下网络与代理配置（若网段冲突可自行调整）：

   ```yaml
   services:
     app:
       networks:
         proxy:
           ipv4_address: 172.30.61.3

     proxy:
       image: nginx:stable-alpine
       ports: ["443:443"]
       volumes:
         - ./nginx.conf:/etc/nginx/conf.d/default.conf:ro
         - ./tls:/etc/nginx/tls:ro
       networks:
         proxy:
           ipv4_address: 172.30.61.2
       restart: unless-stopped

   networks:
     proxy:
       ipam:
         config:
           - subnet: 172.30.61.0/24
   ```

2. 将上文 Nginx 配置保存为 `./nginx.conf`，并将 `proxy_pass` 改为 `http://app:6190`；在 `./tls` 目录放入证书文件。
3. 启动并验证：

   ```sh
   docker compose config --quiet
   docker compose up -d
   docker compose exec proxy nginx -t
   curl -fsS https://pay.example.com/healthz
   ```

4. 登录后台核对 **当前识别 IP** 是否为真实公网 IP。

---

## 信任与排错

| 现象 | 排查方向 |
| --- | --- |
| 访问域名返回 `502` | 执行 `docker compose ps` 检查 `app` 状态；确认 `proxy_pass` 目标正确（宿主机用 `127.0.0.1:6190`，容器代理用 `app:6190`） |
| 「当前识别 IP」仍显示为 Docker 网关 | 核对 Nginx 是否传递 `X-Forwarded-For`，以及 `x-perpay-trusted-proxy-cidrs` 是否与代理来源 IP 一致；修改后执行 `docker compose up -d app` |
| 登录、保存或导出提示“来源不一致” | 确认浏览器地址与 `x-perpay-public-url` 的协议、域名和端口完全一致，并检查 Nginx 是否正确传递 `Host` 与 `X-Forwarded-Proto https` |
| 管理员被 IP 白名单拦截 | 按 [管理员 IP 白名单离线恢复](maintenance.md#管理员-ip-白名单与离线恢复) 在服务器关闭白名单，无需删除数据 |
