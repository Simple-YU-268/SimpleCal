# SimpleCal Docker 部署（容器实测待完成）

Docker 使用与通用运行包相同的 Node 后端。已验证后端通用启动、登录和 DAV 重启持久化；
镜像构建、卷权限和容器生命周期尚需在 Docker 主机实测。

## Compose

在源码仓库根目录执行：

```sh
docker compose up -d --build
docker compose logs -f
```

打开 `http://<服务器地址>:5581/`，默认用户名 `caldav`。默认首启生成随机密码，读取方式：

```sh
docker compose exec simplecal cat /data/admin-initial-password.txt
```

首次登录后必须修改密码，再删除初始密码文件。也可在 `.env` 中设置
`CALDAV_ADMIN_PASSWORD` 后启动；该文件不要提交到版本库。修改初始化密码配置不会重置已有账号。

## docker run 与密码文件

```sh
docker build -t simplecal:dev .
docker run -d --name simplecal --restart unless-stopped \
  -p 5581:5280 -v simplecal-data:/data simplecal:dev
```

用密码文件初始化时，只配置 `CALDAV_ADMIN_PASSWORD_FILE`，不要同时配置
`CALDAV_ADMIN_PASSWORD`（即使其值为空）。例如：

```sh
docker run -d --name simplecal --restart unless-stopped \
  -p 5581:5280 -v simplecal-data:/data \
  --mount type=bind,src=/absolute/path/admin-password,dst=/run/secrets/admin-password,readonly \
  -e CALDAV_ADMIN_PASSWORD_FILE=/run/secrets/admin-password simplecal:dev
```

确保文件可被容器内 uid 1000 读取。使用 Compose secrets 时，移除默认 Compose 文件的
`CALDAV_ADMIN_PASSWORD` 项，再将 secret 授予服务并设置对应的文件路径。

## 配置与数据

| 变量 | 默认值 / 作用 |
|---|---|
| `CALDAV_DATA_DIR` | 镜像中为 `/data` |
| `CALDAV_USER` | `caldav`，首启管理员用户名 |
| `CALDAV_ADMIN_PASSWORD` | 省略或为空时生成随机密码 |
| `CALDAV_ADMIN_PASSWORD_FILE` | UTF-8 密码文件；末尾一个换行会被去除 |
| `CALDAV_HOST` | `0.0.0.0` |
| `CALDAV_PORT` | `5280`，运行时覆盖，需要同步修改端口映射 |
| `CALDAV_WEB_DIR` | `/app/www` |
| `CALDAV_PUBLIC_BASE_URL` | 可选公开地址与反向代理子路径 |

后端无须数据库。容器以非 root 的 `node` 用户（uid 1000）运行。默认使用 named volume；
改用 bind mount 时，先在宿主机创建目录并授权 uid 1000 写入。

备份前停止容器，完整备份 `/data` 卷，包括账号、日历、地址簿、AI 授权、会话密钥和安全配置。
升级保留卷，重新构建并创建容器。不要使用 `docker compose down -v`，该命令会删除数据卷。
迁移已有数据的方法见 [SERVER.md](SERVER.md)。

公网使用 HTTPS 反向代理，将整个根路径转发到服务，保留 DAV 方法和 Authorization。
本部署方式不提供 fnOS 桌面图标与安装向导。账号初始化只发生一次。

## Docker 主机验收

1. `docker compose build` 成功，启动后健康检查通过。
2. 登录页与静态资源可加载，随机密码能登录且要求改密。
3. 创建事件与联系人，重建容器后数据均保留。
4. CalDAV 与 CardDAV 客户端可读写，AI 授权和访问正常。
5. `docker compose exec simplecal id` 为 uid 1000，数据卷可写。
6. SIGTERM 停止后 PID 文件清理，重新启动正常。

镜像基于 `node:22-alpine`。ARM 与 x86 主机分别构建本机架构镜像；
跨架构分发需额外使用 buildx 并在目标平台实测。
