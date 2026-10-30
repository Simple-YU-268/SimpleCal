# SimpleCal

**简单、本地优先、可自行部署的日历与通讯录服务。**

SimpleCal 提供中文日历界面、CalDAV/CardDAV 同步、只读分享和 AI 日程接口。账号、日程、联系人与配置都保存在你自己的设备上，运行期不依赖第三方云服务。

当前版本：**0.3.4**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/PaulCAI1593/SimpleCal)](https://github.com/Simple-YU-268/SimpleCal/releases)

## 功能

- 年、月、周、四日、日与日程视图，支持多日历、任务、重复事件、提醒和中国法定节日。
- `.ics` 导入导出，可按日历备份与迁移数据。
- CalDAV 事件与任务同步，支持条件写入、增量同步、忙闲查询和跨日历 MOVE。
- CardDAV 通讯录，支持独立地址簿、vCard 条件写入、查询、multiget 与增量同步。
- 完整日历或忙闲只读分享链接，支持吊销、过期与隐藏处理。
- AI 凭据按日历、时间窗、字段和写权限授权，支持提案确认、限流与审计。
- 本地账号、密码哈希、登录限流、CSRF 防护、两步验证和安全审计。
- 删除账号时一并清理其日历、通讯录及关联数据。

## 通用服务器部署

需要 Node.js 22。构建通用运行包：

```bash
cd code/web && npm ci
cd ../..
node code/scripts/build-server.mjs
```

产物位于 `dist/SimpleCal-server-<版本>/`。构建后直接运行：

```bash
cd dist/SimpleCal-server-0.3.4
CALDAV_DATA_DIR=./data node server/server.mjs
```

首次启动未指定密码时会生成随机管理员密码。数据目录、密码文件、公开地址和反向代理配置见 [`SERVER.md`](./SERVER.md)。

## Docker

仓库提供 `Dockerfile`、`docker-compose.yml` 与 [`DOCKER.md`](./DOCKER.md)：

```bash
docker compose up -d --build
```

默认访问 `http://localhost:5581/`，数据保存在 `simplecal-data` 卷中。

## fnOS 安装

构建 `SimpleCal-<版本>.fpk` 后在应用中心安装，或在 Release 下载对应安装包。安装向导中设置空闲端口和管理员账号，完成后通过浏览器访问。

## 客户端连接

- CalDAV 与 CardDAV 使用同一个服务器地址和账号凭据。
- 服务支持 DAV 前缀及 `CALDAV_PUBLIC_BASE_URL`，可部署在反向代理子路径下。
- AI 接口默认关闭，由管理员在设置中启用并逐项授权。

详细协议能力见 [`docs/DAV_API.md`](./docs/DAV_API.md)，事件接口见 [`docs/EVENTS_API.md`](./docs/EVENTS_API.md)。

## 数据与备份

通用部署的数据由 `CALDAV_DATA_DIR` 指定，主要包括：

- `accounts.json`：账号与安全设置；
- `calendars/`：日历、事件和同步元数据；
- `addressbooks/`：地址簿与联系人；
- `ai/`：AI 凭据与提案；
- `logs/`：访问与审计日志。

备份时保存整个数据目录。恢复后使用相同或兼容版本启动即可。

## 从源码开发

目录说明与完整构建步骤见 [`BUILD.md`](./BUILD.md)。前端构建与测试依赖只用于开发，通用运行包不需要安装 npm 运行期依赖。

## 致谢

SimpleCal 基于开源项目 **[FnCal](https://github.com/PaulCAI1593/FnCal)** 开发。感谢 FnCal 及其作者以 MIT 许可证开放源代码，为本项目提供了日历界面、服务端与数据模型的基础。

SimpleCal 在 FnCal 基础上继续完善通用服务器部署、DAV 同步、通讯录、分享与存储能力，并作为独立项目维护。

## 许可

MIT License，Copyright (c) 2026 **PaulCAI1593**。

原始版权与依法需要保留的第三方声明见 [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)。

## 链接

- 仓库：<https://github.com/Simple-YU-268/SimpleCal>
- 问题反馈：<https://github.com/Simple-YU-268/SimpleCal/issues>
