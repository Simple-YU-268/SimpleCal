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
普通 CalDAV 对象 GET/HEAD 也支持 If-Match 和 If-None-Match，和 CardDAV、集合导出共用条件响应逻辑。
命中 If-None-Match 返回无正文 304；非法标签返回 400，If-Match 不匹配返回 412。
农历每年重复对象在存储队列中物化 RDATE；内容变化同时更新 ETag、ctag 和同步记录，
现在也接受条件缓存。旧版本写入在物化后返回 412，客户端应重读再编辑。
读操作可能提交服务端生成的 RDATE 更新；这不授予客户端只读日历的写权限。
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
单事件 KV PUT/DELETE 也将条件头交给共享领域服务，在提交队列内检查版本。
JSON 编辑保留未建模的直接 VEVENT 属性；会丢失未知嵌套组件的编辑明确返回 409。
只读/隐藏集合还会在提交前重新检查。

## 查询过滤与 XML

REPORT 和 PROPFIND 按命名空间 URI 识别操作和属性，支持任意前缀及默认命名空间。
同名但命名空间不同的属性作为原命名空间的 404 propstat 返回。非法 XML、DTD、
自定义实体、未声明前缀及超限 XML 返回 400。报告控制节点只从规定的直接子节点读取。

calendar-query 支持 VCALENDAR 下的 VEVENT/VTODO 组件过滤、属性和参数存在/缺失、
text-match 子串与 negate-condition，以及 i;ascii-casemap、i;octet 比较。
多个属性条件必须同时满足，参数和文本条件必须匹配同一属性实例。
组件时间范围使用有效 UTC date-time；重复事件必须同时提供起止边界。
复杂子组件、属性时间范围、重复任务时间查询及多个组件实例的属性联合过滤明确返回
403 supported-filter，不支持的比较规则返回 403 supported-collation。
calendar-data 仅支持 text/calendar 2.0 与有效起止时间的 expand；其他投影/格式返回
403 supported-calendar-data。暂不声明任意 ICS 查询或完整 RFC 一致性。

## multiget 集合约束

calendar-multiget 只接受日历集合为报告目标，href 必须指向该账号、该集合内的对象。
addressbook-multiget 同样限定当前账号与地址簿。越界、非法或不存在的 href 返回 207 中的单项 404。
支持集合相对 href、内部绝对路径、公开绝对 URL 和带公开子路径的根相对 href。
只接受当前 origin 或配置的公开 origin；拒绝凭据、query、fragment、点段和编码路径分隔符。
href 仅作为资源标识解析，不向其 URL 发起网络请求。

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
联系人资源使用 `.vcf`。当前不做 vCard 版本转换或属性投影；sync-collection 支持下面的有界分页。

## 有界增量同步

CalDAV 与 CardDAV 的 sync-collection 接受 `D:limit/D:nresults`（1–1000），默认每页 1000。
截断响应仍为 207，附集合级 507 number-of-matches-within-limits 和不透明的续传 token。
服务端保留固定内容快照，翻页期间的更新/删除/MOVE 不改变已捕获内容；
最后一页返回捕获时的水位，客户端随后继续增量请求以取得分页期间的变更。
续传支持服务重启；token 必须用于同一账号、同一集合，集合隐藏或授权撤销后仍会拒绝。
快照有效期 24 小时，每集合最多 32 个活动快照，每个序列化快照最多 32 MiB；
超限返回 507，过期/无效 token 返回 403 valid-sync-token，客户端应完整重同步。

CalDAV 完成 token 现在携带集合 epoch。旧格式 token 会被拒绝并要求重新同步，
避免删除后重建同名集合误用旧水位。删除后重建同 UID 的对象以最终存活对象报告。

## 本地协作与委托

`GET/PUT /api/v1/calendars/:id/grants` 仅管理当前账号拥有的日历。
PUT 正文为 `{"grants":[{"userId":"账号 ID","perm":"read"}]}`，perm 可为 read/write，最多 100 项。
受托用户使用 owner 的具体 DAV 集合路径访问，不能枚举 owner 的 home 或 principal，
不能管理授权或集合属性。MOVE 的源和目标分别检查授权；撤销立即生效。
这是本地账号的日历级授权，不是任意 WebDAV ACL、用户组或跨服务器委托。

`GET/POST /api/v1/scheduling` 提供本地邀请状态及提交，正文仅接受 `{"content":"iTIP ICS"}`。
身份由登录账号推导（配置 email，否则 username@simplecal.local），不接受正文指定 actor/sender。
支持单个非重复 VEVENT 的 REQUEST/REPLY/CANCEL、序列、幂等及持久化发件箱。
`POST /api/v1/scheduling/outbox/:id/deliver` 显式投递至唯一、启用的本地账号；
未知收件人进入失败/重试流程，不自动发送邮件或联系外部服务器。
`DELETE /api/v1/scheduling/outbox/:id` 清理终态记录；投递租约、重试次数和容量均有限制。
邀请账本与事件日历独立，收到邀请不会自动授予日历权限。

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

Provider v2 增加 getEvents（最多1000项）、queryCandidates、syncPage。
源快照缓存最多32 MiB，通过文件名、大小、纳秒mtime/ctime指纹发现手动复制、编辑或删除；
读取列表也按32 MiB预算限制。候选过滤保守排除明确不相交的UTC单次事件，
重复、TZID、浮动及无法确定边界的内容继续交给精确查询过滤器。

集中描述 OPTIONS 的 Allow 与 PROPFIND 的 supported-report-set，不公布 LOCK/UNLOCK。
CalDAV 支持 calendar-query、calendar-multiget、sync-collection、free-busy-query；
CardDAV 能力只在地址簿路径公布。能力描述不是完整协议一致性认证。

仍按单写入进程部署，不能将进程内队列视为跨进程文件锁。原子 rename、元数据恢复和
目录 fsync/断电持久性不是同一承诺；Linux/Docker、真实客户端及多进程共享卷仍需目标环境验证。
