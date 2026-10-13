---
title: "[历史] SSO access_token 是否被 DrFile 拒绝 —— 前因后果与根因分析"
date: 2026-09-20
categories:
  - 撰修司
tags:
  - FlameCraft
  - SSO
---

# [历史] SSO access_token 是否被 DrFile 拒绝 —— 前因后果与根因分析

<blockquote id="doxcne71tlkbTe8LktjiQHQk5Kh"><p id="doxcncuDCjnqNNm4NcVSXEVfNRg"><b>历史调查，勿作为当前行为依据。</b> 2026-09-14 的阶段性结论（"SSO 令牌因 <code>aud=flamecraft-`oauth</code>`<br/>不兼容被资源服务拒绝"）<b>已被推翻</b>。真相是：<b>同环境内 SSO 令牌完全可用</b><br/>（stg 令牌 → stg file-galaxy = 200，introspect <code>active:`true</code>`）；当时的 401 是<br/><b>跨环境测试假象</b>（stg 令牌打 prod 资源服务）。根因是<b>环境一致性</b>，不是 audience。<br/>用户身份透传方案<b>有效</b>。详见下方「结论修正」与存档文档：<br/><code>/sandbox/docs/03_Experience 经验库/踩坑记录/环境配置/DRAUTH-SSO令牌audience与DR平台资源服务不兼容.`md</code>`</p><p id="doxcn8aiTiSWD3320707Lxashyd">状态：根因已修正为"环境一致性"；生产环境随后已在 2026-09-16 prod 验证确认同环境可用。<br/>日期：2026-09-11 ~ 09-14<br/>当前实现：<cite doc-id="WVotdBqE9o2G9MxcCNPcdZEcnsb" file-type="docx" title="出站用户身份" type="doc"></cite>；本文件保留历史证据和排查过程。</p></blockquote>

## 一、背景

FlameCraft 的出站身份改造（<cite doc-id="WVotdBqE9o2G9MxcCNPcdZEcnsb" file-type="docx" title="出站用户身份" type="doc"></cite>）目标之一是：  
**后端访问 DR 平台（DrFile）时，使用当前登录用户的 IAM 身份，而不是开发/服务账号。**

方案设计阶段就把一个风险标为「R1（阻断级）」：

> drauth 授权码流程签发的 `access_token` 与 DRPAT 虽然同出 IAM，但 **grant 不同、  
> audience 可能不同**；若 DrFile 的资源服务不认它，整条透传链路不成立。

改造完成后本地实测，R1 **确实发生了**。

## 二、现象

本地以 stg IAM 启动并用浏览器完成 SSO 登录后，触发一次 trip 分析，日志如下（节选）：

```
level=info msg="user logged in via IAM SSO" sub=47081 email=yifeizhang@deeproute.ai hasRefreshToken=true

time=... level=info  msg="Use context accessToken: eyJraW******-w"        ← 用户的 SSO access_token
time=... level=info  msg=Request body="{...}" url="http://drplatform-backend.deeproute.cn/file-galaxy/namespace/listFiles"
time=... level=warning msg="Retry response error status: 401, response: {\"message\":\"Token is invalid\",\"status\":\"FAILED\"}" attempt=1
time=... level=error msg="token has expired, try to refresh token"
time=... level=error msg="token refresh failed: refresh token is empty, re-login required, try re-login"
time=... level=info  msg="Use pre-configured ApiToken, skip IAM login"     ← 尝试回落
time=... level=warning msg="Retry response error status: 401, ... " attempt=2
... attempt=3, 4 ...
最终：401
```

两个可疑点：

1. 用户令牌被拒（401 `Token is invalid`）
2. **回落服务身份也没有生效**（attempt 2/3/4 仍然 401）

## 三、根因一：SDK 的 401 重试不会回落到服务身份（已修复）

### 现象

错误令牌被**原样重发了 4 次**，从未换成可用的服务凭证。

### 根因

drfile-sdk 的 401 重试走 resty 的 `SetRetryAfter`：

```go
// 上游实现
h.client.SetRetryAfter(func(client *resty.Client, response *resty.Response) (time.Duration, error) {
    if response.StatusCode() == http.StatusUnauthorized {
        if err := h.RefreshToken(ctx); err != nil {
            h.Auth(ctx)                        // 重新登录（服务身份）
        }
        if h.auth != nil {
            client.SetHeader(HeaderAuthorization, "Bearer "+h.auth.AccessToken)
        }
    }
    ...
})
```

两个问题：

1. **`resolveAuthorization` 只在 `doExecuteRequest` 里执行一次**，resty 重试不会再次调用它。  
因此当调用方通过 ctx 透传的令牌被拒时，重试仍发送同一个令牌 —— **永远不会回落**。
2. 上游只在「重新登录成功」（`h.auth != nil`）时更新头，**漏掉了「已配置 ApiToken、  
未走登录」这条分支**；而且写的是**共享 resty client 的默认头**  
（`resty.Client.Header` 是裸 map，无锁写 → 并发 data race + 跨请求身份泄漏）。

### 修复

在 fork（`vendor-deps/drfile-sdk-go-v2`）中改为改写 **`response.Request` 的请求级头**  
（无共享状态），并补上 ApiToken 分支。详见该目录 `FORK.md` 的补丁 (b)。

### 验证

新增真实链路回归测试 `pkg/drfile/e2e_usertoken_test.go::TestEndToEndInvalidUserTokenFallsBack`：

```
修复前：attempt 1/2/3/4 全部 401 → 请求整体失败
修复后：attempt 1（用户令牌）401 → attempt 2（服务凭证）✅ 200
```

> 排查插曲：最初怀疑是自己删掉那行 `client.SetHeader`（原本就有竞态）导致的，  
> 于是做了**对照实验**——把该行恢复后现象完全一致（同样 401×4），  
> 证明真正原因是「重试不更新鉴权头」，而不是那行代码。

## 四、根因二：SSO access_token 的 audience 不被 file-galaxy 接受（需平台侧解决）

### 证据链（全部可复现）

**2026-09-14 用真实 SSO 令牌实测**（`cmd/tokencheck`，令牌由浏览器登录产生）：

| 令牌 | 解码后的声明 | file-galaxy | prod-artifacts-server |
|-|-|-|-|
| **SSO access_token** | `iss=drauth`  <br/>**`aud=flamecraft-oauth`**  <br/>`client_id=flamecraft-oauth`  <br/>`scope=openid profile email`  <br/>`exp` = 7 天 | **401**`Token is invalid` | **401**`user sub is empty` |
| 密码登录 token（`/drauth/auth/login`） | `iss=drauth`  <br/>**`aud=deeproute-ldap`**  <br/>`client_id=deeproute-ldap`  <br/>`scope` = 无  <br/>`exp` = 7 天 | **200** | **403**（认出令牌，但该用户无权限） |
| DRPAT（不透明，非 JWT） | 无声明，需 introspect | **200** | **200** |
| 不带鉴权 | — | **401**`Token is invalid`（与 SSO token 一字不差） | **401**`authorization header is empty` |

**结论**：SSO access_token 的 `aud`**实测为 `flamecraft-oauth`**（即 OAuth 客户端自身），  
**两个资源服务都不接受它**。

### 两种 JWT 的差异（同样由 drauth 签发）

|  | SSO access_token | 密码登录 token |
|-|-|-|
| 格式 | JWT（RS256 + kid） | JWT（RS256 + kid）— **同构** |
| 长度 | 954 字符 | 901 字符 |
| `iss` | `drauth` | `drauth` — **相同** |
| `scope` | `openid profile email` | 无 |
| `aud` / `client_id` | **`flamecraft-oauth`** | **`deeproute-ldap`** ← **唯一实质差异** |
| 有效期 | 7 天 | 7 天 — 相同 |

**→ 格式与签发方完全相同，差别只在 `aud`（以及附带的 `scope`）。**  
这直接印证：资源服务是**按 aud 放行**的。

### 注意两个资源服务的拒绝方式不同

- **file-galaxy**：401 `Token is invalid` —— 与「不带任何鉴权」**完全一致**，  
说明它把 SSO 令牌当作**无凭证**。
- **prod-artifacts-server**：401 `user sub is empty` —— 它**认出了这是一个 JWT**  
（与"完全无效令牌"的报错相同），但解不出可用的 `sub`，因此同样拒绝。  
当令牌合法但用户无权时，它返回的是 **403**（见上表密码登录 token 一行）。

而**能用的 token**（密码登录换来的 JWT、DRPAT）其 `aud` 指向资源服务  
（`deeproute-ldap`）。SSO 的 access_token 由 `flamecraft-oauth` 这个 OAuth 客户端签发  
（`scope=openid profile email`），`aud` 是客户端自身标识，不是资源服务。

### 结论

**file-galaxy 按 audience 校验**，只认 `aud` 覆盖资源服务的令牌。  
`flamecraft-oauth` 客户端签发的 access_token 不满足该条件，因此被拒。

### 为什么"以前能用"

旧版本用 `DRFILE_USERNAME/PASSWORD` 走 `POST /drauth/auth/login`  
（`providerCode=deeproute-ldap`）换 token，该 token 的 `aud` 正是 `deeproute-ldap`，  
所以被接受。

**关键认知：能跑通的关键是 audience，不是"用了账号密码"这件事本身。**  
因此只要让 `flamecraft-oauth` 客户端签发的 token 带上资源服务 audience，  
**透传方案立刻可用，代码一行都不用改**。

## 五、与《Drauth-SSO 单点登录接入指南》的对照

该方案提供的是**登录态（SSO）**层面的跨平台复用，**不覆盖资源服务间的令牌委派**：

| 该 SSO 方案提供的 | 说明 |
|-|-|
| 根域 Cookie `Domain=.deeproute.cn` | 用户在 IAM 登录一次后，访问任意 `.deeproute.cn` 子域应用时浏览器自动携带，DRAUTH 识别已登录 → 直接签发授权码（`firstParty=true` 自动授权），**无需重复输密码** |
| 每个应用各自换 token | 文档 3.5 明确：**Session Cookie 仅用于 OAuth 授权流程；API 调用使用 JWT Token（不依赖 Cookie）**；每个应用用自己的 `client_id` 换取各自的 token |

该方案**没有提及**的内容（正是我们撞上的）：

- access_token 的 `aud`/`scope` 与**下游资源服务**的关系
- 跨资源服务的令牌委派（token exchange / OBO）

文档中应用的 token 只用于**应用自己的后端 API**；用它去访问**另一个平台的资源服务**  
（file-galaxy）属于方案未覆盖的场景。当前概念边界见 <cite doc-id="MB6XdmOtvoSJFTxeoH6cHZ4lnxe" file-type="docx" title="SSO 与令牌模型" type="doc"></cite>。

## 六、当前状态与后续

### 已修复（本仓库）

- ✅ 当时已验证 401 重试行为；服务身份回落后来被移除，当前规则见出站身份文档。
- ✅ 刷新接口改为文档规定的 `POST /drauth/oauth/token`  
（原先误用了 SDK 的 `/drauth/auth/token/refresh`，那是密码登录会话的刷新接口）

### 待平台侧确认

1. `flamecraft-oauth` 客户端的 access_token 能否配置**多 audience**（含资源服务）？
2. 若不支持，drauth 是否提供 **RFC 8693 token exchange**（换取资源服务 audience 的 token）？
3. 是否有其他推荐方式让"已登录用户身份"用于访问 file-galaxy？

### 当前行为（已可接受的降级）

本文记录的“用户令牌失败后回落服务身份”已废弃；生产环境现在无服务端备用凭据，失败会直接返回无用户身份错误。

## 七、复现方法

### 一键复现（推荐）

```bash
# 1) 让 FlameCraft 导出登录令牌（仅本地排查用）
#    .env: FLAMECRAFT_IAM_DEBUG_TOKEN_FILE=./data/iam-user-token.json
# 2) 启动并完成一次浏览器 SSO 登录
# 3) 用令牌打各资源服务并打印声明
go run ./cmd/tokencheck -token-file ./data/iam-user-token.json

# 4) 验证完立即删除
shred -u ./data/iam-user-token.json    # 或 rm -f
```

`cmd/tokencheck` 会打印令牌声明（`iss/aud/client_id/scope/sub`）以及它对  
file-galaxy、prod-artifacts-server 的实测 HTTP 状态码，**不打印令牌本身**。

### 只解码声明（不发起请求）

```bash
echo '<令牌>' | python3 -c "import sys,base64,json;p=sys.stdin.read().strip().split('.')[1];p+='='*(-len(p)%4);d=json.loads(base64.urlsafe_b64decode(p));print({k:d.get(k) for k in ('iss','aud','client_id','scope','sub') if k in d})"
```

预期：`aud` 为 `flamecraft-oauth`（可用令牌则为 `deeproute-ldap`）—— 根因直接证据。

### 对照实验：同一请求体、不同令牌

| 令牌 | `POST /file-galaxy/namespace/listFiles` |
|-|-|
| 无 | 401 `Token is invalid` |
| SSO access_token | 401 `Token is invalid`（与"无"一字不差） |
| 密码登录 token（aud=deeproute-ldap） | 200 |
| DRPAT | 200 |
