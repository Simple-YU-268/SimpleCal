# SimpleCal DAV 接口（未发布）

普通用户客户端、DAV 和 AI 共用数据存储，AI 保留专属授权与提案约束。

## 集合导出

```http
GET /calendars/<username>/<calendarId>/
Authorization: Basic <credentials>
```

集合 GET 现在返回 `text/calendar` 的完整 ICS，而不是对象文件名文本列表。
对象列表可用 PROPFIND 或普通用户 API 获取。
导出将对象合成一个 VCALENDAR，同 TZID 的 VTIMEZONE 依照既有导出逻辑去重。
空集合也返回有效 VCALENDAR，任务集合导出 VTODO。
同一 TZID 若存在彼此冲突的定义，仍沿用现有“保留首个定义”的限制。

响应提供 `Content-Disposition: attachment` 和按导出内容计算的 ETag。
集合 PROPFIND 的 getetag 与该导出 ETag 一致；getctag 和 sync-token 保留原增量同步语义。
HEAD 返回相同描述头和长度，无响应体。
`If-None-Match` 命中当前导出 ETag 时返回 304；集合修改后重新请求可取得新导出。
条件读取在本轮只新增于集合 GET/HEAD，不声称所有对象读取均已支持缓存条件。
保持 GET 与 HEAD 的账号认证、只读/隐藏集合策略。

## 对象条件写入

DAV PUT/DELETE 继续接受已有路径：
`/calendars/<username>/<calendarId>/<resource>.ics`，可使用配置的 DAV prefix。

- `If-None-Match: *` 用于仅创建；并发创建同一对象至多一个成功。
- `If-Match: "<etag>"` 用于更新/删除已读取的版本；过期返回 412。
- If-Match 使用强比较，弱标签不作为当前强标签的匹配。
- If-None-Match 使用弱比较；引号标签列表可包含合法的逗号字符。
- 无效实体标签语法返回 400。通配符必须独立出现。
- 不带条件头的 DAV 写入仍兼容旧客户端；普通用户事件 API 仍要求修改/删除带 If-Match。

最终条件检查与写入在同一每日历队列内，与普通事件 API 的条件提交互斥。
旧 KV 的前置检查方式本轮未更改，不能由此推断所有入口都有完全相同的条件写契约。
只读/隐藏集合还会在提交前重新检查。

## MOVE

事件和任务对象支持同集合及跨集合 MOVE：

- `Destination` 必须指向当前服务；配置公开 URL 时也接受对应的公开绝对地址。
- `Overwrite: F` 在目标存在时返回 412；源对象支持 If-Match 等实体前置条件。
- 源和目标都重新检查只读/隐藏权限，目标集合必须接受源对象的 VEVENT/VTODO 类型。
- 创建返回 201 和 Location，覆盖返回 204；内容不变，因此对象 ETag 保持不变。
- 源集合写入删除墓碑，目标集合更新对象 ctag；内容移动与同步元数据由持久化日志恢复。

## CardDAV

独立地址簿存储位于 `<varDir>/addressbooks/`，不复用事件 JSON 或 ICS 文件。
每个账号首次访问时获得 `contacts` 默认地址簿，也可通过扩展 MKCOL 创建地址簿。

支持 vCard 3.0/4.0 的单对象 GET/HEAD/PUT/DELETE、ETag 条件、PROPFIND/PROPPATCH、
addressbook-query、addressbook-multiget 和 sync-collection。UID 在同一地址簿内唯一，
联系人资源使用 `.vcf`。当前不做 vCard 版本转换、属性投影或报告分页。

CalDAV principal 同时发布 CardDAV `addressbook-home-set`；`/.well-known/carddav`
与 `/.well-known/caldav` 都跳转到 principal 根路径。

## 共享链接

`POST /api/v1/shares` 创建受限只读链接，`GET /api/v1/shares` 列出，
`DELETE /api/v1/shares/:id` 吊销。`calendar` 模式导出完整 ICS；`freebusy` 模式只返回
忙闲时间段，不返回标题、UID 或正文。过期、吊销、账号禁用或集合隐藏后立即返回 404。
分享令牌只在创建响应中返回明文，服务端保存 SHA-256 摘要。该能力不是完整 ACL 或用户组系统。

## 公开 URL

可选 `CALDAV_PUBLIC_BASE_URL`（也可写数据目录 `config.json:publicBaseUrl`）声明外部
HTTP(S) origin 和可选子路径，例如 `https://cal.example.com/simplecal`。配置后，DAV href、
Location、分享 URL 与 `/api/v1/calendars/server-info` 统一使用该地址；未配置时保留原行为。
不要从不可信客户端头推导公开地址。

## 存储与能力边界

启动时校验文件存储 provider 接口；事件模型解析缓存按内容哈希失效。只读
`verifyStorage` 可检查主数据、状态记录和 MOVE 恢复日志，不会自动修复。对象提交后发出
不含正文的内部结构化变更事件。

集中描述 OPTIONS 的 Allow 与 PROPFIND 的 supported-report-set，不公布 LOCK/UNLOCK。
CalDAV 支持 calendar-query、calendar-multiget、sync-collection、free-busy-query；
CardDAV 能力只在地址簿路径公布。能力描述不是完整协议一致性认证。

仍按单写入进程部署，不能将进程内队列视为跨进程文件锁。原子 rename、元数据恢复和
目录 fsync/断电持久性不是同一承诺；Linux/Docker、真实客户端及多进程共享卷仍需目标环境验证。
