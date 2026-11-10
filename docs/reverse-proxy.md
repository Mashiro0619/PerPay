# 反向代理部署

以下示例使用 Nginx。先配置自己的域名及有效 TLS 证书；首次启动时限制访问，创建管理员后再开放。PerPay 的公开地址必须与浏览器使用的 HTTPS origin 一致。

首次初始化以已安装版本的页面为准：如果页面要求一次性令牌，在部署目录执行 `docker compose logs --tail=100 app`，复制最新 `administrator_setup_required` 事件的 `setup_token`，通过自己的 HTTPS 管理页面提交。创建管理员后令牌失效；未初始化时重启服务须重新读取令牌。未包含此功能的旧版只要求设置密码，不会输出令牌事件。详细步骤见 [初始化](../README.md#初始化)。

## 宿主机代理

保留 Compose 的 `127.0.0.1:6190:6190` 端口映射；宿主机 Nginx 转发到回环地址：

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

## 首次访问控制

在上方 `server` 内、`location /` 之前临时加入以下两行，将示例地址换成你当前使用的公网 IP；它限制整个站点，包括首次管理员创建接口：

```nginx
allow 203.0.113.10;
deny all;
```

宿主机运行 `sudo nginx -t && sudo systemctl reload nginx`；Docker 代理运行 `docker compose exec proxy nginx -t && docker compose exec proxy nginx -s reload`。用允许的地址打开 `/admin/`，应出现初始化页；其他来源应收到 403。创建管理员并成功登录后，删除这两行并用同一命令重新加载，随后开放收银台及业务 API。

无法固定来源 IP 时，可在首次启动前将 Compose 的 `x-perpay-setup-token-enabled` 改为 `"true"`，使用启动日志中的一次性初始化令牌。先准备令牌，再通过自己的 HTTPS 域名创建管理员。

将 Compose 顶部 `x-perpay-public-url` 设为 `https://pay.example.com`。首次部署先创建应用容器和网络，此时应用尚未启动：

```sh
docker compose config --quiet
docker compose create app
docker network inspect perpay_default --format '{{range .IPAM.Config}}{{println .Gateway}}{{end}}'
```

输出是本项目的桥接网关。宿主机 Nginx 经回环端口访问容器时，直连来源通常是该网关；将实际输出填入 `x-perpay-trusted-proxy-cidrs`，IPv4 加 `/32`，IPv6 加 `/128`，多个地址用逗号分隔。然后启动服务：

```sh
nginx -t
docker compose config --quiet
docker compose up -d
curl -fsS https://pay.example.com/healthz
```

首次登录后，在 **系统设置 → 密钥与安全 → 管理员 IP 白名单** 点击“编辑”，查看“当前识别 IP”，应显示自己的客户端地址。如果仍显示 Docker 网关，核对 Nginx 的 `X-Forwarded-For` 和实际直连代理地址，修正后执行 `docker compose up -d app`。确认识别正确后再启用白名单。

## 同网络容器代理

适合反向代理也是容器的情况。为代理创建专用网络并固定代理地址，避免信任其他业务容器。以下地址仅为示例，须选择与宿主机和现有 Docker 网络不冲突的子网。

编辑部署目录的 `docker-compose.yml`：

- 删除 `app.ports`，不向宿主机或公网发布应用端口。
- 把 `x-perpay-trusted-proxy-cidrs` 设为 `172.30.61.2/32`；公开地址设为自己的 HTTPS origin。
- 给 `app` 添加 `networks: [proxy]`，加入以下服务和顶层网络配置。保留原有备份、维护及卷设置。

```yaml
services:
  # 在原有 app 配置中增加，而非创建第二个 app：
  app:
    networks: [proxy]
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

使用上面的 Nginx 配置作为 `nginx.conf`，仅将 `proxy_pass` 改成 `http://app:6190`。应用与代理必须在同一网络；备份和维护服务继续保持无网络。运行 `docker compose config --quiet`、`docker compose up -d`，再执行 `docker compose exec proxy nginx -t` 并检查 HTTPS 健康接口。

## 信任与排错

- 不要设置 `0.0.0.0/0`、`::/0`，也不要为了消除错误而信任所有私网。
- 示例假定代理直接接收用户请求，因此覆盖而非盲目追加客户端传来的 X-Forwarded-For。若前面还有 CDN，应先在代理处严格配置其可信来源与真实 IP 解析，不能直接相信请求头。
- 登录、设置保存或 CSV 导出提示来源不一致时，核对公开地址、Host、HTTPS 和代理配置；不要关闭 Origin／CSRF 校验。
- 用域名登录并检查浏览器中的订单、收银台、设置保存；健康接口成功不代表通知联调或实际收款已验证。
