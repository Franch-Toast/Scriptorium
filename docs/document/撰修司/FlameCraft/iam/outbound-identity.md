---
title: "出站用户身份"
date: 2026-09-20
description: "这是当前实现说明。旧的“服务身份回落”和 FLAMECRAFT_DRFILE_USER_TOKEN_ENABLED 方案已移除。"
categories:
  - 撰修司
tags:
  - FlameCraft
---

# 出站用户身份

> 这是当前实现说明。旧的“服务身份回落”和 `FLAMECRAFT_DRFILE_USER_TOKEN_ENABLED` 方案已移除。

## 1. 当前规则

FlameCraft 不保存服务端用户名密码、服务 DRPAT 或制品库备用令牌。所有 DrFile/Artifacts 出站请求都必须代表一个身份：

| 场景 | 身份来源 | 无身份时 |
|-|-|-|
| IAM 开启、普通浏览器请求 | `pkg/iamauth` 的 session → `authctx.Source` | `drfile.ErrNoUserIdentity` |
| IAM 开启、AI loopback 请求 | 内部 token 认证 + 触发对话用户的 token/cookie 透传 | 同上 |
| IAM 关闭、本地开发 | `.env` 的 `DR_ACCESS_TOKEN` → `authctx.ProcessSource` | `drfile.ErrNoUserIdentity` |
| CLI/显式 Bearer 请求 | request context 中的显式 token | 请求失败 |

生产环境即使设置了 `DR_ACCESS_TOKEN` 也会被忽略并告警。这样无权限用户不会借用进程身份读取外部数据。

## 2. 请求传播

```text
HTTP request
  → iamauth middleware
  → authctx.Source in context
  → drfile.Client.userAuthCtx
  → drconst.CtxAccessToken
  → forked DrFile SDK request-level Authorization header
```

`pkg/drfile` 不依赖 `pkg/iamauth`，只依赖零外部依赖的 `pkg/authctx`。SDK fork 位于 `vendor-deps/drfile-sdk-go-v2`，通过 `go.mod replace` 引入，并给 FlameCraft 使用的方法增加 context 入口。

不要使用 SDK 的 client-level `InjectAccessToken`/`InjectContext`：Client 是进程级共享单例，client 级注入会在并发请求之间串用用户 token。

## 3. 配置

`pkg/drfile.LoadFromEnv` 当前只读取 endpoint：

```text
DRFILE_ENDPOINT             # DrFile/file-galaxy API endpoint
DRFILE_PIPELINE_ENDPOINT    # Pipeline high-level API endpoint
DR_ACCESS_TOKEN              # 仅 AUTH=false 本地开发
DRIVER_FACTORY_URL           # Driver Factory 代理 endpoint
```

以下旧变量不会再成为出站身份来源：`DRFILE_USERNAME`、`DRFILE_PASSWORD`、`DRFILE_API_TOKEN`、`DRFILE_ARTIFACTS_TOKEN`、`DRFILE_ARTIFACTS_AUTH_*` 以及 `FLAMECRAFT_DRFILE_USER_TOKEN_ENABLED`。

## 4. 后台任务和 AI

Trip 分析等后台 job 必须在入队时捕获调用方身份，并在 goroutine 内用该身份重建 context；不能依赖请求 handler 返回后的 `context.Context` 生命周期。

AI 工具调用本机 API 时，loopback transport 只对 loopback host 注入 `X-Flamecraft-Internal-Token`，并透传 `X-Flamecraft-User-Token`/`X-Flamecraft-User-Cookie`。外部地址不会获得这些内部 header。

## 5. 验证

```bash
go test ./pkg/authctx/... ./pkg/iamauth/... ./pkg/drfile/... ./pkg/foldedresolver/... -race
```

真实内网测试必须显式设置 `FLAMECRAFT_INTEGRATION_TESTS=1`，并使用临时的 `FLAMECRAFT_TEST_USER_TOKEN`；令牌不应写入文档、日志或仓库。
