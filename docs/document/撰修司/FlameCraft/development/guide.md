---
title: "FlameCraft 开发指南"
date: 2026-09-20
description: "FlameCraft 是 Go 单体后端 + React/pnpm 前端的 profile 分析平台。前端构建产物通过 go:embed 嵌入 bin/flam"
categories:
  - 撰修司
tags:
  - FlameCraft
---

# FlameCraft 开发指南

FlameCraft 是 Go 单体后端 + React/pnpm 前端的 profile 分析平台。前端构建产物通过 `go:embed` 嵌入 `bin/flamecraft`；本地按“编译后启动”工作，镜像由 GitLab CI 发布。

## 环境要求

- Go `>= 1.24`（见 `go.mod`）。
- Node.js `>= 18`、Corepack/pnpm `10.15.0`。
- 访问 DrFile/Driver Factory 等完整功能需要公司内网和相应凭据。
- 私有依赖需要 `GOPRIVATE=gopkg.srv.deeproute.cn,code.deeproute.ai` 以及 Git 凭据。

## 配置边界

运行配置不是单一文件：

| 配置 | 用途 |
|-|-|
| `parca.yaml` | `--config-path` 默认配置；当前用于 object storage、scrape/file-reader，并会校验/热加载。容器使用 `/config/parca.yaml`。 |
| `.env` | 本地环境变量集合；不入库，由 `start.sh` 加载未导出的变量。 |
| 环境变量/命令行 | HTTP、存储、日志、IAM、DrFile 等运行参数；命令行覆盖同名 flag。 |

不要再引用已删除的 `flamecraft.yaml`、`local-start.sh` 或 `FLAMECRAFT_CONFIG_PATH`。`FLAMECRAFT_STORAGE_PATH` 等运行参数仍由 Kong 的 env tag 读取，但这不替代 `parca.yaml`。

## 编译和启动

```bash
# 前端构建 + 后端构建，生成 bin/flamecraft
make build

# 拆分执行
make ui/build
make go/bin

# 读取 .env，默认监听 :7070；默认 --config-path=parca.yaml
./start.sh

# 命令行参数覆盖环境变量/默认值
./start.sh --http-address=:8080
curl -s http://localhost:7070/healthz
```

前端热开发：

```bash
cd ui/packages/app/web
pnpm install
pnpm dev                         # Vite :3000
```

Vite 的 `/api/trace` 代理目标是 `http://localhost:7071`，因此热开发 Trace Viewer 时另起 `./start.sh --http-address=:7071`；编译后直接访问后端 `:7070`。

真实 prod IAM + HTTPS 域名的本地验证见 本地生产形态复现。前端修改后必须重新 `build`，否则旧产物会被嵌入二进制。

## 测试和检查

```bash
make test
make go/test
make ui/test
make lint
make format

# 与身份传播相关的回归
go test ./pkg/authctx/... ./pkg/iamauth/... ./pkg/drfile/... ./pkg/foldedresolver/... -race

# 真实内网测试必须显式开启；令牌只使用临时环境变量
FLAMECRAFT_INTEGRATION_TESTS=1 \
  go test ./pkg/drfile/ -run EndToEnd -v
```

完整测试会默认跳过需要内网/真实令牌的集成测试。`FLAMECRAFT_TEST_USER_TOKEN` 只用于显式的真实用户身份测试。

## DrFile SDK fork

`vendor-deps/drfile-sdk-go-v2` 是提交进仓库的 fork，不是子模块；`go.mod` 通过 `replace` 指向它。它为 FlameCraft 使用的 SDK 方法补充 `context.Context`，使每个请求能携带当前用户身份，并包含 token 脱敏和请求级重试 header 修复。

- fork 补丁说明：vendor-deps/drfile-sdk-go-v2/FORK.md。
- 契约测试：`pkg/drfile/sdk_contract_test.go`。
- 更新 fork 后运行 `go test ./pkg/drfile/... -race`，确认 context 方法签名没有回退。

身份传播规则见 <cite doc-id="WVotdBqE9o2G9MxcCNPcdZEcnsb" file-type="docx" title="出站用户身份" type="doc"></cite>，不要使用 SDK 的 client-level token 注入。

## CI 和镜像发布

本地不承担 Docker/Compose 编排。`.gitlab-ci.yml` 的链路是：

```text
build:frontend → build:backend（编译 + 测试 + 生成 dist/flamecraft）
              → tag 触发 docker:release
              → Dockerfile.release 打包并推送镜像
```

运行侧向容器注入环境变量；`Dockerfile.release` 只打包 CI 生成的二进制和 `parca.yaml`，`entrypoint.sh` 提供缺省运行参数。

## 常用路径

| 路径 | 作用 |
|-|-|
| `cmd/flamecraft/main.go` | 进程入口 |
| `pkg/flamecraft/parca.go` | 组合根、存储和服务初始化 |
| `pkg/server/server.go` | HTTP/gRPC/REST 路由和静态 UI |
| `pkg/iamauth` | IAM 登录和 session |
| `pkg/foldedresolver` | Trip 分析、符号化和异步 job |
| `pkg/query`、`pkg/parcacol` | FrostDB 查询和报告生成 |
| `pkg/traceviewer` | Trace Viewer 后端 |
| `ui/packages/app/web` | React 应用 |
