# SimpleCal 通用服务器部署

SimpleCal 的 Web、CalDAV、CardDAV 与 AI 接口使用同一个 Node.js 后端，不依赖 fnOS。
普通用户客户端可使用[事件 API](docs/EVENTS_API.md)，DAV 能力见[接口说明](docs/DAV_API.md)。
运行需要 Node.js 22.12+ 或更新的受支持版本，无须数据库与 npm 运行依赖。

## 构建通用运行目录

在仓库根目录执行：

```sh
cd code/web
npm ci
cd ../..
node code/scripts/build-server.mjs
```

产物为 `dist/SimpleCal-server-<版本>/`，包含 `server/`、`www/`、`deploy/` 和部署说明。
不包含测试、source map 或运行数据。若同名产物已存在，先移走旧目录，或用
`--name SimpleCal-server-preview` 指定新目录名。复制整个产物到服务器即可运行。

## 直接运行

Linux / macOS，在产物目录内执行：

```sh
export CALDAV_DATA_DIR="$HOME/.local/share/simplecal"
export CALDAV_HOST=0.0.0.0
export CALDAV_PORT=5280
node server/server.mjs
```

Windows PowerShell：

```powershell
$env:CALDAV_DATA_DIR = "$env:LOCALAPPDATA/SimpleCal"
$env:CALDAV_HOST = '0.0.0.0'
$env:CALDAV_PORT = '5280'
node server/server.mjs
```

打开 `http://<服务器地址>:5280/`，默认用户名 `caldav`。
首次启动未指定密码时，随机密码写入数据目录的 `admin-initial-password.txt`，首次登录须修改密码。
该文件含初始明文凭据，改密后请删除。服务端不会将密码写入日志。
也可在首启前设置 `CALDAV_ADMIN_PASSWORD`，或用 `CALDAV_ADMIN_PASSWORD_FILE` 指定 UTF-8 密码文件，
二者不能同时设置。这两项仅用于创建首个管理员，不能重置已有账号。

| 配置 | 默认 / 行为 |
|---|---|
| `CALDAV_DATA_DIR` | 通用数据根目录；优先于 fnOS 的 `TRIM_PKGVAR` |
| `TRIM_PKGVAR` | 兼容已有 fnOS 数据目录；均未设时回落到 `server/var` |
| `CALDAV_HOST` | 后端默认 `0.0.0.0`；systemd 示例默认 `127.0.0.1` |
| `CALDAV_PORT` | 环境变量优先，其次数据目录 `config.json` 的端口，最后 `5280` |
| `CALDAV_USER` | 首启管理员用户名，默认 `caldav` |
| `CALDAV_WEB_DIR` | 可覆盖静态资源目录；运行包会自动找到相邻的 `www/` |
| `CALDAV_PUBLIC_BASE_URL` | 可选公开 HTTP(S) origin 与反代子路径；统一外部 href、Location 与分享 URL |

通用部署请显式设置 `CALDAV_DATA_DIR`。仅使用旧变量或未配置数据目录时，保留旧版开发密码兼容行为。

## Linux systemd

以下命令需要管理员权限。将运行包放在 `/opt/simplecal`，创建专用用户并安装示例配置：

```sh
sudo useradd --system --user-group --home-dir /var/lib/simplecal --shell /usr/sbin/nologin simplecal
sudo install -d -m 0755 /etc/simplecal
sudo install -m 0600 /opt/simplecal/deploy/simplecal.env.example /etc/simplecal/simplecal.env
sudo install -m 0644 /opt/simplecal/deploy/simplecal.service /etc/systemd/system/simplecal.service
sudo systemctl daemon-reload
sudo systemctl enable --now simplecal
sudo journalctl -u simplecal -f
```

示例使用 `/usr/bin/node`；若 Node 安装在别处，先调整 `ExecStart`。
systemd 自动创建并授权 `/var/lib/simplecal`。初始密码可用
`sudo cat /var/lib/simplecal/admin-initial-password.txt` 读取；示例用户名为 `admin`。
按需编辑 `/etc/simplecal/simplecal.env`，修改后重启服务。
该示例面向 Linux systemd，尚需目标发行版实测。

## 反向代理、迁移与备份

公网访问使用 HTTPS 反向代理，将根路径完整转发到 `127.0.0.1:5280`，
保留 Host、Authorization、Cookie、DAV 请求方法及请求体，不要只代理 Web 页面。
CalDAV 与 CardDAV 使用服务器根地址，AI 接口使用 `/mcp`，API 与 Web 同源。
使用子路径反代或对外地址与内部 Host 不同时，显式设置
`CALDAV_PUBLIC_BASE_URL=https://公网域名/可选前缀`，使 DAV、分享链接和前端连接信息保持一致。
反代信任与 Cookie 安全选项见 `server/README.md`。

迁移已有数据时，先停止服务，复制整个应用数据目录到新位置，然后设置 `CALDAV_DATA_DIR` 指向它。
保留账号、日历、地址簿、AI 授权、`secret.key`、安全密钥、配置和日志，不要只复制 `.ics`。
不要让两个进程同时写同一目录。旧 `config.json` 端口可通过 `CALDAV_PORT` 覆盖。
升级只替换运行包，数据目录放在包外；备份前停止服务，完整复制数据目录后再启动。
