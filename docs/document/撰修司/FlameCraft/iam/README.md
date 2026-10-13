---
title: "IAM、SSO 与出站身份"
date: 2026-09-20
description: "当前实现把“访问 FlameCraft”和“FlameCraft 访问外部平台”拆成两层："
categories:
  - 撰修司
tags:
  - FlameCraft
  - SSO
---

# IAM、SSO 与出站身份

当前实现把“访问 FlameCraft”和“FlameCraft 访问外部平台”拆成两层：

1. `pkg/iamauth` 用 OAuth 授权码流程建立 FlameCraft 的服务端内存 session。
2. `pkg/authctx` 把当前用户 Principal 放入 request context，`pkg/drfile` 用用户 IAM token 访问 DrFile/Artifacts/Pipeline 相关服务。

## 当前文档

- SSO 与令牌模型：登录流程、cookie、session、audience 和跨平台边界。
- <cite doc-id="WVotdBqE9o2G9MxcCNPcdZEcnsb" file-type="docx" title="出站用户身份" type="doc"></cite>
- 本地生产形态复现：域名拦截、TLS、脚本化复测。
- prod IAM 端到端验证：2026-09-16 的实测证据。
- SSO audience 调查（历史）：2026-09-14 的阶段性结论，已由后续 prod 同环境验证补充。

## 关键不变量

- `FLAMECRAFT_AUTH_ENABLED=true` 时，无登录用户不会借用 `DR_ACCESS_TOKEN` 或任何 SDK 凭据；出站请求直接因 `drfile.ErrNoUserIdentity` 失败。
- `FLAMECRAFT_AUTH_ENABLED=false` 仅用于本地开发，可从 `DR_ACCESS_TOKEN` 安装进程级身份。
- 用户 token 只保存在服务端内存 session，不放进 session cookie；多副本部署若要共享登录，需要先实现共享 session store（当前只有 memory）。
- 不要恢复已删除的 Python MCP Server、`/mcp/*` 代理或服务端备用凭据。
