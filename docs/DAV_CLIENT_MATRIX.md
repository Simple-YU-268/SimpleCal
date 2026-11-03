# 客户端兼容矩阵

SimpleCal 同时提供 Web 界面和标准 CalDAV 服务端。第三方客户端能连上、能读写，
才算真的兼容。这一页记录**验证过什么**、**怎么复现**，以及哪些还没人工确认。

> 原则：不写"应该可以"。每一行要么有自动化用例守着，要么明确标成待人工验证。

## 一、为什么需要这张表

服务端的第一版把事件 UID 的字符集限死在 `[A-Za-z0-9._-]`。这个限制在自测里
永远不会暴露——Web 自己生成的 UID 是 UUID，不含那些字符。但真实客户端不一样：

| 客户端 | 生成的 UID 形态 |
| --- | --- |
| Apple Calendar（macOS / iOS） | `<UUID>@apple` |
| Thunderbird | `<UUID>@mozilla.org` |
| DAVx5（Android） | `<UUID>@davx5` 或纯 UUID |
| Google Calendar | `<id>@google.com` |

带 `@` 的 UID 打到服务端，会被资源名校验判为非法路径，直接返回
`400 invalid resource path`——**这些客户端连一个事件都写不进去**。

## 二、字符集口径（0.5.0）

UID 与资源名的字符集统一收敛到 `code/app/lib/identifiers.mjs`，全项目只此一处定义：

```js
export const UID_CHARS = 'A-Za-z0-9._@-';
export const UID_MAX = 128;
```

- **放宽**：新增 `@`。真实客户端的 UID 普遍带域名后缀，没有它就写不进来。
- **不放宽**：路径分隔符 `/`、反斜杠 `\`、控制字符（含 `\u0000`）、Windows 保留字符
  依旧不在集合内——放宽字符集**不会**削弱目录穿越防护。
- **长度**：维持 128。UID 会直接变成磁盘文件名 `<uid>.ics`，128 给后缀留足余量。
  顺带修掉一处历史不一致：AI 侧以前允许 255 位 UID，可存储层只收 128，超长 UID
  会先通过 AI 校验、再在落盘时被拒。现在两侧同源，入口就挡下。

涉及的文件（改动前 UID 字符集在 5 处各写一遍，是这个 bug 的根因）：

| 文件 | 用途 |
| --- | --- |
| `code/app/lib/identifiers.mjs` | **唯一**定义处 |
| `code/app/dav/handler.mjs` | DAV 资源名 `<uid>.ics` |
| `code/app/store/file-store.mjs` | 落盘文件名 |
| `code/app/api/kv.mjs` | KV 键 `cal:<cal>:<kind>:<uid>` |
| `code/app/lib/event-service.mjs` | 事件标识校验 |
| `code/app/lib/ai-service.mjs` / `ai-store.mjs` | AI 侧同口径 |

## 三、兼容矩阵

状态含义：

- **自动** = 有自动化用例，每次提交都跑。
- **人工** = 需要真实客户端/设备，尚未在本轮确认。

| 客户端 | 版本 | 平台 | 验证方式 | 状态 | 备注 |
| --- | --- | --- | --- | --- | --- |
| tsdav | 2.5.0 | Node.js | `code/web/e2e/dav-client.spec.js` | 自动 | 发现日历、列对象、PUT / GET / DELETE；带 `@` 的 UID 可写可读可删 |
| Apple Calendar | macOS 15 / iOS 18 | macOS / iOS | 手工：添加账户 → 新建事件 → 同步 | 人工 | UID 形如 `<UUID>@apple`，`@` 已放行 |
| Thunderbird | 128 ESR | macOS / Windows | 手工：添加日历 → 新建事件 → 同步 | 人工 | UID 形如 `<UUID>@mozilla.org` |
| DAVx5 | 1.6.x | Android | 手工：添加账户 → 新建事件 → 同步 | 人工 | 纯 UUID 与带 `@` 两种形态都应可用 |
| Google Calendar | 网页 | 浏览器 | 手工：添加账户 → 新建事件 → 同步 | 人工 | UID 形如 `<id>@google.com` |

## 四、自动化验收

### 4.1 UID 字符集回归

`code/app/test/dav-uid-interop.test.mjs`（后端直接起真实服务）：

1. DAV `PUT` 一个 `interop-001@client.example` 的事件 → 期望 `201`；
2. 再 `GET` 回来，UID 原样；
3. Web 侧（KV 门面）能列到同一条事件——**两侧是同一个对象**；
4. 落盘文件名保持 `<uid>.ics` 原样，不转义、不丢字符；
5. 反向：Web 写入带域后缀的 UID，DAV 侧能读回；
6. 放宽字符集后，路径穿越与非法字符**仍然被拒**：
   `..%2F..%2F`、`%2F`、`%20`、`\u0000`、`.txt` 全部 400/404。

第 6 条是这个改动最该守住的一条——放宽字符集不等于放宽路径校验。

### 4.2 Web ↔ DAV 双向一致

`code/web/e2e/dav-client.spec.js`（Playwright + tsdav，跑在真实后端上）：

1. Web 界面新建事件 → tsdav 能读到，UID 一致；
2. tsdav 改标题（标准 `If-Match` 更新）→ Web 刷新后看到新标题；
3. tsdav 删除 → Web 刷新后看不到。

这三条对应路线图 0.5 的验收口径"Web 与 DAV 双向修改一致"。

### 4.3 复现

```bash
cd code/app
node test/dav-uid-interop.test.mjs      # UID 字符集回归

cd code/web
npm install                              # 含 tsdav（devDependency）
npm run test:e2e                         # 含 dav-client.spec.js
```

## 五、还没做完的

- **人工验证未做**：上面四个真实客户端都还没有在本轮实机确认过。自动用例覆盖的是
  协议行为，不能替代真机。
- **日期兼容未完成**：共享语料已覆盖夏令时、全天、跨时区、WKST、EXDATE 和单次修改，
  已发现并修复全天 DAV 展开错误。仍有 12 个产品时区差异 TODO；详见
  [日期兼容记录](DATE_COMPATIBILITY.md)。
- **重复规则迁移待定**：已与 `ical.js 2.2.1` 做差异测试；参考库本身有 3 个闰日差异 TODO。
  固定期望不随参考库更改，暂不替换运行期展开逻辑。

## 六、给排查用的结论

第三方客户端写不进去时，按这个顺序看：

1. `PUT` 返回 400 且正文是 `invalid resource path` → UID 含 `@` 以外的非法字符，
   或超长（> 128）。对照第二节的字符集。
2. `PROPFIND` 能看到日历但 `REPORT` 列不出对象 → 看服务端的 `supported-report-set`
   与 `Allow` 头，路线图 0.5 的协议基线用例覆盖这两项。
3. 写进去了但 Web 看不到 → 多半是 UID 与文件名不一致；服务端会记
   `uid-name-mismatch` 访问日志。
