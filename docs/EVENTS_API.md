# 普通用户事件 API（未发布）

此接口用于通用服务器版本的普通用户客户端，与 `/api/ai/v1/events` 的 AI 授权通道分开。
Web 原有 KV API 继续兼容，DAV 与新 API 操作同一批 ICS 对象，无数据迁移。

## 路由与身份

| Method | 路径 | 成功 |
|---|---|---|
| GET | `/api/v1/calendars/:calendarId/events` | 200，`{ok:true,items:[{event,etag}]}` |
| POST | `/api/v1/calendars/:calendarId/events` | 201，`{ok:true,event,etag}`，响应头 Location / ETag |
| GET | `/api/v1/calendars/:calendarId/events/:id` | 200，`{ok:true,event,etag}`，响应头 ETag |
| PATCH | `/api/v1/calendars/:calendarId/events/:id` | 200，同 GET |
| DELETE | `/api/v1/calendars/:calendarId/events/:id` | 200，`{ok:true}` |

读接受 Basic 或浏览器会话；写必须浏览器会话、CSRF Cookie 和 `X-CSRF-Token`。
只接受普通账号认证，不把 AI Bearer 当作用户身份。使用当前账号的内部用户 ID 隔离数据。
强制改密与待完成 MFA 状态沿用现有业务 API 闸门。
API 面向 VEVENT 日历；任务日历返回 409。

POST/PATCH 要求 `Content-Type: application/json`，请求体上限 1 MB。
列表返回存储的系列主事件，按对象 ID 排序；本轮不提供时间过滤、分页或重复实例展开。
列表带查询参数会返回 400，避免把未执行的筛选误报成已生效。

## 事件字段

创建的必填字段为 `title`、`start`、`end`；start/end 使用有效的数字毫秒时间戳。
定时事件要求 end > start。全天事件沿用原有 Web 模型：end 表示最后一天的时间，
可以与 start 相同；序列化 ICS 时 DTEND 转为独占结束日期。
`startDate`/`endDate` 是已有模型的日期字面量补充，其中 endDate 为 ICS 独占结束日期，
普通客户端可省略这两个高级字段，使用时间戳与 allDay。

可编辑字段：

```text
title start end allDay location description
timezone endTimezone startDate endDate
recurrence exdates overrides reminders alarms
categories status transp color
```

PATCH 仅传变化字段，未传字段保留；`recurrence:null` 清除重复规则。
`reminders` 使用分钟数组，传 `[]` 清除；显式修改 reminders 且未给 alarms 时重建提醒，
否则原始 alarms 优先。时区和 iCalendar 映射沿用已有转换层。
id、uid、calendarId、createdBy 不可由请求设置，未知字段返回 400。
POST 由服务器生成对象 ID，uid 是 ICS 标识，可能带域名，不应拿 uid 代替资源 ID 拼路径。
PATCH 保留原 uid；创建者由服务端账号上下文生成。

这是 JSON 模型编辑接口，覆盖已有转换层支持的字段，并不承诺任意第三方 X 属性字节无损回写。
需要原始 ICS 完整读写时使用 DAV。复杂规则校验与重复实例 API 属于后续演进范围。

## 并发修改

PATCH 与 DELETE 必须提供上次 GET 返回的强 ETag，包含双引号：

```http
PATCH /api/v1/calendars/default/events/<id>
Content-Type: application/json
Cookie: caldav_session=<session>; caldav_csrf=<csrf>
X-CSRF-Token: <csrf>
If-Match: "<etag>"

{"title":"修改后的标题"}
```

缺少 If-Match 返回 428，版本过期返回 412；通配符、弱标签与列表标签不作为有效匹配。
客户端应重新 GET、呈现最新内容，再决定如何重新提交。
版本比较、合并与实际写入共享 store 的每日历队列；两个新 API 请求使用相同旧版本同时修改时，
最多一个成功。DAV 与 KV 写入同样经过这条存储队列，因此新 API 能在提交时发现其已完成的写入。
这不是多进程锁；旧 KV 保留原有条件检查方式，DAV 条件写已在后续 [融合改进](DAV_API.md) 中接入队列内检查。

## 错误与联调

错误格式为 `{ok:false,code,message?}`。

| HTTP | 情形 |
|---|---|
| 400 | 字段、标识、JSON、时间或查询参数无效 |
| 401 | 未认证，或写请求仅提供 Basic |
| 403 | CSRF、改密或 MFA 等账号策略拒绝 |
| 404 | 当前账号下日历/事件不存在 |
| 405 | 方法不支持，同时提供 Allow |
| 409 | 日历为任务类型 |
| 412 | If-Match 过期或不匹配 |
| 413 | 请求体或序列化对象超过大小上限 |
| 415 | 写入内容类型不是 JSON |
| 428 | 修改/删除缺少 If-Match |

验证命令：`node --test code/app/test/events-api.test.mjs`。
设置 `SIMPLECAL_TEST_SERVER_DIR` 可将该测试指向通用运行包的 server 目录。
测试覆盖新 API / KV / DAV 的互读互写、账号隔离、CSRF、并发旧版本竞争、规则与提醒编辑和输入错误。
