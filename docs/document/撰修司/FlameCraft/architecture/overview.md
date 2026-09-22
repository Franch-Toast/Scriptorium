---
title: "FlameCraft 当前架构"
date: 2026-09-20
description: "依据源码：cmd/flamecraft、pkg/flamecraft、pkg/server、pkg/iamauth、pkg/foldedresolver、pkg"
categories:
  - 撰修司
tags:
  - FlameCraft
---

# FlameCraft 当前架构

> 依据源码：`cmd/flamecraft`、`pkg/flamecraft`、`pkg/server`、`pkg/iamauth`、`pkg/foldedresolver`、`pkg/query`、`pkg/traceviewer`。更新：2026-09-20。

## 1. 运行形态

FlameCraft 是一个单体进程：Go 后端启动 HTTP/2、gRPC、gRPC-Web 和 REST 路由，React 前端构建产物通过 `go:embed` 嵌入同一个二进制。入口是 `cmd/flamecraft/main.go`，组合根在 `pkg/flamecraft/parca.go`。

```text
Browser / gRPC-Web / REST / CLI
              │
              ▼
       pkg/server + pkg/iamauth
       ┌────────┼─────────┬──────────────┐
       │        │         │              │
   Parca API  Trip     DrFile       Trace / AI / DF
   gRPC-Web   分析     代理         REST handlers
       │        │         │              │
       └────────┴─────────┴──────────────┘
                    │
              单进程内存对象
       Badger + FrostDB + 缓存 + 临时 trace 文件
```

可交互版本见 flamecraft-architecture.html，其数据源是同目录的 flamecraft-architecture.json。图用于导航；新增或删除组件时以本文件和源码为准。

## 2. 组件边界

| 层 | 代码 | 责任 |
|-|-|-|
| 组合根 | `pkg/flamecraft` | 读取 `parca.yaml`、初始化对象存储/Badger/FrostDB、组装服务和后台组件 |
| 协议入口 | `pkg/server` | gRPC、gRPC-Web、REST、静态 UI、健康检查、metrics、pprof 的统一 HTTP 入口 |
| 认证 | `pkg/iamauth` | OAuth 授权码登录、内存 session、cookie、刷新、请求身份注入 |
| 出站身份 | `pkg/authctx`、`pkg/drfile` | 在 request context 传递用户 Principal，并以用户 IAM token 访问 DR 平台 |
| Trip/符号化 | `pkg/foldedresolver`、`pkg/binsymbolizer`、`pkg/filereader` | Driver/文件获取、Folded/Off-CPU 解析、符号化、写入 profile store |
| 写入 | `pkg/ingester`、`pkg/profilestore` | 将 pprof/Arrow 数据写入 FrostDB 的 `flamecraft.stacktraces` |
| 查询 | `pkg/query`、`pkg/parcacol` | Label/Values、QueryRange、Query/QueryMerge、火焰图/Top/Callgraph 报告和缓存 |
| 专题 | `pkg/traceviewer`、`pkg/aiagent`、`pkg/driverfactory` | Trace 分析、AI SSE、Driver Factory 代理 |

## 3. HTTP 路由面

以下路由由 `pkg/server/server.go` 统一挂载；路径前缀由 `--path-prefix` 控制。

| 路径 | 来源 | 说明 |
|-|-|-|
| `/auth/*` | `pkg/iamauth` | status、login、callback、logout、me；`/auth/status` 始终公开 |
| `/api/*` | Parca protobuf + `pkg/server` | gRPC-Web/REST 网关、profile 查询、profile store、scrape、telemetry 等 |
| `/api/trip/*` | `pkg/foldedresolver` | Trip 分析、批量分析、重分析、已入库列表、驾驶模式 |
| `/api/symbolizer/*` | `pkg/foldedresolver` | 上传/按 Trip 符号化、任务、结果、Driver 缓存 |
| `/api/drfile/*` | `pkg/drfile` | DR File、Pipeline、Artifacts 相关代理 |
| `/api/df/*` | `pkg/driverfactory` | 项目、里程碑、release 和 Driver 信息代理 |
| `/api/trace/*` | `pkg/traceviewer` | Trace 上传和时间线/唤醒/IRQ 查询 |
| `/api/ai/*` | `pkg/aiagent` | chat/summary/suggest/config；chat 使用 SSE |
| `/metrics`、`/healthz`、`/debug/pprof/*` | `pkg/server` | 运维和性能诊断接口 |

启用 IAM 后，认证中间件包住 REST 和 gRPC-Web 协议分发；静态 UI 可加载，SPA 根据 `/auth/status` 决定是否跳转登录。

## 4. 两条主要数据链路

### 4.1 Trip 分析写入

```text
POST /api/trip/analyze
  → foldedresolver 创建后台 job
  → DrFile/Pipeline 获取 Trip 元数据和 Driver
  → 下载并解压 profile/folded 文件
  → filereader 解析 CPU、Off-CPU 等格式
  → binsymbolizer / foldedresolver 解析和符号化
  → ingester 写入 FrostDB stacktraces
  → 失效并预热查询缓存
```

`/api/trip/ingested`、批量分析的 `skipExisting` 和分析流水线的已入库早退都使用进程内的 `LabelValues` 查询，不回环调用本机 HTTP。查询失败时按“未入库”处理，避免误跳过分析。

重分析通过同一条流水线携带 `Force`，在流水线内部执行数据清理；不会由 handler 直接删除存储目录。

### 4.2 查询和前端展示

```text
gRPC-Web / REST
  → pkg/query 或 pkg/parcacol
  → FrostDB stacktraces
  → 符号/堆栈解析 + Arrow/pprof 报告
  → React 火焰图、时间序列、Top、Callgraph
```

`QueryRange` 对长时间范围可路由到分钟级聚合数据；查询缓存按 Trip 失效，分析完成后可预热。FrostDB 默认内存运行，`--enable-persistence` 和 `--storage-enable-wal` 决定是否启用持久化/WAL。

## 5. Trace Viewer 和 AI 的特殊链路

- Trace Viewer 的后端在同一进程内解析上传文件，session 存于内存；文件暂存于系统临时目录，服务重启后 session 不保留。
- AI handler 的 chat 是 `text/event-stream`。AI 工具需要访问本机 API 时使用 loopback transport；开启 IAM 后由内部 token 认证，同时透传触发对话用户的凭据，出站请求仍按该用户身份执行。
- 已删除 Python MCP Server、`/mcp/*` 反向代理和独立 MCP 容器；不要在新文档或部署配置中重新引入它们。

## 6. 配置边界

配置分成三类，不要混写成一个“唯一配置文件”：

1. `parca.yaml`：`--config-path` 默认值，当前用于对象存储、scrape/file-reader 配置，并由 `pkg/config.LoadFile` 校验和热加载；容器中是 `/config/parca.yaml`。
2. 环境变量/命令行：HTTP 地址、持久化、WAL、存储路径、日志、IAM、DrFile endpoint、Driver Factory 等运行时参数。`start.sh` 只负责把 `.env` 中未导出的变量加载进进程。
3. 前端开发代理：Vite 监听 `:3000`；`/api/trace` 代理到 `:7071`，因此需要另起一个监听 `:7071` 的后端。编译后直接访问后端的 `:7070`。

常用启动关系：

```text
make build
  ├─ make ui/build   → ui/packages/app/web/build
  └─ make go/bin     → bin/flamecraft
./start.sh           → 读取 .env，exec bin/flamecraft
```

## 7. 代码变更时的同步点

- 新增 handler：同步 `pkg/server/server.go`、本文件的路由表，以及前端调用位置。
- 修改出站调用：同步 `pkg/authctx`/`pkg/iamauth` 的身份规则和 IAM 文档，不要通过共享 client 级 token 注入绕过 request context。
- 修改存储/配置：同步 `parca.yaml`、`pkg/flamecraft/parca.go` 和 开发指南。
- 修改 Trace Viewer：同步 Trace Viewer 文档 和 `pkg/traceviewer` 的实际路由。
