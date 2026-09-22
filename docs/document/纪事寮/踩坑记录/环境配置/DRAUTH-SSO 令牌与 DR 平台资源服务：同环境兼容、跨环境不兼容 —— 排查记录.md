---
title: "DRAUTH-SSO 令牌与 DR 平台资源服务：同环境兼容、跨环境不兼容 —— 排查记录"
date: 2026-09-20
description: "在自己的环境内完全可用（stg 令牌 → stg file-galaxy = 200，introspect active:true）。"
categories:
  - 纪事寮
tags:
  - SSO
  - DRAUTH
---

# DRAUTH-SSO 令牌与 DR 平台资源服务：同环境兼容、跨环境不兼容 —— 排查记录

> 归档：`03_Experience 经验库/踩坑记录/环境配置`  
> 日期：2026-09-11 \~ 09-14
> 
> **结论（2026-09-14 修正）**：SSO 授权码流程签发的 `access_token` / `id_token`  
> **在自己的环境内完全可用**（stg 令牌 → stg file-galaxy = 200，introspect `active:true`）。  
> 此前得出的"`aud=flamecraft-oauth` 不兼容"是**跨环境测试的假象**——当时拿 **stg 签发的令牌**  
> 去打 **prod 资源服务**，prod 不信任 stg 令牌，因而 401 / `active:false`。  
> **真正的约束是"环境必须一致"：IAM 签发环境 == 资源服务环境。** 与 official 文档理解一致。

---

## 一、背景

FlameCraft（内部 profile 分析平台）已完成 IAM SSO 登录接入。后续做「出站身份改造」：  
让后端访问 DR 平台时，**使用当前登录用户的 IAM 身份**（而不是开发/服务账号），  
从而做到「能否访问全凭用户自身权限」+ 审计可追溯到人。

方案设计阶段，把「SSO 令牌能否被 DR 平台资源服务接受」列为**阻断级风险（R1）**。

## 二、前因后果（时间线）

1. **改造完成**：DrFile SDK 迁到 v2.1.1（fork 补 ctx 形参）+ 用户令牌经 session store  
与 ctx 透传；`/mount` 出站统一走 `userTokenCtx`。本地 E2E 用 DRPAT 当"用户令牌"跑通。
2. **本地现场失败**：浏览器 SSO 登录后，DrFile 调用一直 401 `Token is invalid`  
（4 次重试全失败；还暴露了 SDK 401 重试不更新鉴权头的缺陷，已修复）。
3. **初步定位到 audience**：`cmd/tokencheck` 解码发现 SSO 令牌 `aud=flamecraft-oauth`  
（客户端自身），而密码登录令牌 `aud=deeproute-ldap` —— 当时误判为根因。
4. **多路径复测（全部跨环境）**：原生 SDK + `WithApiToken`、原始 HTTP、fork SDK  
三条路都 401，线路指纹证明令牌**原样转发**。
5. **审阅官方文档**：文档只覆盖「令牌用于调用应用自身后端，经 `/oauth/introspect` 校验」。
6. **2026-09-14 关键转折**：用户追问"是不是 stg 令牌打到 prod？drfile 都在 prod"。  
**同环境对照**显示：stg 令牌 → stg file-galaxy = **200**；stg 令牌 → prod file-galaxy = **401**。  
→ 推翻第 3 步的结论。

## 三、真正的根因：环境一致性，不是 aud

资源服务信任的是**同一环境**的 IAM 签名/令牌。跨环境（stg 令牌 → prod 资源服务）时，  
prod 不认 stg 签发的令牌，表现为"像没有鉴权一样"拒绝。

### 同环境 vs 跨环境 实测

| stg SSO access_token → | 结果 |
|-|-|
| `https://stg-drplatform-backend.deeproute.cn/file-galaxy/...`（**同环境**） | **200**`total=1542245` |
| `https://drplatform-backend.deeproute.cn/file-galaxy/...`（**跨环境** → prod） | **401**`Token is invalid` |

### introspect（关键对照）

| 场景 | `POST /drauth/oauth/introspect` | 结果 |
|-|-|-|
| **stg drauth**，带 `clientId=flamecraft-oauth` + `clientSecret` | stg access_token | **`active:true, userId, username, clientId=flamecraft-oauth`** |
| stg drauth，无 client 凭据 | stg access_token | `{}`（需 client_id） |
| **prod drauth**，无凭据（**跨环境**，之前测的） | stg access_token | `active:false`（假象） |

**结论：令牌本身有效、同环境可用；`aud=flamecraft-oauth` 并不构成同环境内的障碍。**

### 3.x 一个 SSO 令牌访问所有 stg 平台（2026-09-14 实测）

依据 `FlameCraft 外部内部平台访问与 IAM 鉴权分析.md` 的平台清单，  
把 prod 域名换成 stg 域名后，用**同一个 stg SSO access_token** 逐项实测：

| stg 平台 | 端点（prod→stg） | 带 SSO 令牌 | 不带令牌 |
|-|-|-|-|
| DrFile / file-galaxy | `stg-drplatform-backend.deeproute.cn/file-galaxy/...` | **200** | **401** |
| DR Platform Pipeline | `stg-drplatform-backend.deeproute.cn/dr-pipeline/trip/query/highLevel` | **200** | 200（该端点本就不鉴权） |
| Artifacts 制品库 | `stg-artifacts-server.srv.deeproute.cn/api/v1/packages/drivers` | **200** | **401** |
| Driver Factory | `stg-driver-factory.srv.deeproute.cn` | **200** | 200（本就匿名开放） |
| ADAS FARM | 仅用于服务身份登录（`adas-farm.srv.deeproute.cn`，stg/prod 共用） | — | 401 缺账密 |

结论：**同环境（stg）内，一个 SSO 令牌可以访问所有 DR 平台服务**；  
两个强鉴权平台（file-galaxy、artifacts）都接受它（对比：无令牌均 401）。  
Driver Factory / Pipeline 本就匿名。S3 端点 stg/prod 共用且匿名。

### 各令牌在同环境 file-galaxy（stg）的行为参考

| 令牌 | 同环境 file-galaxy |
|-|-|
| stg SSO access_token | **200** |
| DRPAT | 200 |
| 密码登录令牌 | 200 |
| 不带鉴权 | 401 |

## 四、测试方法（可复现）

### 4.1 环境准备

- FlameCraft 以 stg IAM 启动（`./local-start.sh --iam-stg`）。
- 开启调试导出（**仅本地排查，验证后立即删除**）：

  ```
  FLAMECRAFT_IAM_DEBUG_TOKEN_FILE=./data/iam-user-token.json
  ```

### 4.2 线路级"原样转发"自证（关键）

`cmd/tokencheck -v` 打印：

```
Authorization 指纹(预期,含Bearer) = 284b0d67da2b2f30        ← 由文件原文算出
[线路] Authorization 指纹          = 284b0d67da2b2f30        ← 实际发出去的
```

两者相等 ⇒ 令牌**原封不动**发出，无解码、无重编码、无改写。

### 4.3 原生 SDK 对照实验（排除 fork 干扰）

在 `/tmp` 独立 module 里 require 上游 `gopkg.srv.deeproute.cn/drplatform/drfile/v2 v2.1.1`，  
用 `WithApiToken(jwt)` 走免登录路径，`WithEndpoint` 指向**本地代理**（`httptest`）捕获  
真实发出的头，再转发到**与令牌同环境的**后端。

```go
client := drfile.New(drfile.WithEndpoint(proxyURL), drfile.WithApiToken(jwt))
client.ListFiles(&model.ListFilesRequest{Namespace:"trip", Path:"/", Page:0, Size:2})
```

- stg SSO 令牌 + 同环境(stg)后端 → **200**（指纹匹配）
- stg SSO 令牌 + prod 后端 → 401（指纹匹配，说明是环境问题不是转发问题）

### 4.4 对照组

同一请求、**同环境**下：

- 无鉴权 → 401
- DRPAT → 200
- 密码登录令牌 → 200

## 五、与官方《Drauth-SSO 单点登录接入指南》的对照

| 文档内容 | 含义 | 与我们的关系 |
|-|-|-|
| 3.3 根域 Cookie `Domain=.deeproute.cn` | 登录一次，跨应用免登录（**登录态**共享） | ✅ 我们已接好 |
| 3.5 API 用 JWT Token | token 用于调用应用自身后端，经 `/oauth/introspect` 校验 | ✅ 同环境实测吻合（active:true） |
| 4.2 步骤 3 | 授权码模式换取 access_token(7天)/refresh_token(30天) | ✅ 我们正是这么做的 |
| 通篇未讲跨环境令牌委派 | 文档不承诺跨环境 | — |

**文档理解无错误**：我们的认证流程与文档一致。

## 六、最终结论（修正后）

1. **同环境内，SSO access_token 可被 DR 平台资源服务接受**（stg 实测 200；introspect active:true）。
2. **之前报告的 401 / `active:false` 是跨环境（stg 令牌 → prod 服务）造成的，不是 token audit 或实现问题。**
3. **对生产部署**：prod IAM（flamecraft-oauth prod 客户端）+ prod DrFile 属同环境，  
机制上应该可用，**需在 prod 环境实测确认**。

## 七、行动项

1. **配置环境一致性（FlameCraft 侧，最紧迫）**：`flamecraft.yaml` 里 DrFile endpoint  
原是 prod，而登录走 stg → 本地就 401。**stg 登录必须配 stg DrFile 端点**  
（`stg-drplatform-backend.deeproute.cn`）；prod 登录配 prod 端点。环境必须一一对应。
2. **prod 实测**：用 prod IAM 登录一次，确认 prod SSO 令牌 → prod file-galaxy 返回 200。
3. **按结论推进**：用户身份透传方案**有效**，不需要平台侧改 audience / token exchange。  
后台无用户场景仍用服务 DRPAT 回落。

## 八、经验

1. **排障第一件事：确认环境一致。** IAM 签发环境与资源服务环境不同，表现就是  
"令牌无效"，且与不带鉴权一字不差——极易误判为令牌/audience 问题。
2. **JWT 的 `aud` 可看，但别急着下"不兼容"结论**：同环境内资源服务仍可能接受。  
判据是"同环境实测"，不是解码声明。
3. **"原样转发"自证**：线路级指纹（代理/RoundTripper 捕获 Authorization + sha256 比对）。
4. **`FLAMECRAFT_IAM_DEBUG_TOKEN_FILE` 是高危后门**，验证完必须删除文件并清空配置。
5. **跨环境推断是陷阱**：intropect、资源服务校验，都只在同环境内有意义。
