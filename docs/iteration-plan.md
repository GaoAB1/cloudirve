# Cloudirve 迭代规划（Iteration Plan）

> **文档定位**：本文档承接 `docs/design-spec.md`（MVP 设计基线），记录 MVP 完成后的迭代规划、
> 已落定的工作拆分与关键决策。后续每轮实施以本文档为蓝本；如与基线冲突，先在本文档修订并注明原因。
>
> **生成时间**：2026-09-25　**状态**：滚动维护（每轮完成后更新状态标记）

---

## 1. 已完成迭代回顾

| 迭代 | 内容 | 状态 |
|------|------|------|
| Iteration 1（MVP 主链路） | 登录、目录、上传、下载、重命名、删除 | ✅ 已完成 |
| Iteration 2（可恢复管理） | 回收站（恢复/永久删除/保留期自动清理）、存储配额 | ✅ 已完成 |
| Iteration 3（可查找/可分享） | 搜索（祖先链跳转）、上传面板（进度/重试/拖拽）、批量操作、分享链接（有效期+密码+撤销）、文件预览（图片/文本/PDF）、设置页 | ✅ 已完成 |
| 强化轮 1 | 操作日志（安全审计）、会话持久化与 30 天过期 | ✅ 已完成 |
| 强化轮 2 | 多用户管理（管理员模式） | ✅ 已完成 |
| 其他 | GHCR 镜像流水线、koboyo 手绘图标、SPA fallback | ✅ 已完成 |

当前架构基线：零依赖 Node 后端 + 原生前端，`metadata.json` 单文件存储（users/files/shares/sessions/activityLog），
scrypt 密码哈希，JWT 未引入（无外部服务依赖）。

---

## 2. 待实施迭代

### 2.1 第 3 轮：TOTP 两步验证（下一轮）

**目标**：为账号提供第二重验证因子，公网部署前的安全加固。

**技术方案（零依赖）**

- RFC 6238 TOTP 手写实现：`crypto.createHmac('sha1')` + Base32 手写编解码，约 80 行，容忍 ±1 时间窗
- 密钥：每用户独立 20 字节随机 Base32 secret，存 `user.totp = { secret, enabled, confirmed }`
- 开启流程（设置页）：
  1. `POST /api/auth/totp/setup` → 生成 secret（未确认状态），返回 `otpauth://totp/Cloudirve:{username}?secret=...&issuer=Cloudirve` 链接
  2. 用户在验证器 App 手动录入或粘贴链接（二维码不做后端生成，可选前端 CDN 渲染）
  3. `POST /api/auth/totp/confirm` {code} → 校验通过后 `enabled: true`，同时生成 **10 个一次性备用码**（明文展示一次，存 scrypt 哈希）
- 登录流程改造：密码正确且该用户 `totp.enabled` → 返回 `{ needTotp: true, challengeToken }`（短期一次性质询 token，5 分钟），前端展示验证码输入；`POST /api/auth/totp/verify` {challengeToken, code} → 通过才发正式会话 cookie
- 备用码：登录时可用备用码替代验证码，用后即焚
- 关闭流程：`POST /api/auth/totp/disable` {code}（需当前有效验证码）

**验收**：验证码 30 秒窗口滚动有效；备用码一次性；关闭后登录恢复单因子；全部动作入操作日志。

### 2.2 第 4 轮：Office 在线查看与编辑（OnlyOffice 可选集成）

**决策记录**：纯前端只读渲染（SheetJS/docx-preview）性价比不足；编辑能力采用 **OnlyOffice Document Server 可选集成**，
默认部署不启用，不破坏零依赖主架构。

**架构（Nextcloud 模式）**

```
[Caddy/反代 443] ──┬── cloudirve（主应用）
                   └── /onlyoffice/* ── onlyoffice/documentserver 容器（JWT 强制开启）
                                         └── 内网直连主应用：拉取文件 / 回调保存
```

- 调研结论：DS 容器**自带全部编辑器 SDK 与字体**（本地提供，不走外网 CDN）；外网首次打开慢的根因是
  家庭上行带宽 × SDK+字体体积，对策是官方 **Preload 预热**（文件列表页后台隐藏 iframe 预灌缓存）
  + 中文字体挂载精简 + 反代静态资源长缓存
- M1（跑通）：compose 增加 DS 服务（`JWT_ENABLED=true` + 共享密钥）、环境变量 `OFFICE_ENABLED=1` 开关；
  后端三个端点：签发编辑配置（JWT HS256，`crypto` 手写）、供 DS 下载文件的内部路由、接收保存回调（status=2 落盘）
- M2（提速）：preload 预热、字体挂载（`/usr/share/fonts` + `documentserver-generate-allfonts.sh`）、缓存头
- M3（分享联动）：分享链接对 docx/xlsx/pptx 走 DS 只读模式
- **风险**：DS 官方建议 6–8GB 内存，NAS 4GB 紧张（空载 ~1.5GB）；容器加 `mem_limit`，禁用拼写检查等非核心服务；
  实测不达标则降级为"仅查看"或外移 DS 到其他设备

**验收**：docx/xlsx/pptx 点击可在线编辑，保存后主应用文件更新；未启用 `OFFICE_ENABLED` 时按钮不出现；全程 JWT 校验。

### 2.3 第 5 轮：PWA / 手机桌面图标

- `manifest.json`（名称/主题色 `#2563EB`/图标 192+512）+ Service Worker 离线壳（仅缓存静态资源，不缓存数据接口）
- 图标 PNG 用图像生成工具产出；iOS `apple-touch-icon` 兼容
- 放最后：纯锦上添花，iOS 对 SW 特性支持有差异

### 2.4 储备池（未排期，按需启动）

- 视频/音频在线播放（`<video>`/`<audio>` + 下载接口补 `Range` 支持）——低成本，媒体文件多时优先
- zip 批量下载（零依赖 store-only zip：CRC32 + 本地文件头拼装，约 150 行）
- 大文件分片上传/断点续传（当前 25MB 上限够用则不启动）
- 操作日志导出、登录通知等审计增强

---

## 3. 关键决策记录（ADR 摘要）

| 决策 | 结论 | 原因 |
|------|------|------|
| 开放注册 | ❌ 不做，管理员手动创建 | 家庭场景防公网滥用 |
| Office 编辑 | OnlyOffice 可选集成（`OFFICE_ENABLED` 开关） | 完整编辑体验优先，且可随时关闭省内存 |
| TOTP 二维码 | 后端不生成，提供 otpauth 链接 | 避免引入 QR 依赖；验证器均支持手动/链接录入 |
| 会话策略 | 落盘持久化 + 30 天过期 | 重启不掉线；过期时间可配（`SESSION_TTL_DAYS`） |
| 日志保留 | 滚动 500 条（`ACTIVITY_LOG_LIMIT`） | 防止 metadata.json 无限膨胀 |
| 零依赖原则 | 后端保持零 npm 依赖；前端仅允许 CDN 渲染类库 | 单文件部署是核心卖点；OnlyOffice 以独立容器形式例外 |
