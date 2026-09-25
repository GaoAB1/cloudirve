# Cloudirve 部署说明

> 适用版本：OnlyOffice 集成（M1）合入后的 `main` 分支。
> 架构：零 npm 依赖 Node 22 后端 + 原生前端，单容器部署；元数据与文件统一落在 `/app/data`。

---

## 1. 系统要求

| 项目 | 要求 |
|------|------|
| CPU | 1 核即可运行主应用；启用 OnlyOffice 建议 2 核以上 |
| 内存 | 主应用 < 100MB；启用 OnlyOffice 额外 1.5–4GB（容器已限 4GB） |
| 磁盘 | 镜像约 200MB；数据盘按文件量预留 |
| 软件 | Docker 24+ / Docker Compose v2（推荐）；源码运行需 Node 22+ |

---

## 2. 方式一：GHCR 镜像部署（推荐，NAS/服务器）

镜像由 GitHub Actions 在每次推送到 `main` 时自动构建并发布：

- `ghcr.io/gaoab1/cloudirve:latest` —— 主分支最新
- `ghcr.io/gaoab1/cloudirve:sha-<短SHA>` —— 每次提交的固定版本，便于回滚

```bash
# 1. 准备数据目录（元数据 + 文件都在这里，备份此目录即备份全部用户数据）
mkdir -p ./data

# 2. 拉取并运行
docker run -d --name cloudirve-drive \
  -p 4173:4173 \
  -v "$PWD/data:/app/data" \
  --restart unless-stopped \
  ghcr.io/gaoab1/cloudirve:latest

# 3. 验证
curl http://127.0.0.1:4173/        # 返回登录页 HTML 即正常
docker logs cloudirve-drive        # 观察 "Cloudirve running at ..." 日志
```

首次启动自动创建默认管理员：`demo / cloudirve`，**部署后请立即登录并修改密码**（设置 → 修改密码），并建议开启两步验证。

### 升级

```bash
docker pull ghcr.io/gaoab1/cloudirve:latest
docker stop cloudirve-drive && docker rm cloudirve-drive
# 重新执行上面的 docker run（数据在 ./data，不受影响）
```

### 回滚到指定版本

```bash
docker run -d --name cloudirve-drive ... ghcr.io/gaoab1/cloudirve:sha-87b3236
```

---

## 3. 方式二：docker compose 本地构建（含可选 OnlyOffice）

克隆仓库后在项目根目录执行。

### 3.1 仅主应用（默认，不启用在线编辑）

```bash
docker compose up -d --build
```

### 3.2 启用 OnlyOffice 在线编辑

```bash
# 1. 生成配置文件
cp .env.example .env

# 2. 编辑 .env，至少填写：
#    OFFICE_ENABLED=1
#    OFFICE_JWT_SECRET=<node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" 生成>
#    OFFICE_PUBLIC_URL=http://<NAS局域网IP>:8080
# 3. 启动（--profile office 会同时拉起 Document Server）
docker compose --profile office up -d --build
```

三个地址变量的取值规则：

| 变量 | 谁在用 | 取值 |
|------|--------|------|
| `OFFICE_URL` | Cloudirve 容器 → Document Server | 保持默认 `http://office`（compose 内部服务名） |
| `OFFICE_PUBLIC_URL` | 浏览器 → Document Server | 浏览器可达地址：局域网 `http://<NAS IP>:8080`；公网反代 `https://office.example.com` |
| `OFFICE_CALLBACK_ORIGIN` | Document Server → Cloudirve | DS 容器可达地址；同一 compose 网络保持默认 `http://cloudirve:4173`；跨机部署改为 DS 可访问的主应用地址 |

JWT 约束：`OFFICE_JWT_SECRET` 会同时注入两端（compose 中 Document Server 的 `JWT_ENABLED` 已绑定 `OFFICE_ENABLED`），两端必须一致，否则编辑器无法加载或保存回调 401。修改 `.env` 后需 `docker compose --profile office up -d` 重建容器生效。

支持的编辑类型：doc/docx/odt/rtf/txt、xls/xlsx/ods/csv、ppt/pptx/odp 等；文件操作菜单出现「在线编辑」按钮即集成成功，保存后操作日志记录「在线编辑保存」。

> **内存提醒**：Document Server 官方建议 6–8GB 内存，compose 已限 `mem_limit: 4g`（空载约 1.5GB）。4GB 内存的 NAS 若吃紧，可将 Document Server 部署到其他设备，并把 `OFFICE_URL`、`OFFICE_CALLBACK_ORIGIN` 改为跨机可达地址。

---

## 4. 方式三：源码直接运行（开发/调试）

```bash
git clone https://github.com/GaoAB1/cloudirve.git
cd cloudirve
npm start               # http://127.0.0.1:4173，默认监听 127.0.0.1
```

常用环境变量：`PORT=4173 HOST=0.0.0.0`；开发验证：

```bash
npm run check           # 语法检查
npm test                # 17 个 API 用例 + 48 项浏览器端到端检查
```

浏览器端到端测试自动调用本机 Chrome/Edge（headless CDP），无需额外依赖。

---

## 5. 环境变量参考

### 主应用

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `4173` | 监听端口 |
| `HOST` | `127.0.0.1`（源码）/ `0.0.0.0`（镜像内固定） | 监听地址 |
| `STORAGE_QUOTA_BYTES` | `1073741824`（1GB） | 每用户存储配额，超限上传返回 413 |
| `TRASH_RETENTION_DAYS` | `30` | 回收站保留期，过期自动物理清理 |
| `SESSION_TTL_DAYS` | `30` | 会话有效期，落盘持久化，重启不掉线 |
| `ACTIVITY_LOG_LIMIT` | `500` | 操作日志滚动上限，防止 metadata.json 膨胀 |
| `OFFICE_ENABLED` | `0` | `1` 启用在线编辑（需同时配置 `OFFICE_JWT_SECRET`） |
| `OFFICE_URL` | `http://office` | 主应用容器访问 DS 的内部地址 |
| `OFFICE_PUBLIC_URL` | 空（回退 `OFFICE_URL`） | 浏览器访问 DS 的地址 |
| `OFFICE_CALLBACK_ORIGIN` | 空（回退请求来源） | DS 访问主应用的回调地址 |
| `OFFICE_JWT_SECRET` | 空 | 两端共享的 JWT 密钥；为空时即使 `OFFICE_ENABLED=1` 也不会启用 |

> compose 部署时以上变量写在 `.env`（已被 `.gitignore` 忽略，不会入库）；模板见 `.env.example`。

### Document Server 容器（compose 自动注入，无需手动设置）

`JWT_ENABLED`（绑定 `OFFICE_ENABLED`）、`JWT_SECRET`（绑定 `OFFICE_JWT_SECRET`）、`JWT_HEADER=Authorization`，端口映射 `8080:80`。

---

## 6. 反向代理与 HTTPS（公网部署）

单容器模式（无 OnlyOffice）：

```nginx
server {
    listen 443 ssl;
    server_name drive.example.com;
    # ssl_certificate ...; ssl_certificate_key ...;

    client_max_body_size 26m;          # 与 25MB 上传上限匹配
    location / {
        proxy_pass http://127.0.0.1:4173;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;   # OnlyOffice 回调地址生成依赖此头
        proxy_set_header X-Forwarded-Host  $host;
    }
}
```

启用 OnlyOffice 时建议 DS 也走反代（如 `https://office.example.com` → `127.0.0.1:8080`），并把 `OFFICE_PUBLIC_URL` 指向该域名；DS 自带全部编辑器 SDK 与字体，静态资源不走外网 CDN。

---

## 7. 数据备份与恢复

**全部用户数据只有一份：`./data/` 目录。**

```bash
# 备份（建议停机或低峰执行，避免 metadata.json 写入中拷贝）
docker stop cloudirve-drive
tar czf cloudirve-backup-$(date +%F).tar.gz data/
docker start cloudirve-drive

# 恢复：解压到新的 data/ 目录后启动容器即可
```

`data/` 内容：`metadata.json`（用户、会话、分享、操作日志）+ `files/<userId>/<fileId>`（文件内容，文件名不落盘，杜绝路径穿越）。

---

## 8. 安全清单（公网部署前逐项确认）

1. ✅ 修改默认 `demo` 账户密码，或删除后重建管理员
2. ✅ 开启 TOTP 两步验证（设置页，支持验证器 App + 一次性备用码）
3. ✅ `.env` 不入库（已 gitignore）；`OFFICE_JWT_SECRET` 用 32 字节随机值
4. ✅ 全站 HTTPS；分享链接含密码与有效期时同样建议走 HTTPS
5. ✅ 不要把 4173/8080 直接暴露公网，走反代并限制来源
6. ✅ 定期备份 `data/`；操作日志可在设置页审计异常登录

---

## 9. 故障排查

| 现象 | 排查 |
|------|------|
| 容器反复重启 | `docker logs cloudirve-drive`；检查 `data/` 目录权限与磁盘空间 |
| 在线编辑按钮不出现 | 确认 `OFFICE_ENABLED=1` 且 `OFFICE_JWT_SECRET` 非空；重启主应用容器 |
| 编辑器打开后空白/加载失败 | 浏览器能否直接访问 `OFFICE_PUBLIC_URL`；DS 是否启动完成（首次约 1–2 分钟），`docker logs cloudirve-office` |
| 编辑保存不生效 | 检查 `OFFICE_CALLBACK_ORIGIN` 是否为 DS 容器可达地址；两端 JWT 密钥是否一致；回调日志是否 401/400 |
| 上传 413 | 反代 `client_max_body_size` 小于 25MB；或触发每用户配额（`STORAGE_QUOTA_BYTES`） |
| 登录提示验证已过期 | TOTP 登录挑战 5 分钟有效，过期重新输入密码即可 |
| 忘记密码 | 管理员可在用户管理重置；管理员本人遗忘需从 `data/metadata.json` 恢复备份或重置密码哈希 |

---

## 10. CI/CD 与镜像发布

- **CI**（`.github/workflows/ci.yml`）：推送到 `main` 或 PR 时执行语法检查 + API 测试 + 浏览器端到端测试，并上传 UI 截图产物。
- **Docker Image**（`.github/workflows/docker-image.yml`）：推送到 `main` 或打 `v*` 标签时构建镜像并推送 GHCR（`latest` + commit SHA 标签），启用 GHA 构建缓存。
- 手动触发：Actions 页面 `workflow_dispatch`。
