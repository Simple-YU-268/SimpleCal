<div align="center">

<img src="code/web/public/icon-192.png" alt="SimpleCal" width="88" height="88" />

# SimpleCal

**日程安排得明白，数据留在自己手里。**

一个可以自己部署的中文日历，支持任务、CalDAV / CardDAV 同步和 AI 助手接入。

[![MIT](https://img.shields.io/badge/License-MIT-3B54C4.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-22.12%2B-43853d.svg)](SERVER.md)

[快速开始](#快速开始) · [使用方法](#使用方法) · [部署文档](DOCKER.md) · [更新日志](CHANGELOG.md)

</div>

## 能做什么

- 📅 **安排日程**：年、月、周、四日、日和日程视图，多日历、重复事件、农历与中国法定节日。
- ✅ **管理任务**：日程和待办放在一起，不必来回切应用。
- 🔄 **同步设备**：通过 CalDAV 同步日历与任务，通过 CardDAV 同步联系人。
- 🤖 **接入 AI**：支持 MCP 和 REST，按日历授权；可以让 AI 先提交安排建议，由你确认后再写入。
- 📦 **自己保存数据**：无须数据库，支持 ICS 导入导出，整个数据目录都能备份和迁移。
- 🔐 **安全访问**：本地账号、两步验证、客户端专用密码与访问审计。
- ✨ **适配手机**：深浅色主题、触屏控件；发现新版后提示更新，不强制刷新正在使用的页面。

> Web 界面主要管理日历和任务，联系人通过 CardDAV 客户端使用。目前不提供 Web 通知提醒。

## 界面展示

<!-- 待补充：桌面月视图、手机日历与设置页实机截图。 -->
截图整理中。界面以月历为主，使用深靛蓝强调色，支持手机和桌面浏览器。

## 快速开始

### Docker Compose

需要安装 Docker 和 Compose。在终端执行：

```bash
git clone https://github.com/Simple-YU-268/SimpleCal.git
cd SimpleCal
docker compose up -d --build

# 查看首次登录密码
docker compose exec simplecal cat /data/admin-initial-password.txt
```

打开 **http://localhost:5581/**，默认用户名是 **`caldav`**。从其他设备访问时，把
`localhost` 换成服务器 IP。首次登录必须修改密码，成功后初始密码文件会自动删除。

数据保存在 Docker 命名卷中，重建容器不会清空数据。

> **不要执行 `docker compose down -v`，它会删除数据卷。** 公网使用请配置 HTTPS 反代，
> 具体步骤见 [Docker 部署](DOCKER.md)。

### 不使用 Docker

需要 **Node.js 22.12+**。通用运行包及源码构建方式见 [服务器部署](SERVER.md) 和
[构建指南](BUILD.md)。从 0.4.1 起不再发布 fnOS 专用安装包，NAS 也建议使用 Docker 部署。

## 使用方法

### 浏览器与同步客户端

登录后即可创建日历、添加日程和任务；主题、周起始日等选项在设置中调整。

| 使用方式 | 填写内容 |
|---|---|
| 浏览器 | 打开你的服务器地址 |
| CalDAV 日历客户端 | 服务器地址 + SimpleCal 用户名和密码 |
| CardDAV 通讯录客户端 | 服务器地址 + SimpleCal 用户名和密码 |
| 开启两步验证的同步客户端 | 使用安全设置中创建的专用密码 |

例如，部署在 `https://cal.example.com`，客户端服务器地址也填写这个地址。
具体连接结果取决于客户端的协议支持，遇到问题可附客户端版本提交反馈。

### AI 助手

在 **设置 → AI** 中启用服务、应用设置，再创建独立凭据。只开放需要的日历，
建议先选“提案”写入模式，让 AI 的修改由你确认。

支持 HTTP MCP 的客户端可参考以下配置，字段以客户端要求为准：

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

令牌只在创建时显示一次。AI 客户端会获得授权范围内的数据，请按需开放权限。

## 常用配置

使用 Compose 时，修改 `docker-compose.yml` 的 `environment`，再执行
`docker compose up -d`。

| 环境变量 | 用途 |
|---|---|
| `CALDAV_USER` | 首次创建的管理员用户名，默认 `caldav` |
| `CALDAV_ADMIN_PASSWORD` | 可选的初始化密码；留空则随机生成，不会重置已有账号 |
| `CALDAV_PUBLIC_BASE_URL` | 对外访问地址，例如 `https://cal.example.com` |
| `CALDAV_DATA_DIR` | 数据目录，Docker 镜像中已设为 `/data` |

更多参数、密码文件和反代示例见 [部署文档](DOCKER.md)。当前按单实例写入设计，
不要让多个服务同时写同一个数据目录。

## 备份与升级

备份前停止服务，**完整备份数据目录或 Docker 数据卷**，然后再启动。升级时保留数据卷，
更新源码并重新构建即可：

```bash
git pull --ff-only
docker compose up -d --build
```

已加载更新检测功能的页面会提示有新版，由你确认后刷新。ICS 导出只用于交换日历，
不能代替完整备份。

## 文档与贡献

[Docker 部署](DOCKER.md) · [服务器部署](SERVER.md) · [源码构建与测试](BUILD.md) ·
[DAV 接口](docs/DAV_API.md) · [事件 API](docs/EVENTS_API.md)

欢迎提 [Issue](https://github.com/Simple-YU-268/SimpleCal/issues) 或 Pull Request。
反馈时请带上版本、部署方式、客户端名称和复现步骤；日志中的密码、令牌与私人日程请先删掉。

## 致谢与许可

SimpleCal 基于 [FnCal](https://github.com/PaulCAI1593/FnCal) 继续开发，感谢原作者开放源码。
界面设计使用 [Impeccable](https://github.com/pbakaus/impeccable) 工作流，设计约定见 [DESIGN.md](DESIGN.md)。

采用 [MIT License](LICENSE)，保留原始版权声明。第三方许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
