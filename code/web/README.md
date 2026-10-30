# SimpleCal 前端（code/web）

SimpleCal 的本地优先 Web 前端，使用自建 REST 与 Cookie 会话。
日历数据通过同源 API 访问，由 `code/app/` 持久化。

- 界面语言：简体中文。
- 运行期依赖：零，无框架、CDN 或第三方 SDK。
- 构建期依赖见 `package.json`。
- 来源与许可见 `THIRD_PARTY_NOTICES.md` 与 `LICENSE`。

## 命令

```bash
npm ci               # 安装构建/测试依赖
npm run dev          # 开发服务器 http://127.0.0.1:5173
npm run build        # 产出 dist/
npm run preview      # 预览 dist/ http://127.0.0.1:4173
npm run mock         # 开发契约服务 http://127.0.0.1:5290
npm test             # 前端测试
```

`npm run mock` 仅用于开发，不进入运行产物，也不可用于生产。

## 目录

```text
src/
  main.js            引导：会话检查 → 登录页 / 数据加载 → 应用
  js/
    api-client.js    同源 fetch（Cookie、CSRF、401/412 映射）
    kv-rest.js       兼容 KV API 适配器
    auth.js          登录、登出与当前用户
    store.js         日历数据模型
    offline-store.js 离线快照
    views/           年/月/周/四日/日/日程视图
    modal.js         事件、任务与外出编辑器
  i18n/              中文字典与文案
  styles/            SimpleCal 主题与布局
tests/               前端测试
dev-mock/            开发契约服务
```

## 后端契约

前端使用同源 `/api/v1/auth/*`、`/api/v1/me`、`/api/v1/kv` 与日历接口。
在 fnOS 网关下自动跟随 `/app/SimpleCal` 前缀，通用部署默认使用根路径。

## 许可

MIT。原始版权与第三方声明见 `LICENSE` / `THIRD_PARTY_NOTICES.md`，SimpleCal 的改造部分同样使用 MIT。
