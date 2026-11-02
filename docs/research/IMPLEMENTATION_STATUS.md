# CalDAV 演进计划实施状态

更新：2026-10-31。改动尚未提交或发布。

## 计划对应关系

| 阶段 | 已交付 | 状态与边界 |
| --- | --- | --- |
| 1 协议正确性 | 严格有界 XML、命名空间、查询过滤、明确拒绝不支持条件；12 项查询与 Radicale 实测一致 | 支持的子集已验证；不是完整 RFC 认证 |
| 2 同步版本 | 存储队列中物化农历 RDATE；GET、REPORT、导出、ETag、同步水位一致 | 跨农历年度、并发、旧版本冲突和重启验证通过 |
| 3 批量与候选查询 | Provider v2 的 getEvents/queryCandidates、32 MiB 源快照缓存、文件指纹失效、保守 UTC 候选过滤；1k/10k 基准 | 已交付文件 provider 优化；未换数据库，不声称数据库索引或跨进程写锁 |
| 4 有界同步 | CalDAV/CardDAV 持久化快照分页、固定水位、24h token、集合 epoch、容量限制、重启续传 | 修改/删除/MOVE/重建与隔离回归通过 |
| 5 领域服务 | API/DAV/KV 共用 ICS 约束及队列内条件变更；保留未建模直接属性 | 未知嵌套组件的 JSON 编辑返回409；AI授权保持独立 |
| 6 协作 | 本地账号 read/write 日历授权、即时撤销、显式本地 REQUEST/REPLY/CANCEL、幂等、持久化投递/失败/重试/租约 | 本地非重复事件子集已验证；未实现跨服务器 SMTP/iMIP/S/MIME、任意ACL/组或完整RFC6638自动调度 |
| 7 参考与客户端 | 可复用互操作工具；SimpleCal 与 Radicale3.9.0 的11项矩阵；只读诊断与性能记录 | SOGo/DAViCal/Baïkal 和真实 Thunderbird/DAVx5/Apple Calendar 缺少目标运行环境，未实测 |

第6阶段采用“按需实现”的本地协作边界。若目标包含跨组织邮件邀请或完整 CalDAV scheduling，
还需补充目标协议、可信日历地址、邮件投递与签名配置，以及独立安全和客户端验收，不能将本地投递当成已完成外部邮件互操作。

## 当前验证结果

- 前端118个文件通过：1501项通过、1项跳过；构建成功。
- 后端初跑55个文件，保留原始46通过/9失败记录；失败项修复后重跑，最新53通过，2个因缺失样本夹具阻塞。
- 后续新增 source-cache 文件的3项测试通过，因此当前56个后端文件中54个已通过，2个仍受夹具阻塞。
- 打包产物的 CardDAV、事件API、DAV条件提交和公开路径6项集成检查通过。
- 零云依赖审计实际 app/web/dist：502文件、0命中；i18n、生命周期和图标审计通过。
- TLS回归发现中文 Windows 主机名被当作 ASCII 截断，现改为IDNA编码，相关42项回归通过。

原始报告及重跑记录：[后端初跑](evidence/backend-regression.json)、
[后端重跑与剩余原因](evidence/backend-reruns.json)、[前端与审计](evidence/frontend-regression.json)。
未覆盖的样本和目标平台不会按通过计数。

## 当前基准

10k合成对象的指纹校验后测量：冷读取约6384ms，暖组件候选查询约1415ms，
暖快照约742ms，批量100项约100ms。源文件指纹避免手工复制/同大小编辑/删除后继续返回陈旧缓存。
这是单机合成结果，候选查询仍需要读取文件元数据，不是生产延迟承诺；
详见 [客户端与性能验证](CLIENT_VALIDATION.md) 和 [完整基准](evidence/store-benchmark.json)。

## 兼容性与升级

- 新的 CalDAV 完成 token 携带集合 epoch，旧 token 返回 valid-sync-token，客户端需完整重同步。
- 多UID/mixed-component对象现在被共同领域约束拒绝；free-busy测试已改为逐对象上传合法fixture。
- 测试中的旧token数值位置、错误属性命名空间和旧HTTPS指引头已依照新契约校正。
- 源缓存检查文件名、大小及纳秒mtime/ctime；不提供外部进程并发非原子写入的一致性保证。
- 文件提交仍使用原有原子替换、日志和进程内队列；没有新增断电跨文件事务保证。

## 未完成验收所需条件

1. 仓库没有 `data/ical-samples/expected.json`、相应S1–S8源ICS及比较脚本。
   `m37-api.test.mjs` 的前置18项检查通过后因缺此文件中止；`m39-roundtrip.test.mjs` 也因此中止。
   原始样本不应从当前实现的输出反推生成，否则会失去独立验证价值。
2. 需要专用SOGo/DAViCal/Baïkal测试实例，以及Thunderbird/Android/macOS或iOS测试环境。
   当前Windows未安装相应服务运行时/客户端，也没有受控设备。

因此整体计划仍有外部验收和可能的跨服务器协作扩展，不能标为全部完成。
取得上述样本和环境后可继续执行 [互操作步骤](CLIENT_VALIDATION.md)。

## 运行包

已生成 `dist/SimpleCal-server-caldav-dev-20261031/`，仅用于开发评审，未部署或发布。
该运行包对应本轮代码，6项产物集成检查通过。完整接口见 [DAV接口](../DAV_API.md)。

测试生成的 `code/build-tmp/` 和 `.migrate-cli-test.log` 仍保留：自动审批拒绝了清理命令，
不影响源码或运行包检查。没有更改Git配置或规避该限制。
