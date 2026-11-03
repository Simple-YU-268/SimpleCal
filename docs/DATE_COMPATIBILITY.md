# 日期兼容语料与差异记录

更新：2026-11-03。用于 0.5 开发验收，尚未达到完整日期兼容。

## 可复现的共享基线

`code/test-fixtures/date-corpus.json` 固定输入和人工可审阅的期望日期，不从产品输出反推答案。
`code/scripts/date-corpus-worker.mjs` 对同一份 ICS 分别运行 Web 解析/展开、后端 vendored
解析/展开和独立参考实现 `ical.js 2.2.1`。每个子进程启动前设置 TZ，并核对实际生效的时区；
覆盖 UTC、Asia/Shanghai、America/New_York，避免修改测试主进程的全局时区。

18 组输入覆盖 COUNT、包含终点的 UNTIL、EXDATE 消耗计数、单次实例移动、月底跳过、
闰日跳过、两种 WKST、跨夏令时的全天事件、纽约春秋切换，以及 UTC 序列不应跟随查看者夏令时。
纽约 VTIMEZONE 使用固定可审阅的观测规则，不调用产品的时区生成器来充当参考答案。

```powershell
npm --prefix code/web ci
npm --prefix code/web run test:dates
cd code; node --test app/test/ical-expand-date.test.mjs
```

当前结果：167 个检查，164 通过、3 个参考库 TODO、0 个产品日期差异。
具名时区与 UTC 系列均检查导出后重新解析、展开的实例保持一致，另检查后端模型导出。
**3 个参考库 TODO 不能计作参考实现兼容通过**。
若已知问题被修好，偏差守卫会失败，要求删除对应标记并启用正常比较。

发布前严格验收可执行：

```powershell
$env:SIMPLECAL_DATES_STRICT = '1'
npm --prefix code/web run test:dates
Remove-Item Env:SIMPLECAL_DATES_STRICT
```

严格模式当前**退出 0**：产品（web/server）已经没有日期差异。
严格模式的判定口径是「产品不得有未解释的差异」，因此：

- 产品差异（`knownDifference`）在严格模式下一律变成失败，拦住发布；
- 参考库自身的差异（`oracleDifference`）始终记 TODO，由「参考库差异」用例逐项锁死
  实际结果，永远不算作兼容通过。

参考库那 3 个闰日差异按项目决定**不采用** ical.js 的语义（见下），所以让它们继续
拦住发布会使这道闸门永远无法变绿；改成「闸门只管产品」之后，严格模式才是可用的
发布判据。用一组注入过的产品差异验证过：普通模式下该项是 `# TODO`，
严格模式下是真实失败并让退出码变成 1。

## 本轮已修复：DAV 全天展开

`expandToIcs` 原先直接把内部当地午夜和包含末日的结束时刻转换成 UTC 日期。
在上海会把 DTSTART 写成前一天，DTEND 也没有恢复为排他的下一天；重复实例的
RECURRENCE-ID 还写成了 DATE-TIME。

现在输出当地 DATE、排他 DTEND 和 `RECURRENCE-ID;VALUE=DATE`。
`code/app/test/ical-expand-date.test.mjs` 在上海、纽约独立进程中验证单日、多日跨夏令时、
EXDATE 和普通定时日程，日期契约不依赖参考库。

## 已修复的时区差异

`source-zone-dst` 已修复：具名来源时区保存在规则中，先按来源时区的日历日期生成，
再用现有时区转换函数还原真实瞬间。纽约每周 09:00 在春秋切换后保持当地 09:00。
星期、WKST 和月重复序号使用来源日期；EXDATE 与 RECURRENCE-ID 保留真实瞬间。
前后端导出均保留时区，原有 8 个产品差异 TODO 已移除。
UTC 系列的宿主夏令时偏移已修复：显式 UTC 规则保留 `recurrence.timezone=UTC`，
按 UTC 日期计算周、月、年和日重复，星期与 WKST 使用来源日期，例外保留真实瞬间。
前后端共用 UTC 日历计算模块，原有未标记的本地规则继续按原语义展开。
新增跨查看者日期的星期规则与夏令时边界例外回归，移除原有 4 个产品 TODO。

新增来源时区跨查看者日期的星期、春季切换后的排除和单次移动回归。
旧的未标记本地规则继续按原语义展开，不批量改写用户日程。

## 参考库差异与采用决定

`ical.js 2.2.1` 对 `DTSTART:20240229T090000Z` 配 `FREQ=YEARLY;COUNT=3` 返回
2024-02-29、2025-03-01、2026-03-01；固定期望是跳过非闰年的
2024-02-29、2028-02-29、2032-02-29。产品的前后端在这组输入上符合固定期望。
该差异在三个进程时区均复现，另列 3 个参考库 TODO，并锁定参考库实际结果。

因此保留 `ical.js` 为**开发期比较工具**，固定版本，不替换运行期展开器，也不把它的输出当成
无条件正确答案。后续迁移需先补偿参考库差异，并验证数据与实例键兼容。

## 前后端共用的日期算术

重复规则的日期算术（UTC 序列与具名来源时区）只有一份源：
`code/shared/utc-recurrence.mjs`。前端与后端各留一份**生成物**：

| 源 | 生成物 |
| --- | --- |
| `code/shared/utc-recurrence.mjs` | `code/app/vendor/ical/utc-recurrence.js` |
| `code/shared/utc-recurrence.mjs` | `code/web/src/js/utc-recurrence.js` |

```powershell
cd code; node scripts/sync-utc-recurrence.mjs            # 写入
cd code; node scripts/sync-utc-recurrence.mjs --check    # 只检查，漂移时 exit 1
```

不能改成前端直接 `import` 后端那份：Docker 的前端阶段只 `COPY code/web/`，
e2e 的「两次真实构建」夹具也只复制前端树，跨目录 import 会让这两处构建当场失败。
生成物带 AUTO-GENERATED 头，`code/web/tests/web-tree-self-contained.test.js`、
`code/app/test/utc-recurrence-shared.test.mjs` 与 `code/scripts/date-corpus.test.mjs`
都会断言生成物与源一致，漂移即测试失败。

生成物里的 `./date-utils.js` 指向各自树里的同名文件，两处的 `isValidTimeZone` /
`zonedTimeToUTC` 必须行为一致——日期语料另有一项断言逐个时区核对这两个函数。

## 跑测试的方式

后端用例要从 `code` 目录跑（AI 与迁移用例会把临时目录放在 `code/build-tmp` 下，
从仓库根目录跑会被直接拒绝），并且**串行**执行：这些用例各自起一个后端进程，
端口是写死的（5287–5299 等），并行会互相抢占端口，看起来像随机失败。

```powershell
cd code; node --test --test-concurrency=1 app/test/*.test.mjs
```

端口被别的进程占住时，症状是某个 DAV 用例拿到 `200` 而不是 `207`——那是别人的
服务在应答，不是产品坏了。用例都支持环境变量改端口，例如
`$env:CALDAV_M34_PORT='5294'`。

## 覆盖边界

本语料是新增的日期基线，不替代原先缺失的 S1–S8 外部 ICS 样本。
纯 RDATE、不可表达的复杂 BY* 规则、夏令时不存在/重复的当地时刻、农历物化及真实客户端
仍需各自扩展验收。浏览器模拟和独立参考库都不能代替实体 iOS/Android 客户端测试。
