/**
 * UID 与资源名的字符集（0.5.0 客户端兼容）。
 *
 * 真实客户端生成的 UID 普遍带域名后缀：Apple Calendar 是 `…@apple`，
 * Thunderbird 是 `…@mozilla.org`，DAVx5 也会用 `@`。这里早先只允许
 * `[A-Za-z0-9._-]`，第三方客户端 PUT 事件会拿到 400 "invalid resource path"——
 * 等于把这些客户端挡在门外。
 *
 * 允许的字符保持跨平台安全：不含路径分隔符、控制字符与 Windows 保留字符，
 * 因此放宽字符集不会削弱目录穿越防护（`/`、`\`、`\u0000` 依旧不在其中）。
 */
export const UID_CHARS = 'A-Za-z0-9._@-';

/**
 * UID 长度上限。
 *
 * 沿用存储层原有的 128（`file-store` 的 `UID_RE` 与 DAV 的 `RESOURCE_RE`
 * 都是这个数），而不是放宽：`UID` 会直接变成磁盘文件名 `<uid>.ics`，
 * 128 给后缀留足了余量。
 *
 * 顺带修掉一处历史不一致：AI 侧以前允许 255 位 UID，可存储层只收 128，
 * 于是超长 UID 会先通过 AI 校验、再在落盘时被拒（错误发生在很深的地方）。
 * 现在两侧同源，超长 UID 在入口就被挡下。
 */
export const UID_MAX = 128;

/**
 * 事件 UID（存储层、DAV 资源名、AI 侧共用的基础规则）。
 *
 * 显式排除 `.` 与 `..`——它们虽然能通过字符集，却会让 `<uid>.ics` 变成
 * `.ics` / `...ics` 这类怪名字。
 */
export const UID_RE = new RegExp(`^(?!\\.{1,2}$)[${UID_CHARS}]{1,${UID_MAX}}$`);

/** 更严的变体：必须以字母数字开头（AI 生成的事件沿用这个口径）。 */
export const STRICT_UID_RE = new RegExp(`^[A-Za-z0-9][${UID_CHARS}]{0,${UID_MAX - 1}}$`);

/** DAV 资源名：`<uid>.ics`。 */
export const RESOURCE_RE = new RegExp(`^(?!\\.{1,2}\\.ics$)[${UID_CHARS}]{1,${UID_MAX}}\\.ics$`, 'i');

/**
 * KV 键。
 *
 * 通用键沿用原来的 256 上限；日历事件键是 `cal:<cal>:<kind>:<uid>`，
 * 最长可达 `cal:` + 128 + `:evt:` + 128 = 265，因此上限定为 512，
 * 否则「日历键合法、通用键上限更短」会让合法的日历键先被通用上限挡掉。
 */
export const KV_KEY_RE = new RegExp(`^[A-Za-z0-9:._@-]{1,512}$`);
export const KV_CAL_KEY_RE = new RegExp(
  `^cal:([A-Za-z0-9._-]{1,128}):(evt|task):([${UID_CHARS}]{1,${UID_MAX}})$`,
);
export const KV_LEGACY_EVT_RE = new RegExp(`^cal:evt:([${UID_CHARS}]{1,${UID_MAX}})$`);
export const KV_LEGACY_TASK_RE = new RegExp(`^cal:task:([${UID_CHARS}]{1,${UID_MAX}})$`);

/**
 * 日历标识：目录名，仍保持严格字符集（不含 `@`）——
 * 日历 ID 会直接变成磁盘上的目录名，没必要放宽。
 */
export const CAL_ID_RE = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,128}$/;

/**
 * 事件标识：与 `UID_RE` 同口径（事件 id 就是 UID，也是落盘文件名）。
 */
export const EVENT_ID_RE = UID_RE;
