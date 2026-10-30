<div align="center">

<img src="code/web/public/icon-192.png" alt="SimpleCal 图标" width="96" height="96" />

# SimpleCal

### 把日程留在自己的服务器上

中文日历 · CalDAV / CardDAV · AI 日程助手 · 本地优先

[![License: MIT](https://img.shields.io/badge/License-MIT-2f5e9e.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-22.12%2B-43853d.svg)](SERVER.md)
[![Self Hosted](https://img.shields.io/badge/Self--hosted-5965db.svg)](#快速开始)
[![Version](https://img.shields.io/badge/Version-0.3.4-2f5e9e.svg)](CHANGELOG.md)

[快速开始](#快速开始) · [客户端连接](#客户端连接) · [AI 接入](#ai-接入) · [部署文档](SERVER.md) · [反馈问题](https://github.com/Simple-YU-268/SimpleCal/issues)

</div>

---

SimpleCal 是一个可自行部署的日历与通讯录服务。你可以在浏览器中整理日程，通过 CalDAV 同步日历，通过 CardDAV 同步联系人，也可以让支持 MCP 的 AI 助手在授权范围内查看和安排日程。

账号、日历、联系人与配置保存在自己的设备上。服务运行不依赖第三方云服务，无须部署数据库；前端和后端由同一个 Node.js 进程提供，适合个人服务器、家庭 NAS 和小型自托管环境。

## 功能一览

| 能力 | 可以做什么 |
| :--- | :--- |
| 📅 **中文日历** | 年、月、周、四日、日、日程六种视图；多日历、任务、重复事件、农历与中国法定节日 |
| 🔄 **日历同步** | CalDAV 事件与任务同步，支持增量同步、条件写入、忙闲查询和跨日历移动 |
| 👥 **通讯录同步** | CardDAV 独立地址簿，支持 vCard 3.0 / 4.0、联系人查询与增量同步 |
| 🔗 **只读分享** | 通过 API 生成完整日历或仅忙闲信息的链接，可设置过期时间、随时吊销 |
| ✨ **AI 接入** | MCP 与 REST 接口；按日历、时间范围和字段授权，写入可先提案、再由你确认 |
| 📦 **导入与迁移** | `.ics` 导入导出；文件存储便于备份，通用运行包可复制到另一台服务器 |
| 🔐 **账号安全** | 本地账号、密码哈希、登录限流、CSRF 防护、两步验证、专用密码与审计日志 |

> **当前能力边界**：Web 界面以日历和任务管理为主。通讯录同步通过 CardDAV 使用，分享链接通过 API 管理。事件提醒数据可随 `.ics` 保留，但 Web 不提供通知提醒。

## 快速开始

### 方式一：Node.js 通用运行包

适合 Linux、macOS 和 Windows。需要 **Node.js 22.12+** 及 npm；以下命令从源码构建，安装前端构建依赖时需要联网。

```bash
git clone https://github.com/Simple-YU-268/SimpleCal.git
cd SimpleCal

# 安装前端构建依赖
cd code/web
npm ci
cd ../..

# 构建包含前端和后端的完整运行包
node code/scripts/build-server.mjs
```

构建完成后，进入 `dist/SimpleCal-server-0.3.4/`，选择对应系统的启动方式。

**Linux / macOS**

```bash
cd dist/SimpleCal-server-0.3.4
CALDAV_DATA_DIR="$HOME/.local/share/simplecal" CALDAV_PORT=5280 node server/server.mjs
```

**Windows PowerShell**

```powershell
cd dist/SimpleCal-server-0.3.4
$env:CALDAV_DATA_DIR = "$env:LOCALAPPDATA/SimpleCal"
$env:CALDAV_PORT = '5280'
node server/server.mjs
```

浏览器打开 **`http://localhost:5280/`**；从其他设备访问时，将 `localhost` 换成服务器地址。

**首次登录**

1. 默认管理员用户名为 **`caldav`**。
2. 首次启动会生成随机密码，写入上述数据目录中的 **`admin-initial-password.txt`**。
3. 使用该密码登录，按提示修改密码，然后删除初始密码文件。

运行包不需要再执行 `npm install`。可以将整个运行包复制到服务器，数据目录放在运行包之外，升级时保留数据、替换程序即可。

> 同名构建目录已存在时，构建会停止以避免覆盖数据。再次构建可使用 `node code/scripts/build-server.mjs --name SimpleCal-server-preview`，也可先移走旧产物。

### 方式二：Docker Compose

仓库提供 Dockerfile 与 Compose 配置。**容器构建、卷权限和生命周期仍待 Docker 主机实测**，完整说明见 [Docker 部署文档](DOCKER.md)。

在源码仓库根目录执行：

```bash
docker compose up -d --build

# 查看首次生成的管理员密码
docker compose exec simplecal cat /data/admin-initial-password.txt
```

打开 **`http://localhost:5581/`**，用户名为 **`caldav`**。首次登录改密后，删除容器中的初始密码文件：

```bash
docker compose exec simplecal rm /data/admin-initial-password.txt
```

数据保存在 `simplecal-data` 命名卷中。升级和重建时保留该卷；`docker compose down -v` 会删除数据卷。

### 方式三：fnOS 安装包

仓库保留 fnOS 安装向导、桌面入口和 `.fpk` 构建支持。自行构建后，在应用中心安装 `SimpleCal-<版本>.fpk`，按向导设置端口与管理员账号。

构建命令见 [从源码构建](BUILD.md#fnos-安装包)。

## 客户端连接

Web、CalDAV、CardDAV 与 AI 接口共用一个服务端口。

| 入口 | 直连地址示例 | 用途 |
| :--- | :--- | :--- |
| Web | `http://服务器地址:5280/` | 浏览器中的日历与任务管理 |
| CalDAV | `http://服务器地址:5280/` | 在支持 CalDAV 的客户端添加日历账号 |
| CardDAV | `http://服务器地址:5280/` | 在支持 CardDAV 的客户端添加通讯录账号 |
| MCP | `https://你的域名/mcp` | AI 助手通过独立令牌访问 |

使用 Compose 时，将直连端口改为 **`5581`**。使用 HTTPS 反向代理时，填写你的公开域名。

在客户端选择 CalDAV 或 CardDAV 账号，填写服务器地址和账号凭据。开启两步验证后，可在安全设置中为同步客户端创建专用密码；不同客户端的发现与同步行为仍需实际验证。

**反向代理与子路径**：公网部署使用 HTTPS，并完整转发 Web、API 和 DAV 请求。外部地址与内部监听地址不同时，配置公开地址，例如：

```ini
CALDAV_PUBLIC_BASE_URL=https://cal.example.com/simplecal
```

详细配置、systemd 服务和代理说明见 [服务器部署文档](SERVER.md)，协议范围见 [DAV 接口说明](docs/DAV_API.md)。

## AI 接入

AI 接口默认关闭。在 Web 的 **设置 → AI** 中启用服务并点击「应用」，然后创建独立凭据：

1. 为所需日历选择「只读」或「读写」，其余日历保持「不可见」。
2. 设置可访问的过去 / 未来时间范围，以及地点、描述、参与者等字段的可见性。
3. 选择「提案」写入模式，让 AI 的变更先进入队列，由你接受后再生效。
4. 保存创建时显示的令牌，填入支持 HTTP MCP 的客户端。

以下为配置示例，具体字段以所用客户端要求为准：

```json
{
  "mcpServers": {
    "simplecal": {
      "type": "http",
      "url": "https://cal.example.com/mcp",
      "headers": {
        "Authorization": "Bearer <你的令牌>"
      }
    }
  }
}
```

如果部署在子路径下，请将 URL 改为对应路径，例如 `https://cal.example.com/simplecal/mcp`。

令牌明文只在创建时显示一次，服务端保存哈希；丢失后请创建新凭据。你可以随时吊销授权。启用 AI 接入后，所连接的 AI 客户端会收到授权范围内的数据，请按需开放日历和字段。

## 数据、备份与升级

**程序可以替换，数据目录需要完整保留。** 通用部署通过 `CALDAV_DATA_DIR` 指定数据根目录，Docker 中对应 `/data`。

| 内容 | 作用 |
| :--- | :--- |
| 账号、配置与密钥 | 登录、安全设置、会话及加密所需信息 |
| `calendars/` | 各账号的日历、事件、任务、同步元数据及关联业务数据 |
| `addressbooks/` | 地址簿与联系人 |
| 日志与 AI 配置 | 访问审计、服务开关等实例数据 |

- **备份**：先停止服务，完整复制数据目录，再启动服务。
- **恢复 / 迁移**：复制完整目录，将 `CALDAV_DATA_DIR` 指向新位置，使用相同或兼容版本启动。
- **升级**：先备份数据，再替换运行包；数据目录与程序目录保持分离。
- **日历交换**：使用 `.ics` 导入导出；它不包含账号、安全密钥、通讯录和全部服务配置，不能替代完整备份。

当前文件存储按**单写入进程**部署，请勿让多个实例同时写同一数据目录。

## 文档导航

| 文档 | 内容 |
| :--- | :--- |
| [服务器部署](SERVER.md) | 首次启动、环境变量、systemd、反向代理与迁移 |
| [Docker 部署](DOCKER.md) | Compose、密码文件、持久卷与容器验证范围 |
| [从源码构建](BUILD.md) | 开发目录、通用运行包、fnOS 打包与测试 |
| [DAV 接口](docs/DAV_API.md) | CalDAV、CardDAV、条件写入、MOVE 与分享接口 |
| [事件 API](docs/EVENTS_API.md) | 普通用户事件 CRUD、认证与版本冲突处理 |
| [架构与演进](docs/EVOLUTION.md) | 存储、接口边界及当前验证范围 |
| [更新日志](CHANGELOG.md) | 版本变更记录 |

## 参与改进

欢迎通过 [Issues](https://github.com/Simple-YU-268/SimpleCal/issues) 反馈问题或提交 Pull Request。报告同步、部署或登录问题时，请附上版本、操作系统、部署方式、客户端名称与复现步骤；日志请先移除密码、令牌和私人日程信息。

## 来源与许可

SimpleCal 基于开源项目 **[FnCal](https://github.com/PaulCAI1593/FnCal)** 开发。感谢 FnCal 及其作者开放源代码，为本项目提供日历界面、服务端与数据模型的基础。SimpleCal 在此基础上继续完善通用服务器部署、DAV 同步、通讯录、分享与存储能力，并作为独立项目维护。

本项目采用 [MIT License](LICENSE)，保留原始版权声明。完整许可与必要的第三方声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

<div align="center">

**SimpleCal · 简单管理日程，自主保存数据。**

[GitHub](https://github.com/Simple-YU-268/SimpleCal) · [问题反馈](https://github.com/Simple-YU-268/SimpleCal/issues)

</div>
