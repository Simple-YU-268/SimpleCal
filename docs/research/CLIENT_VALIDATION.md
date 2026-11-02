# CalDAV 互操作验证状态

执行日期：2026-10-30。平台：Windows，Node.js v24.20.0。

## 已实际执行

`node code/scripts/caldav-interop.mjs --output docs/research/evidence/simplecal-interop.json`

此命令启动自己的 SimpleCal loopback 服务和临时数据目录，创建随机 synthetic 日历与事件，
运行黑盒 HTTP 请求后关闭服务并删除自己的临时目录。未使用真实账号或日程。
结果见 [机器可读记录](evidence/simplecal-interop.json)：11 项检查全部通过。

同一工具还实际针对隔离的 Radicale 3.9.0 WSGI loopback 实例运行，11 项也全部通过，
记录见 [Radicale 互操作结果](evidence/radicale-interop.json)。安装包身份沿用
[Radicale 3.9.0 文件摘要](evidence/radicale-3.9.0.identity.json)。服务端启用 auth=none、
仅使用合成账号路径，临时存储在进程结束后移除；不代表真实认证、反向代理或生产部署验证。
工具最初将 DELETE 成功限制为 204，实测 Radicale 返回 200；已接受 200/204 两种成功响应，
并继续要求随后 GET 返回 404，避免把状态码差异误判成删除失败。

| 场景 | 实测结果 |
| --- | --- |
| OPTIONS 能力、principal 和 calendar-home 发现 | 通过 |
| MKCALENDAR、PUT 新建、GET、强 ETag | 通过 |
| multiget 同时查存在/缺失对象 | 通过 |
| calendar-query 组件与时间范围 | 通过 |
| 初始 sync-collection | 通过 |
| If-Match 更新、旧版本返回 412 | 通过 |
| MOVE、源 404 和目标可读 | 通过 |
| 增量同步同时包含源删除和目标新增 | 通过 |
| DELETE 后 GET 返回 404 | 通过 |

测试记录包含临时请求路径和状态码，不记录密码、认证头、Cookie 或事件正文。
此工具是协议探测器，不代表任何真实客户端已通过认证。

## 外部服务运行方法

仅在用户明确选定待测服务时使用：

```powershell
$env:CALDAV_INTEROP_PASSWORD = '<专用测试账号密码>'
node code/scripts/caldav-interop.mjs --url https://calendar.example/ --home https://calendar.example/calendars/test/ --user test --output interop-result.json
```

请求仅访问指定 origin，在明确给出的 home 下创建随机 `simplecal-interop-<UUID>/` 日历。
对象创建使用 If-None-Match:*，清理仅针对本次成功创建或移动的对象和集合。
没有隐式探测远端服务器。不得提供生产日历作为 home 的替代品。

外部服务器若不支持删除日历集合，工具会保留残留集合路径、cleanup=false 并以非零状态退出，
便于在管理界面清理。SimpleCal 当前 DAV 不支持集合 DELETE；默认本地运行通过移除整个
专用临时数据目录完成清理，因此不会留下测试数据。远程能力不完整时工具停止并记录失败场景，
不能把未执行的后续场景视为通过。

## 目标平台与参考服务缺口

本次只读检查了 PATH、Program Files、Program Files (x86)、LocalAppData/Programs 的对应安装目录。
PATH 中未找到 docker、php、psql、thunderbird 或 adb；检查到 wsl.exe，但其列表命令报告尚未安装 WSL。
这些是本次环境检查边界，不证明整台机器的任意位置都不存在相关程序。

| 目标 | 当前状态 | 尚需完成的实测 |
| --- | --- | --- |
| Radicale 3.9.0 | 先前基础/查询捕获以及本工具 11 项完整矩阵已通过 | 独立远端部署、真实认证与代理环境 |
| 独立 Baïkal | 未启动；当前无 PHP/容器运行时 | 在选定测试实例上执行矩阵并保存版本与结果 |
| SOGo | 未启动；当前无 Linux/容器环境 | 服务端实际发现、同步、移动、重复事件结果对照 |
| DAViCal | 未启动；当前无 PHP/PostgreSQL 运行时 | 服务端实际发现、同步、移动、重复事件结果对照 |
| Thunderbird | 未在所检查位置发现安装 | 专用测试配置实际发现、双向编辑、删除、冲突、重启 |
| DAVx5 | 无 adb/受控 Android 设备 | Android 设备真实同步和冲突场景 |
| Apple Calendar | 当前 Windows 无 Apple Calendar/macOS 运行环境 | macOS/iOS 设备真实发现、事件/任务同步及跨年 |

没有安装大体积外部系统，也没有将不可用平台标成已验证。第 7 阶段的可复现探测工具已实现；
上述外部实例及真实客户端验证仍未完成，需要对应运行环境。源码阅读、HAR 解析和本地黑盒请求
都不能代替这部分实测证据。

## 存储缓存复测与只读诊断

缓存优化前后的 1k/10k 测量分别保存在
[优化前](evidence/store-benchmark-before-cache.json) 和 [优化后](evidence/store-benchmark.json)。
复现命令：`node code/scripts/benchmark-calendar-store.mjs`。每次使用独立临时目录、
最多 64 个并发文件写入完成种子数据，再实例化新的 provider；不在运行中的缓存后面改文件。

| 10k 合成对象场景 | 优化前 ms | 优化后 ms |
| --- | ---: | ---: |
| 冷投影检查加单对象读取 | 17961.276 | 6384.059 |
| 暖批量 100 对象 | 162.098 | 100.401 |
| 暖连续 100 次单对象读取 | 126.344 | 62.428 |
| 组件候选查询 | 7939.767 | 1414.916 |
| 集合快照 | 9285.009 | 741.715 |

全部数量校验和临时目录清理通过。这里的“冷”指 provider 投影缓存未初始化，
未清空操作系统文件缓存；数据无重复规则或农历写入；单次宿主测量不能作为延迟保证。
候选查询仍是内存组件过滤，不应将其描述为数据库范围索引。
该表采用加入源文件指纹校验后的最新测量；此前8.641/1.945ms的无指纹缓存结果
另存为历史记录，不能作为最终实现的性能。指纹校验保留了运行时手动复制/修改文件的可见性。

另行执行只读诊断探测：先建立已有实例及未展开的农历对象，记录 11 个文件的 SHA-256 和 mtime，
以 `createApp(readOnly=true)` 和推进到 2040 年的时钟重新打开，执行对象读取、syncToken、列表。
前后文件内容与 mtime 完全一致，农历源内容未变化；见 [只读结果](evidence/readonly-diagnose.json)。
该观察覆盖已有实例的只读启动/读取，没有声称对任意损坏配置或不存在实例都不会写文件。
