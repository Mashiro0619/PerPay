# 反向代理部署

[文档导航](README.md) · [部署说明](../README.md#部署)

公网访问 PerPay 时，用 Nginx 等反向代理接收 HTTPS 请求，再转发给 PerPay。先准备域名、HTTPS 证书和部署目录中的 `docker-compose.yml`，按 Nginx 安装的位置选择下面一种方式：

| 代理位置 | 配置方式 |
| --- | --- |
| Nginx 直接安装在服务器上 | [宿主机代理](#宿主机代理)：Nginx 通过服务器本机端口访问 PerPay。 |
| Nginx 也运行在 Docker 容器里 | [同网络容器代理](#同网络容器代理)：两个容器通过专用网络连接。 |

两种方式都要在首次启动前做好[首次访问控制](#首次访问控制)，防止别人抢先创建管理员。`x-perpay-public-url` 填浏览器实际访问的地址，例如 `https://pay.example.com`，包含 `https://`，不带路径。`x-perpay-trusted-proxy-cidrs` 告诉 PerPay 哪个代理可以转发用户 IP，填写方法见各自步骤。

以下命令在 `docker-compose.yml` 所在目录执行，默认项目名是 `perpay`。如果你用 `-p` 指定过其他名字，后续命令继续带上同一 `-p 项目名`，并替换示例中的网络名。

## 宿主机代理

1. 保留 Compose 中的 `127.0.0.1:6190:6190`，让 PerPay 端口只供服务器本机访问，并填写自己的 `x-perpay-public-url`。下面先创建容器和网络，暂不启动应用：

   ```sh
   docker compose config --quiet
   docker compose create app
   docker network inspect perpay_default --format '{{range .IPAM.Config}}{{println .Gateway}}{{end}}'
   ```

2. 将 Nginx 连接 PerPay 时使用的地址填入 `x-perpay-trusted-proxy-cidrs`。经过 Docker 转发后，这个地址通常是上一步输出的网关，不能直接照填 `127.0.0.1`。IPv4 地址后加 `/32`，IPv6 地址后加 `/128`，表示只信任这个地址；多个地址用逗号分隔。

3. 配置 Nginx，将域名、证书路径换成实际值，并按[首次访问控制](#首次访问控制)加入临时规则或启用初始化令牌：

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

4. 检查配置并启动：

   ```sh
   sudo nginx -t
   sudo systemctl reload nginx
   docker compose config --quiet
   docker compose up -d
   curl -fsS https://pay.example.com/healthz
   ```

5. 通过自己的 HTTPS 域名完成[初始化](../README.md#初始化)。登录后，在 **系统设置 → 密钥与安全 → 管理员 IP 白名单 → 编辑** 查看“当前识别 IP”，确认显示自己的客户端地址，再考虑启用白名单。若显示 Docker 网关，按[信任与排错](#信任与排错)修正。

## 首次访问控制

第一次创建管理员前，按下面一种方式保护设置页面。初始化令牌默认关闭，需要时手动开启。

**固定来源 IP：临时限制整个站点。** 在 Nginx 的 `server` 内、`location /` 之前加入以下规则，将示例地址换成自己的公网 IP：

```nginx
allow 203.0.113.10;
deny all;
```

重新加载 Nginx 后，从允许的地址打开 `/admin/`，应能看到管理员设置页面；其他地址会收到 403。创建管理员并成功登录后，删除这两行并重新加载，让付款人和业务网站可以访问。

**无法固定来源 IP：启用一次性初始化令牌。** 首次启动前，将 Compose 的 `x-perpay-setup-token-enabled` 改为 `"true"`。启动后读取最新令牌：

```sh
docker compose logs --tail=100 app
```

找到最新一条 `administrator_setup_required` 日志，把其中的 `setup_token` 填入自己的 HTTPS 管理页面。创建管理员后，这个令牌立即失效；如果创建前重启了服务，需要使用新令牌。

代理已经运行后修改配置，宿主机执行 `sudo nginx -t && sudo systemctl reload nginx`；容器代理执行 `docker compose exec proxy nginx -t && docker compose exec proxy nginx -s reload`。首次安装先写好配置，再按对应路线启动，容器尚未启动时不执行 `exec`。

## 同网络容器代理

把 Nginx 和 PerPay 放进一个单独的 Docker 网络，并给它们固定地址。这样 PerPay 可以只信任 Nginx。下面的网段是示例，不要与服务器或其他 Docker 网络已有的网段重复。

1. 编辑部署目录的 `docker-compose.yml`：
   - 删除 `app.ports`，让 Nginx 通过 Docker 网络访问 PerPay，不把应用端口开放到服务器或公网。
   - 将 `x-perpay-public-url` 设为自己的 HTTPS 地址，`x-perpay-trusted-proxy-cidrs` 设为 `172.30.61.2/32`。
   - 按下方配置把 `app` 固定为 `172.30.61.3`、代理固定为 `172.30.61.2`，避免动态分配占用代理地址。保留原有备份、维护和卷设置。

   ```yaml
   services:
     # 合并到原有 app 配置中：
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

2. 将[宿主机示例](#宿主机代理)的 Nginx 配置保存为 `nginx.conf`，把 `proxy_pass` 改为 `http://app:6190`，并放好 `tls` 目录中的证书。启动前完成[首次访问控制](#首次访问控制)。应用和代理加入同一网络，备份与维护服务继续使用 `network_mode: none`。

3. 启动并检查 HTTPS：

   ```sh
   docker compose config --quiet
   docker compose up -d
   docker compose exec proxy nginx -t
   curl -fsS https://pay.example.com/healthz
   ```

4. 完成初始化后，核对后台“当前识别 IP”，再移除临时访问规则并重新加载 Nginx。

## 信任与排错

| 现象 | 核对与处理 |
| --- | --- |
| HTTPS 返回 502 | 检查应用是否运行，以及 `proxy_pass` 是否匹配代理位置：宿主用 `127.0.0.1:6190`，同网络容器用 `app:6190`。 |
| “当前识别 IP”仍是 Docker 网关或代理 | 检查 Nginx 是否发送了 `X-Forwarded-For`，以及 `x-perpay-trusted-proxy-cidrs` 是否包含 Nginx 连接 PerPay 时使用的地址。修改后执行 `docker compose up -d app`。 |
| 登录、保存设置或导出 CSV 提示来源不一致 | 浏览器地址应与 `x-perpay-public-url` 的协议、域名和端口一致。检查 Nginx 的 `Host` 和 HTTPS 转发设置，不要关闭来源或 CSRF 安全检查。 |
| 用户 IP 不正确或转发信息被拒绝 | 检查 Nginx 前面是否还有 CDN 或其他代理，再逐层确认用户 IP 是怎样传过来的。 |

不要填写 `0.0.0.0/0`、`::/0` 或整个私有网段来消除报错，这会让无关来源也能声明用户 IP。上面的 Nginx 直接接收用户请求，因此用 `$remote_addr` 覆盖用户自行传入的 `X-Forwarded-For`。如果前面还有 CDN，先在 Nginx 配好该 CDN 的可信地址和真实 IP 读取规则，再转发给 PerPay。

配置完成后，用自己的域名登录、保存一次配置并打开收银台，再走通一笔收款和通知。启用管理员白名单后如果无法进入后台，按[离线恢复步骤](maintenance.md#管理员-ip-白名单与离线恢复)关闭白名单并修正规则。
