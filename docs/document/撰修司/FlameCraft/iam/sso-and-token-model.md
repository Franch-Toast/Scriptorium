---
title: "SSO 与令牌模型"
date: 2026-09-20
description: "SSO 解决的是用户免重复登录和 FlameCraft 的 Web 会话建立，不等于一个 token 可以访问所有 DR 平台资源。资源服务仍可按环境、audi"
categories:
  - 撰修司
tags:
  - FlameCraft
  - SSO
---

# SSO 与令牌模型

## 1. 认证解决什么问题

SSO 解决的是用户免重复登录和 FlameCraft 的 Web 会话建立，不等于一个 token 可以访问所有 DR 平台资源。资源服务仍可按环境、audience、scope 和用户权限独立校验令牌。

| 概念 | 在 FlameCraft 中的作用 |
|-|-|
| IAM/Drauth | 用户登录、授权码和令牌签发 |
| OAuth client | FlameCraft 注册的 `client_id`/`client_secret` |
| session cookie | 只携带服务端内存 session 的 sid，不直接携带 access token |
| access token | 服务端访问 IAM/DR 资源的短期凭证，保存在内存 session |
| DRPAT | CLI 或本地开发可使用的不透明 Bearer token；不是 Web SSO cookie |
| audience (`aud`) | 资源服务判断 token 是否面向自己的重要声明之一 |

## 2. FlameCraft 登录流程

```text
浏览器
  │ GET /auth/login
  ▼
FlameCraft 设置 state cookie，302 到 Drauth authorize
  ▼
用户在 IAM 完成登录/授权
  ▼
GET /auth/callback?code=...&state=...
  │ FlameCraft 用 client secret 换 access/refresh token
  ▼
MemoryStore 保存 token，签发带 sid 的 session cookie
  ▼
后续请求由 middleware 解析 session，并把 authctx.Source 放进 context
```

`/auth/status` 始终公开，SPA 用它决定是否跳转；`/auth/me` 返回当前用户；`/auth/logout` 删除服务端 session。令牌刷新由 `MemoryStore` 在过期前完成，并用 single-flight 避免并发刷新互相覆盖。

## 3. Cookie 和多平台 SSO 边界

根域 cookie 让 IAM 知道用户已经登录，应用仍需使用自己的 OAuth client 完成授权码流程。资源服务 API 通常校验 `Authorization: Bearer <access_token>`，不能假设它会读取浏览器 cookie。

因此要区分：

- “用户访问 FlameCraft 时不用再次输入密码”；
- “FlameCraft 的 access token 被 DrFile/Artifacts 接受”；
- “prod token 访问 stg 资源是否被允许”。

2026-09-16 的 prod 同环境验证记录：prod `flamecraft-oauth` 授权码 token 可访问 prod file-galaxy 和 prod-artifacts-server；同一 token 访问 stg file-galaxy 被拒。这说明环境边界必须写进部署和测试前提，不能仅凭 token 格式判断结果。

## 4. 认证配置

启用认证至少需要：

```text
FLAMECRAFT_AUTH_ENABLED=true
FLAMECRAFT_IAM_BASE_URL=...
FLAMECRAFT_IAM_CLIENT_ID=...
FLAMECRAFT_IAM_CLIENT_SECRET=...
FLAMECRAFT_EXTERNAL_URL=https://...       # 必须和 redirect_uri 对齐
FLAMECRAFT_SESSION_SECRET=<至少 32 字节>
```

可选项包括 `FLAMECRAFT_IAM_TENANT_NAME`、`FLAMECRAFT_SESSION_TTL_HOURS`、`FLAMECRAFT_TOKEN_REFRESH_SKEW_SECONDS` 和 `FLAMECRAFT_SESSION_MAX_SESSIONS`。session store 当前只能是 `memory`。

## 5. 排查顺序

1. 看 `/auth/status` 是否显示 `enabled: true`。
2. 确认 `FLAMECRAFT_EXTERNAL_URL`、浏览器实际访问域名和 IAM 注册的 redirect URI 完全一致。
3. 看 `/auth/login`、IAM authorize、`/auth/callback` 的 HTTP 302 链路和 state cookie。
4. 登录后检查 `/auth/me`，不要把浏览器 cookie 当作下游 API token。
5. 出站失败时分别记录资源环境、token audience、HTTP 状态和上游错误；不要用服务端凭据绕过失败。
