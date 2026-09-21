# Cloudirve Drive MVP

面向个人用户的私有文件管理器（设计基线见 `docs/design-spec.md`）。

## 功能范围（Iteration 1 + 2）

- 登录 / 退出 / 会话保持（HttpOnly Cookie，scrypt 密码哈希）
- 多级目录、面包屑导航、新建文件夹、重命名（对话框弹窗交互）
- 文件上传（多文件、25MB 上限、同级重名校验）、下载、移入回收站
- 回收站：恢复（原目录不存在时回落根目录）、永久删除（二次确认）
- 桌面端表格列表 / 移动端（≤767px）卡片网格双布局

## 本地运行

```bash
npm start          # http://127.0.0.1:4173
```

默认账号：`demo / cloudirve`（首次启动自动创建，密码以 scrypt 哈希存储）。

## 测试

```bash
npm test           # 接口回归（node --test）+ CDP 浏览器端到端（test/ui.e2e.mjs）
npm run check      # 语法检查
```

浏览器端到端测试自动调用本机 Chrome/Edge（headless CDP），无需安装额外依赖。

## Docker 部署

```bash
docker compose up -d --build    # 构建并启动，映射 4173 端口
```

- 镜像：`node:22-alpine` 单阶段构建（零 npm 依赖，无需构建层），内置 HEALTHCHECK
- 数据持久化：`./data:/app/data`（元数据 `metadata.json` + 文件 `files/`），备份该目录即备份全部用户数据
- 环境变量：`PORT`（默认 4173）、`HOST`（容器内固定 0.0.0.0）

直接用 Docker CLI：

```bash
docker build -t cloudirve-drive:latest .
docker run -d --name cloudirve-drive -p 4173:4173 -v "$PWD/data:/app/data" cloudirve-drive:latest
```

## 安全说明

- 物理存储路径由内部 ID 拼接，用户文件名不落盘，杜绝路径穿越
- 所有文件接口校验登录态与资源归属；错误响应统一 `{ error: { code, message } }`
- 删除默认软删除；永久删除需二次确认
