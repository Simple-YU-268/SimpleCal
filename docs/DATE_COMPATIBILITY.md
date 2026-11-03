# 日期兼容语料与差异记录

更新：2026-11-03。用于 0.5 开发验收，尚未达到完整日期兼容。

## 可复现的共享基线

`code/test-fixtures/date-corpus.json` 固定输入和人工可审阅的期望日期，不从产品输出反推答案。
`code/scripts/date-corpus-worker.mjs` 对同一份 ICS 分别运行 Web 解析/展开、后端 vendored
解析/展开和独立参考实现 `ical.js 2.2.1`。每个子进程启动前设置 TZ，并核对实际生效的时区；
覆盖 UTC、Asia/Shanghai、America/New_York，避免修改测试主进程的全局时区。

14 组输入覆盖 COUNT、包含终点的 UNTIL、EXDATE 消耗计数、单次实例移动、月底跳过、
闰日跳过、两种 WKST、跨夏令时的全天事件、纽约春秋切换，以及 UTC 序列不应跟随查看者夏令时。
纽约 VTIMEZONE 使用固定可审阅的观测规则，不调用产品的时区生成器来充当参考答案。

```powershell
npm --prefix code/web ci
npm --prefix code/web run test:dates
node --test code/app/test/ical-expand-date.test.mjs
```

当前结果：133 个检查，122 通过、11 个 TODO、0 个未分类失败。
**11 个 TODO 不能计作兼容通过**。UTC 系列还检查导出后重新解析、展开的实例保持一致。
若已知问题被修好，偏差守卫会失败，要求删除对应标记并启用正常比较。

发布前严格验收可执行：

```powershell
$env:SIMPLECAL_DATES_STRICT = '1'
npm --prefix code/web run test:dates
Remove-Item Env:SIMPLECAL_DATES_STRICT
```

严格模式取消全部 TODO 豁免，当前预期退出 1，报告 11 个失败。

## 本轮已修复：DAV 全天展开

`expandToIcs` 原先直接把内部当地午夜和包含末日的结束时刻转换成 UTC 日期。
在上海会把 DTSTART 写成前一天，DTEND 也没有恢复为排他的下一天；重复实例的
RECURRENCE-ID 还写成了 DATE-TIME。

现在输出当地 DATE、排他 DTEND 和 `RECURRENCE-ID;VALUE=DATE`。
`code/app/test/ical-expand-date.test.mjs` 在上海、纽约独立进程中验证单日、多日跨夏令时、
EXDATE 和普通定时日程，日期契约不依赖参考库。

## 仍待修复的产品差异

1. `source-zone-dst`：上海或 UTC 查看者展开纽约周重复时，首日起点被正确解析，后续却按查看者
   本地日历生成。纽约 2026-03-01 09:00 应从 3 月 8 日起变为 13:00Z，实际仍为 14:00Z。
   秋季切换有反向的一小时偏差。共 4 个场景 × Web/后端 = 8 个 TODO。
UTC 系列的宿主夏令时偏移已修复：显式 UTC 规则保留 `recurrence.timezone=UTC`，
按 UTC 日期计算周、月、年和日重复，星期与 WKST 使用来源日期，例外保留真实瞬间。
前后端共用 UTC 日历计算模块，原有未标记的本地规则继续按原语义展开。
新增跨查看者日期的星期规则与夏令时边界例外回归，移除原有 4 个产品 TODO。

语料对这些偏移逐项锁定实际分钟差，新增偏移、实例数量变化或前后端漂移均会失败。
后续修复须同时考虑原系列的 TZID、UTC/floating 区别、BYDAY/WKST 的日期基准，
以及 EXDATE/RECURRENCE-ID 的稳定键；仅平移显示时间会破坏既有例外。
这一轮不修改存储格式或改写用户日程。

## 参考库差异与采用决定

`ical.js 2.2.1` 对 `DTSTART:20240229T090000Z` 配 `FREQ=YEARLY;COUNT=3` 返回
2024-02-29、2025-03-01、2026-03-01；固定期望是跳过非闰年的
2024-02-29、2028-02-29、2032-02-29。产品的前后端在这组输入上符合固定期望。
该差异在三个进程时区均复现，另列 3 个参考库 TODO，并锁定参考库实际结果。

因此保留 `ical.js` 为**开发期比较工具**，固定版本，不替换运行期展开器，也不把它的输出当成
无条件正确答案。后续迁移需先补偿参考库差异，并验证数据与实例键兼容。

## 覆盖边界

本语料是新增的日期基线，不替代原先缺失的 S1–S8 外部 ICS 样本。
纯 RDATE、不可表达的复杂 BY* 规则、夏令时不存在/重复的当地时刻、农历物化及真实客户端
仍需各自扩展验收。浏览器模拟和独立参考库都不能代替实体 iOS/Android 客户端测试。
