---
title: "FlameCraft 项目根目录清理记录"
date: 2026-09-20
description: "这是 2026-09-15/16 的历史记录，不是当前目录的自动清单；当前开发入口见 开发指南。"
categories:
  - 撰修司
tags:
  - FlameCraft
---

# FlameCraft 项目根目录清理记录

> 这是 2026-09-15/16 的历史记录，不是当前目录的自动清单；当前开发入口见 开发指南。
> 
> - 上一轮清理：2026-09-15
> - 本轮清理：2026-09-16（本地不再容器化，CI 单路径发布）

## 当前启动方式（结论基准）

FlameCraft 采用「**本地编译启动 + CI 单路径发布**」：

| 场景 | 链路 |
|-|-|
| 本地开发 | `make build`（前端 pnpm + 后端 go）→ `./start.sh`（读 `.env` 注入 → exec `bin/flamecraft`） |
| 镜像发布 | GitLab CI：`build:frontend` → `build:backend`（编译+测试，产出 `dist/flamecraft`）→ 打 tag 时 `Dockerfile.release` 打包并 push registry |
| 运行侧 | k8s 等直接注入 `FLAMECRAFT_*` / `DRFILE_*` 环境变量；仓库不再提供任何 docker-compose 编排 |

- 本地**不做任何 Docker 打包 / compose 编排**。
- 运行参数主要来自环境变量，`parca.yaml` 仍是 `--config-path` 的默认对象存储/采集配置；`flamecraft.yaml` / `local-start.sh` 已废弃。
- 私有依赖 DrFile SDK 以 `vendor-deps/` 普通提交文件方式引入（非子模块），CI 无跨项目 token 问题。

## 历史清理

**2026-09-15**（上轮）：`Dockerfile`、`Dockerfile.dev`、`Dockerfile.go.dev`、`Dockerfile.deploy`、  
`docker-test.sh`、`build-and-export.sh`、`docker-build.sh`、`Tiltfile`、`vercel.json`、  
`playwright.config.ts`、`parca-file-reader-example.yaml`，及运行时产物 `flamecraft`、`bin/`、  
`data/`、`drivers/`、`tmp-storage/`、`bsp-libs/`。

**2026-09-16**（本轮，配合「本地不容器化 + CI 单路径」）：`Dockerfile.prod`、`docker-compose.yml`、  
`docker-compose.deploy.yml`、`deploy-on-server.sh`、`screenshot.png`、`otel-buf.gen.yaml`、  
根 `package.json`、`pnpm-lock.yaml`、`env-local-test.sh`、`env-jsonnet.sh`、  
`scripts/docker-push-registry.sh`（唯一引用 `Dockerfile.prod`，连带失效）。

## 当前剩余条目结论

### 编译 / 发布关键件

| 条目 | 用途 | 结论 |
|-|-|-|
| `Dockerfile.release` | CI 发布镜像（仅打包 CI 预编译产物 + entrypoint）——仓库唯一 Dockerfile | **保留**（CI 用） |
| `entrypoint.sh` | 容器入口（默认 env 兜底） | **保留**（`Dockerfile.release` COPY） |
| `parca.yaml` | 对象存储/gRPC 配置，容器固定挂 `/config/parca.yaml` | **保留**（`Dockerfile.release` COPY） |
| `.dockerignore` | CI 构建上下文控制 | **保留**（已清理残留忽略行） |

### 本地开发 / 运行

| 条目 | 用途 | 结论 |
|-|-|-|
| `start.sh` | 加载 `.env` → exec `bin/flamecraft` | **保留** |
| `.env`（未入库，gitignore） | 本地环境变量入口（不替代 `parca.yaml`） | **保留** |
| `Makefile` | 编译/测试入口（`build`/`ui/build`/`go/bin`/`test`/`lint`/`format`/`proto/*`） | **保留**（保留现状；内含失效 target 见下「已知遗留」） |
| `env.sh` | 安装 embedmd/gofumpt/golangci-lint/govulncheck，并调 `env-proto.sh` | **保留**（本地工具） |
| `env-proto.sh` | 安装 buf | **保留**（被 `env.sh` 调用） |

### 构建 / 生成

| 条目 | 用途 | 结论 |
|-|-|-|
| `go.mod` / `go.sum` | Go 依赖（`replace ... => ./vendor-deps/drfile-sdk-go-v2`） | **保留** |
| `vendor-deps/` | DrFile SDK fork 补丁（提交文件） | **保留**（CI 关键依赖） |
| `buf.gen.yaml` | proto 生成插件配置（`make proto/generate` / pre-commit） | **保留** |
| `buf.work.yaml` | buf workspace（声明 `proto` 模块） | **保留**——根目录无 `buf.yaml`，从根跑 `buf` 依赖它 |
| `cmd/pkg/ui/proto/gen/` | 前后端源码与生成产物 | **保留** |

### 文档 / 工具 / 配置

| 条目 | 用途 | 结论 |
|-|-|-|
| `docs/` | 设计、开发、IAM、性能报告 | **保留** |
| `scripts/` | 火焰图分析、IAM 验证、license 等 | **保留**（`check-license.sh` 被 pre-commit 引用；内含 `install-minikube.sh`/`local-dev.sh` 等可选清理项，非根文件） |
| `tools/` | QNX 符号化/提取工具 | **保留** |
| `tests/` | E2E（lightpanda，python 驱动） | **保留** |
| `agent-harness/` | 历史/实验性的 flamectl Agent 说明 | **单独评估**（当前仓库无 `pkg/flamectl` 实现） |
| `.gitlab-ci.yml` | CI 编译/测试/打包/上传 | **保留** |
| `.golangci.yml.pre-commit-config.yaml.prettierrc.prettierignore.editorconfig.gitattributes.gitignoreLICENSE` | 检查 / 格式 / 许可证 | **保留** |
| `.claude/` | 本机 Claude 会话配置（未入库） | 本地保留，不提交 |

## 保留清单（当前全部）

```
Dockerfile.release  .dockerignore  entrypoint.sh  parca.yaml  .env(未入库)  LICENSE
Makefile  start.sh  env.sh  env-proto.sh
go.mod  go.sum  buf.gen.yaml  buf.work.yaml
.gitlab-ci.yml  .golangci.yml  .pre-commit-config.yaml  .prettierrc  .prettierignore
.editorconfig  .gitattributes  .gitignore
cmd/  pkg/  ui/  proto/  gen/  vendor-deps/  docs/  scripts/  tools/  tests/  agent-harness/
```

## 已知遗留（不影响当前用法，如需可后续清理）

- **`Makefile`**（用户选择保留现状）：仍含失效 target——`container-dev`（引已删默认 Dockerfile）、  
`container`/`push-*`/`sign-*`（podman/cosign）、`deploy/manifests`、`dev/up`/`dev/down` /  
`dev/setup`（引已删 `env-local-test.sh`/`env-jsonnet.sh`，运行会报缺文件）、`README.md`（embedmd）、  
`release-*`（goreleaser，无配置文件）。
- **文档重组**：旧 `DESIGN_AND_DEV_GUIDE.md` 已删除，现状说明改由 `docs/architecture/overview.md` 和 `docs/development/guide.md` 维护。
- **`mcp-server/` 已整目录删除**（`server.py`、`flamegraph_svg.py`、`Dockerfile`、`README.md`、  
`USER_GUIDE.md`、`requirements.txt`），连带清理 `entrypoint.sh` 的 `ENABLE_MCP` 启动块、  
`Dockerfile.release` 的 python3/mcp 依赖与 `/opt/mcp-server`、`pkg/server` 的 `/mcp/*` 反向代理、  
`.env` 的 `MCP_PORT`。AI 助手改为进程内回环自调用并以登录用户身份出站（见 `docs/architecture/overview.md`）。
- **`.dockerignore`**：残留对已删 Dockerfile 与 `screenshot.png` 的忽略行（无害，可顺手清理）。
