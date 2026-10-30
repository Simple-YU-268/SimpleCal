# 从源码构建 SimpleCal

构建通用服务器运行包需要 Node.js 22。只有安装前端开发依赖时需要网络；运行产物不依赖 npm 包。

## 目录

```text
code/
├── app/       后端（Node ESM，零运行期 npm 依赖）
├── web/       前端（Vite + 原生 JavaScript）
├── shared/    前后端共用模块
├── fnos/      fnOS 包工程
├── scripts/   装配、审计与构建脚本
└── build/     fnOS 打包与校验脚本
```

## 通用服务器运行包

```bash
cd code/web
npm ci
cd ../..
node code/scripts/build-server.mjs
```

产物为 `dist/SimpleCal-server-<版本>/`，包含后端、前端、部署示例与许可文件。
可用 `--name <目录名>` 指定其他输出名称；同名目录已存在时构建会安全失败，不覆盖旧产物。

前端构建后，`code/scripts/stamp-version.mjs` 会写入 `simplecal-version` 与
`simplecal-build` 元信息，并将 Service Worker 缓存命名为 `simplecal-shell-<版本>-<指纹>`。

## fnOS 安装包

先构建前端，再装配并打包：

```bash
cd code/web && npm ci && npm run build
cd ../..
node code/scripts/stamp-version.mjs
node code/scripts/assemble.mjs
node code/build/make-fpk.mjs --out dist/SimpleCal-0.3.4.fpk
node code/build/verify-fpk.mjs dist/SimpleCal-0.3.4.fpk 0.3.4 --port-entry --url-entry
```

装配会复制后端与前端、核对 manifest 和桌面入口，并检查图标。正式 Linux 包构建也可使用
`code/scripts/build-fnos.sh`，通过 `EXPECTED_VERSION` 指定版本。

## 本地运行

```bash
cd code/app
node server.mjs
```

默认监听 `0.0.0.0:5280`。通用部署建议显式设置 `CALDAV_DATA_DIR`，完整配置见
[`SERVER.md`](./SERVER.md) 与 [`code/app/README.md`](./code/app/README.md)。

## 测试

```bash
# 前端
cd code/web && node scripts/test.mjs

# 后端逐文件运行
cd code
for f in app/test/*.test.mjs; do node "$f" || exit 1; done
```

部分部署测试需要从 `code/` 目录运行；融合功能产物测试可通过
`SIMPLECAL_TEST_SERVER_DIR` 指向通用运行包的 `server/` 目录。

## 发布前检查

```bash
cd code
node scripts/audit-zero-cloud.mjs
node scripts/audit-i18n.mjs
node scripts/audit-lifecycle.mjs
node scripts/check-icons.mjs
```

源码与配置统一使用 UTF-8；shell 脚本保持 LF 与可执行位，前端样式保持项目既有换行约定。
同一版本号不应重复发布不同内容；变更产物时同步更新版本与哈希。
