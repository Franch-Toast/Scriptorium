---
title: "HTTP 认证与授权：Authorization、Bearer、JWT、API Key 与 Cookie"
date: 2026-10-19
description: "从请求头、认证方案、凭证格式、发放流程和业务权限五个层次，理解 Bearer、JWT、API Key、Cookie、OAuth 与 SSO 的区别及实际用法。"
categories:
  - 正典阁
tags:
  - HTTP
  - 前后端
  - 认证与授权
  - JWT
  - OAuth
---

# HTTP 认证与授权：Authorization、Bearer、JWT、API Key 与 Cookie

读接口文档时，经常会同时遇到 `Authorization: Bearer`、`X-API-Key`、JWT、Cookie、OAuth、SSO。这些词描述的是不同层次：**凭证放在哪里、怎样出示、内容是什么、怎样取得，以及取得后允许做什么**。先把层次分清，才容易理解一个系统的认证设计。

本文讨论通用概念，示例地址和凭证均为占位内容。具体产品接受什么格式、如何授权，仍以其接口契约为准。

## 1. 先拆开一条真实请求

```http
GET /api/orders/123 HTTP/1.1
Host: api.example.com
Authorization: Bearer eyJ...示意内容...
```

这条请求中的几个概念分别是：

| 层次 | 例子 | 回答的问题 |
| --- | --- | --- |
| 传递位置 | `Authorization` 请求头 | 凭证放在哪里？ |
| HTTP 认证方案 | `Bearer` | 服务器按什么约定解释凭证？ |
| 凭证格式 | JWT 或不透明字符串 | 凭证内部如何表示信息？ |
| 凭证用途与来源 | access token、个人访问令牌、API Key | 谁发的？给谁用？拿来做什么？ |
| 授权规则 | scope、角色、资源归属、租户隔离 | 验证通过后，这个请求能做什么？ |

因此，**Bearer 与 JWT 可以同时成立**：客户端用 Bearer 方案，出示一枚 JWT 格式的访问令牌。同样，Bearer 后面也可以是一串无法解码的随机值。

反过来，JWT 也可以放在 Cookie 中。换一个请求头不会自动改变令牌的身份、权限、有效期或安全性。

## 2. 认证与授权：先验证凭证，再判断操作权限

认证（Authentication）建立请求主体：这是哪个用户、应用或服务？授权（Authorization）判断主体能否执行具体操作。中文“鉴权”有时统称两者，阅读代码时要看实际检查内容。

以订单接口为例：

```text
接收凭证
  → 验证签名或查询有效性
  → 确认主体是用户 alice
  → 检查 alice 的账号是否启用
  → 检查订单 123 属于谁、alice 是否有读取权限
  → 返回订单或拒绝
```

即使令牌真实有效，也不能因此读取其他用户的订单。一个有效令牌可能代表普通员工，也可能代表后台服务；不能从 `Bearer` 这个词推断它代表谁。

`Authorization` 这个请求头虽然名字含“授权”，却不是一份自动生效的权限声明。最终仍由服务器验证凭证并执行权限规则。[HTTP 认证框架见 RFC 9110 §11](https://www.rfc-editor.org/rfc/rfc9110.html#section-11)。

## 3. Authorization：标准请求头

其常见形式是：

```http
Authorization: <认证方案> <该方案规定的凭证内容>
```

例如：

```http
Authorization: Bearer opaque_example_token
Authorization: Basic YWxpY2U6ZXhhbXBsZS1wYXNzd29yZA==
```

这里是两个不同请求的写法，不能把它们合并成一行再期待服务器同时处理。方案后面的语法由各自规范定义，并非所有方案都只跟一段随机字符串。

HTTP 字段名不区分大小写，因此 `authorization` 与 `Authorization` 等价；认证方案名也不区分大小写。但**凭证值通常需要精确匹配**，不要把 token 转成小写、截断或重新编码。实际发送时采用接口示例中的规范写法。[RFC 9110 §5.1、§11.1、§11.6.2](https://www.rfc-editor.org/rfc/rfc9110.html#section-11.6.2)。

### 3.1 Bearer：持有凭证即可使用

Bearer 的核心语义是：请求方出示令牌即可使用其代表的访问能力，不需要另外证明持有某把密码学私钥。这种便利也意味着，攻击者若窃取令牌，通常可以在其有效范围内重放请求。身份、权限和有效期仍由令牌及服务端规则决定。[RFC 6750 §1、§2.1](https://www.rfc-editor.org/rfc/rfc6750.html#section-2.1)。

```bash
# ACCESS_TOKEN 预先从登录流程或凭证管理器取得。
curl 'https://api.example.com/api/orders/123' \
  -H "Authorization: Bearer $ACCESS_TOKEN"
```

`Bearer` 不负责登录、加密或刷新；它规定出示令牌的方式。把任意字符串放在它后面，不会让字符串自动变成服务器认可的凭证。

Bearer 凭证应通过 HTTPS 发送。不要随意改成 `?access_token=...`：URL 容易进入浏览器历史、代理和访问日志。将凭证放进请求头也仍需对日志脱敏。[RFC 6750 §5](https://www.rfc-editor.org/rfc/rfc6750.html#section-5)。

### 3.2 Basic：用户名和密码的编码

Basic 常见内容是 `Base64(username:password)`。Base64 可以还原，不能提供保密性；必须依赖 HTTPS 保护传输，并控制凭证的保存与使用。Basic 与“用用户名密码换取 token，后续只发送 token”是两种不同的请求模式。[RFC 7617](https://www.rfc-editor.org/rfc/rfc7617.html)。

```bash
# curl 在终端提示输入密码，避免把密码直接写进命令历史。
curl --user alice 'https://api.example.com/protected'
```

一些系统在 OAuth token 端点使用 Basic 验证客户端应用；这时提交的是 client ID／client secret，不是终端用户密码。先确认端点和主体，不能只看见 Basic 就认定是用户登录。

## 4. X-API-Key：常见自定义请求头；API Key：一类凭证

下面的约定很常见：

```http
X-API-Key: sk_example_placeholder
```

但 `X-API-Key` 不是所有 API 都必须遵守的统一认证协议。接口也可能要求 `api-key`、`X-Service-Key`，或者要求将同一种 Key 放入 `Authorization: Bearer`。OpenAPI 的 `apiKey` 安全定义就需要显式指定名字和位置。[OpenAPI 官方说明](https://learn.openapis.org/specification/security.html)。

```bash
curl 'https://api.example.com/api/orders/123' \
  -H "X-API-Key: $API_KEY"
```

API Key 通常由平台控制台或管理 API 创建，用于识别调用方、关联配额／账单或限制接口访问。不同产品可以将它绑定到用户、项目、应用、服务账号或空间；权限、到期、撤销能力都由产品定义。

还要区分“保密的服务端 Key”和“允许公开分发的项目标识 Key”。后者可能只用于配额与来源限制，不能单独承担保护私人数据的任务。不要仅凭名字含 Key 就判断它是完整的身份凭证。例如 Google Cloud 区分标准 API Key 与绑定服务账号的 Key；Stripe 则区分可发布 Key、秘密 Key 和受限 Key，适用位置和权限不同。[Google Cloud 官方说明](https://docs.cloud.google.com/docs/authentication/api-keys)、[Stripe Key 类型](https://docs.stripe.com/keys)。

### 4.1 与 Bearer 相比，差异究竟在哪？

| 比较点 | `Authorization: Bearer <token>` | `X-API-Key: <key>` |
| --- | --- | --- |
| HTTP 层约定 | 标准请求头中的 Bearer 方案 | 产品约定的请求头 |
| 凭证内容 | 可以是 JWT，也可以是不透明值 | 常见为不透明值，格式由产品决定 |
| 主体 | 可以是用户或应用／服务 | 同样取决于平台如何绑定 |
| 有效期、scope、撤销 | 由签发与验证机制决定 | 同样由签发与验证机制决定 |
| 是否需要保密 | Bearer token 必须防泄露 | 承担认证的秘密 Key 也必须防泄露 |

如果服务器接受一枚秘密 API Key，并且拿到它就能访问，那么它同样具有“持有即使用”的风险；自定义请求头并不会改变这一点。

如果一个接口只读取 `X-API-Key`，把正确 Key 放到 Authorization 也可能失败。兼容两种位置需要服务端明确实现，客户端不能自行推断。也不要默认同时发送两种凭证：优先级、是“二选一”还是“必须同时满足”，都需要接口定义。

## 5. JWT：凭证内容的格式

JWT（JSON Web Token）是一种承载声明（claims）的格式。常见的签名／MAC 保护形式采用 JWS 紧凑表示：

```text
Base64url(Header).Base64url(Payload).Base64url(Signature)
```

JWT 也可以使用 JWE 加密；其紧凑形式通常有五段。因此，“JWT 一定是三个点分段字符串”并不严谨，常见三段指的是 JWS 形式。签名形式的 Payload 通常可直接解码，**签名不等于加密**，不要放密码或 client secret。[RFC 7519 §3](https://www.rfc-editor.org/rfc/rfc7519.html#section-3)。

### 5.1 声明字段在表达什么？

以下为解码后的示意，不能直接用来请求 API：

```json
{
  "iss": "https://identity.example.com",
  "sub": "user-123",
  "aud": "orders-api",
  "iat": 1900000000,
  "nbf": 1900000000,
  "exp": 1900000900,
  "scope": "orders:read",
  "jti": "token-example-id"
}
```

| 字段 | 含义 | 常见误解 |
| --- | --- | --- |
| `iss` | 签发者 | “任何能验签的签发者都可信” |
| `sub` | 主体标识 | “一定是邮箱，或在所有签发者间全局唯一” |
| `aud` | 预期接收方 | “A 服务的令牌可以随便给 B 服务使用” |
| `iat` | 签发时间 | “存在 iat 就自动限制有效期” |
| `nbf` | 此时间之前不可接受 | “忽略它也不会影响验证” |
| `exp` | 到期时间 | “客户端改大时间就能续期” |
| `jti` | 令牌标识 | “有这个字段就已经实现防重放／撤销” |
| `scope` | 本例中的权限范围 | “JWT 标准要求所有 JWT 都有 scope” |

这些字段的要求取决于令牌用途和协议；`scope` 来自授权语境，并非所有 JWT 都必须带。时间字段采用 NumericDate，即自 Unix epoch 起的秒数。解析 `sub` 时通常需要结合可信 `iss`，不能把别的签发者的同名账号视为同一人。[RFC 7519 §4.1](https://www.rfc-editor.org/rfc/rfc7519.html#section-4.1)。

### 5.2 解码、验签、授权是三件事

解码只是读取内容。任何人都能拼一个带 `"role":"admin"` 的 JSON；只有正确验证完整性、签发者、接收方、时间和用途，才能建立信任。服务器应固定允许的算法与可信密钥来源，不能让令牌自行决定信任规则，也不能把“能解码”当成认证成功。[JWT 安全实践 RFC 8725 §3](https://www.rfc-editor.org/rfc/rfc8725.html#section-3)。

即便验证成功，`orders:read` 也未必允许读取任意订单。租户、资源所有者、账号状态等仍可能需要查询本地数据。

验签也不意味着每个 API 都要保存签发私钥：使用非对称签名时，签发方持有私钥，资源服务可以用可信公钥验证；采用 HMAC 时，签发和验证使用共享秘密。两种部署的信任边界不同。[JWS RFC 7515 §3](https://www.rfc-editor.org/rfc/rfc7515.html#section-3)。

## 6. 不透明令牌与 JWT：服务器如何验证？

不透明（opaque）意味着客户端无法依赖其内部结构；它通常是一串引用值，具体信息由签发者或资源服务保存。JWT 则可以携带可验证声明。两者都可能作为 access token，也都可以通过 Bearer 传递。

| 方式 | 验证路径 | 撤销与权限变化 |
| --- | --- | --- |
| 本地数据库验证不透明 Key | 用凭证摘要查记录，检查启用、到期、权限 | 读取最新记录时可以应用变更；本地缓存可能增加延迟 |
| 远程验证令牌 | 调签发系统的 introspection 接口 | 可获知远程状态；成功结果缓存会产生撤销窗口 |
| JWT 本地验证 | 用可信密钥验证声明 | 纯本地验签无法自动知道远程刚发生的撤销，需要到期、撤销表或额外查询等机制 |

这些是常见组合，并非排他的技术限制。JWT 也可以配合数据库和 introspection；不透明令牌也可以使用缓存。JWT 不会强制一个系统“完全无状态”。

标准 OAuth introspection 规定了 `active` 等响应字段及端点保护要求；厂商同名接口可能另有 JSON 包装和认证方式，不能把某产品的请求格式当成通用规范。[RFC 7662 §2](https://www.rfc-editor.org/rfc/rfc7662.html#section-2)。

### 6.1 为什么会有“撤销后最多等 60 秒”？

假设资源服务在 10:00:00 验证成功，缓存 60 秒；签发方在 10:00:10 撤销令牌。若服务仍信任缓存，该令牌最多还能被接受约 50 秒。缓存命中是否续期、故障是否使用旧缓存，也必须由实现明确规定。

缓存时长应受令牌到期限制；60 秒是一个产品设计值，不是 Bearer、JWT 或 OAuth 的默认标准。缓存越久，远程查询越少，但撤销传播越慢。[RFC 7662 §4](https://www.rfc-editor.org/rfc/rfc7662.html#section-4)。

## 7. Cookie 与 Session：浏览器登录的另一组概念

Cookie 是浏览器按域、路径等规则存储并随匹配请求发送的数据；Session 是服务端用于维持登录状态的一种机制。常见搭配是 Cookie 中只放随机 session ID，用户与权限信息放在服务端。

```http
HTTP/1.1 200 OK
Set-Cookie: session=example_session_id; Path=/; Secure; HttpOnly; SameSite=Lax
```

之后浏览器可能自动发送：

```http
Cookie: session=example_session_id
```

Cookie 也可以装 JWT，因此“Cookie 方案”和“JWT 方案”不是必然对立。`HttpOnly` 限制 JavaScript 读取 Cookie，`Secure` 限制通过安全连接发送；这些属性不会代替业务授权。[RFC 6265](https://www.rfc-editor.org/rfc/rfc6265.html)。

### 7.1 为什么浏览器与 CLI 的使用感觉不同？

| 场景 | 凭证通常由谁附加 | 需要注意什么 |
| --- | --- | --- |
| 浏览器 Cookie Session | 浏览器按 Cookie 规则自动附加 | 跨站发送规则、CSRF、Session 失效 |
| 前端代码使用 Bearer | 应用代码读取已有 token 后设请求头 | token 存储、XSS、CORS、过期处理 |
| CLI／后端使用 API Key 或 Bearer | SDK／HTTP client 读取配置后设请求头 | 保密存储、目标地址、轮换、超时与错误处理 |

环境变量、配置文件和 keyring 是客户端的凭证来源，不是 HTTP 认证协议。仅设置 `ACCESS_TOKEN`，curl 不会自动把它放进请求；需要显式 `-H`，或由 SDK 按文档读取变量。

### 7.2 Cookie、XSS、CSRF 分别是什么关系？

CSRF 是攻击者诱导浏览器向目标网站发请求，借用浏览器自动携带的身份。Cookie 登录的写接口通常需要结合 SameSite、CSRF token、Origin 校验等保护。SameSite 的“站”与 CORS 的“源”也不是同一概念。[OWASP CSRF 指南](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)。

XSS 是攻击代码在受信网页的上下文执行。放在 localStorage 的 token 能被该页面脚本读取；HttpOnly Cookie 可以减少凭证被直接读走的机会，但攻击脚本仍可能借助浏览器发已认证请求。不能把 HttpOnly 当成 XSS 已解决，也不能把 Bearer 当成所有场景都无需 CSRF 防护。[OWASP XSS 指南](https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html)。

浏览器登录通常会考虑 HttpOnly Cookie／服务端会话或 BFF 架构，避免让前端长期持有高权限秘密。采用什么方式仍需结合页面、API 域和攻击面设计；长期服务端 API Key 不应直接嵌入可公开下载的前端代码。

## 8. OAuth、OIDC、SSO：凭证从哪里来？

前面的请求头与 JWT 主要描述“访问 API 时带什么”。OAuth 和 OIDC 进一步描述客户端如何取得授权、确认身份。

| 名词 | 作用 | 不应直接等同于 |
| --- | --- | --- |
| OAuth 2.0 | 委托授权框架，让客户端取得访问资源的授权 | JWT 格式、用户名密码登录接口 |
| OpenID Connect（OIDC） | 在 OAuth 2.0 上增加身份认证，使用 ID token 等机制 | 任意 access token 都能证明用户已登录 |
| SSO | 一次登录后访问多个应用的体验与架构目标 | 所有应用共用一枚 token、共用业务权限 |
| PAT | 用户为程序访问创建或领取的个人访问令牌 | 固定格式、一定无限期、一定拥有所有权限 |

OAuth 的 access token 面向资源服务；OIDC 的 ID token 面向发起登录的客户端。ID token 即使也是 JWT，也不应被当成可通用于业务 API 的 access token。[OAuth 2.0 RFC 6749](https://www.rfc-editor.org/rfc/rfc6749.html)、[OIDC Core](https://openid.net/specs/openid-connect-core-1_0.html#IDToken)。

### 8.1 一次典型登录与 API 访问

下面是采用授权码流程的示意，省略了具体参数和失败分支。根据应用形态，兑换令牌的一方可以是有后端的客户端，也可以是使用 PKCE 的公共客户端。

```mermaid
sequenceDiagram
    participant U as 用户／浏览器
    participant A as 应用客户端
    participant I as 身份／授权服务器
    participant R as 业务 API
    U->>A: 点击登录
    A-->>U: 跳转授权端点
    U->>I: 登录并按策略完成授权
    I-->>U: 回调地址携带授权码
    U->>A: 返回授权码与流程关联信息
    A->>I: 使用授权码兑换令牌，按流程提供 PKCE 等校验
    I-->>A: access token，OIDC 下另有 ID token
    A->>R: Authorization: Bearer access_token
    R->>R: 验证令牌、建立主体、检查业务权限
    R-->>A: 数据或错误
```

授权码通常短时、一次使用；不应拿授权码直接调用业务 API。现代 OAuth 授权码流程应使用 PKCE 等保护，不能直接照搬历史教程中的隐式流程或密码授权流程。[OAuth 安全实践 RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html#section-2.1)。

SSO 也可以只负责应用登录：应用验证 IAM 身份后，自己建立 Session 或签发本地 JWT。此时，IAM token 与应用 token 是两套凭证；IAM 登录成功不代表拥有该应用中的所有业务权限。

### 8.2 三种常见 token 的分工

| 凭证 | 正常交给谁 | 做什么 |
| --- | --- | --- |
| Access token | 目标资源 API | 在有效期与授权范围内访问资源 |
| Refresh token | 原授权服务器的 token 端点 | 在服务器仍允许时换取新的 access token |
| ID token | 登录客户端 | 让客户端按 OIDC 规则确认认证结果 |

Refresh token 不应发送给普通业务 API。access token 过期后，也不是修改 JWT 的 `exp`；需要走受支持的刷新或重新认证流程。服务端必须单独验证 refresh token，不能因为客户端声称过期就无条件续发。[RFC 6749 §1.4、§1.5](https://www.rfc-editor.org/rfc/rfc6749.html#section-1.4)。

## 9. 真正调用接口时怎么操作？

### 9.1 curl：按接口要求放入指定位置

```bash
# 场景一：服务要求 Bearer；变量里可能是 JWT，也可能是不透明 token。
curl 'https://api.example.com/api/me' \
  -H "Authorization: Bearer $ACCESS_TOKEN"

# 场景二：服务要求 API Key 自定义头。
curl 'https://api.example.com/api/me' \
  -H "X-API-Key: $API_KEY"
```

不要把真实值硬写进命令历史、文档或仓库。变量展开后的命令参数仍可能被本机进程检查工具看到；敏感环境应使用客户端支持的受保护凭证输入机制，并限制机器访问。调试 `curl -v`、代理日志和截图时也要防止泄露请求头。

### 9.2 浏览器 JavaScript：Bearer 需要代码设置

```javascript
// accessToken 来自已完成的认证流程；这里只演示一次 API 请求。
const response = await fetch("https://api.example.com/api/me", {
  headers: { Authorization: `Bearer ${accessToken}` },
});
if (!response.ok) throw new Error(`HTTP ${response.status}`);
const result = await response.json();
```

Cookie 登录常见的请求写法则是：

```javascript
// 跨源携带 Cookie 还取决于服务端 CORS、Cookie 属性和浏览器策略。
const response = await fetch("https://api.example.com/api/me", {
  credentials: "include",
});
```

跨源设置 Authorization 或 X-API-Key 通常会触发 CORS 预检；服务器需允许对应来源、方法和请求头。`Authorization` 需要显式允许，不能仅靠 `Access-Control-Allow-Headers: *` 替代。Cookie 凭证模式还需要配套的 CORS 凭证响应配置。**CORS 是浏览器跨源访问规则，不是 API 身份认证；curl 不受浏览器 CORS 限制，也仍需有效凭证。**[WHATWG Fetch 标准](https://fetch.spec.whatwg.org/#http-cors-protocol)。

### 9.3 SDK：不要从方法名猜测全部行为

`WithToken`、`apiKey=`、`bearerToken=` 等是 SDK 的配置接口，最终要看它生成的 HTTP 请求。一些 SDK 自动读取环境变量，另一些只接受显式参数；部分会刷新 JWT，另一些遇到 401 直接失败。

接入前确认：目标 URL、认证头格式、令牌用途与环境、显式配置和环境变量的优先级，以及失败后是否切换凭证。尤其不要在用户 A 的凭证失败后，悄悄回退到用户 B 或管理员凭证重试写操作。

## 10. 过期、登出与撤销为什么不同？

过期是时间边界；撤销是签发者或服务端提前停止接受某凭证；登出是某个应用结束登录状态的操作。三者不必同时发生。

关闭页面或删除浏览器里的 token，只是客户端不再使用它，不能让攻击者保存的副本立即失效。撤销 refresh token 也不必然使已经发出的 access token 立刻失效；是否联动取决于服务器实现。[OAuth 令牌撤销 RFC 7009 §2](https://www.rfc-editor.org/rfc/rfc7009.html#section-2)。

判断“权限修改后多久生效”，需要逐层看：

```text
签发方状态传播 → 令牌验证缓存 → 本地权限读取或缓存 → 本次操作的授权检查
```

如果角色只写在长时 JWT 中且服务端不查询最新状态，角色变化可能要等旧令牌到期；如果每次查最新成员关系，就能更快应用。本地验签速度和撤销实时性是两个不同的设计维度。

## 11. 常见错误与排查顺序

| 表现 | 可能原因 | 首先查看 |
| --- | --- | --- |
| 401 Unauthorized | 未带凭证、过期、签名／issuer／audience 不符合、服务不接受该令牌 | 请求头是否真正发出、服务端验证结果 |
| 403 Forbidden | 主体缺少权限，或产品另有拒绝策略 | scope、角色、资源归属、租户成员关系 |
| 浏览器报 CORS，curl 正常 | 预检或跨源响应配置不满足浏览器要求 | OPTIONS 与响应 CORS 头 |
| 302 跳转登录页 | 访问的是浏览器登录入口，或网关采用重定向逻辑 | 原始状态码与 Location，不先自动跟随 |
| 503／超时 | 认证依赖不可用，或业务服务本身异常 | 是认证阶段失败还是业务阶段失败 |
| 换成 Bearer 仍失败 | 令牌来源／用途不对，或服务不支持这种请求头 | 接口契约与目标环境 |

HTTP 规范下，401 响应应提供适用的 `WWW-Authenticate` 挑战；Bearer 还定义了 `invalid_token`、`insufficient_scope` 等错误约定。实际产品可能偏离这些约定，所以状态码要结合错误体和验证日志判断，不能仅凭一个 403 断言已经完成用户认证。[RFC 9110 §15.5.2–15.5.4](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.5.2)、[RFC 6750 §3](https://www.rfc-editor.org/rfc/rfc6750.html#section-3)。

一个实用的排查顺序是：先确认请求到了预期服务和环境，再确认凭证被发到正确位置；接着看令牌的签发者、接收方、到期和用途，最后检查具体操作权限。不要把真实 token 上传到不可信的在线解码网站。

## 12. 如何选方案，以及哪些结论不能套用

| 需求 | 常见选择 | 主要设计点 |
| --- | --- | --- |
| 浏览器访问自有应用 | Cookie Session，或 OIDC 登录后建立本地会话 | CSRF、XSS、会话管理与跨源边界 |
| 用户在 CLI／脚本访问 API | 短时 access token，或权限受限的 PAT | 凭证保存、scope、到期、撤销与审计 |
| 服务间访问 | 应用／工作负载身份换取 access token，或受管理的 API Key | 避免依赖员工个人账号，限制服务权限 |
| 委托第三方应用访问用户资源 | OAuth 授权流程 | 授权范围、客户端类型、回调与令牌生命周期 |
| 希望被盗 token 难以单独重放 | DPoP／mTLS 等发送者约束机制 | 需要客户端与服务端共同支持 |

DPoP 等机制还要求证明持有与令牌关联的密钥，因此超出了普通 Bearer 的“仅凭持有令牌”模型；它不是给现有 token 随意加一个头就能生效。[RFC 9449](https://www.rfc-editor.org/rfc/rfc9449.html)。

阅读任何系统的文档时，都应避免以下推断：

- 看见 Bearer，就认定是 JWT、短时令牌或用户身份。
- 看见 API Key，就认定永久有效、机器专用或权限低于用户。
- 看见 JWT，就认定已加密、完全无状态，或服务端可以立即撤销。
- 看见同一个 user ID，就认定来自不同 issuer 的身份是同一个人。
- 看见 SSO，就认定所有应用接受同一 token，或共享相同业务权限。
- 换成 HTTPS，就认为客户端存储、日志和业务越权问题也被解决。

传递位置、令牌格式、签发流程和业务授权必须分别确认。只有把这几项连起来，才能准确回答“拿着这一枚凭证，能向哪个服务，以谁的身份，做哪些事，以及何时失效”。

## 参考规范与阅读顺序

入门可先读 HTTP 认证框架与 Bearer 使用方式，再读 JWT；要理解登录、刷新和第三方授权时，再继续 OAuth 与 OIDC。

- [RFC 9110：HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110.html)，§11 认证框架与 §15 状态码。
- [RFC 6750：Bearer Token Usage](https://www.rfc-editor.org/rfc/rfc6750.html)，请求头、错误和令牌泄露风险。
- [RFC 7519：JWT](https://www.rfc-editor.org/rfc/rfc7519.html) 与 [RFC 8725：JWT Best Current Practices](https://www.rfc-editor.org/rfc/rfc8725.html)，格式与验证边界。
- [RFC 6749：OAuth 2.0](https://www.rfc-editor.org/rfc/rfc6749.html) 与 [RFC 9700：OAuth 安全实践](https://www.rfc-editor.org/rfc/rfc9700.html)，后者补充并更新早期流程的安全要求。
- [OIDC Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html)，身份认证与 ID token。
- [RFC 7662：Token Introspection](https://www.rfc-editor.org/rfc/rfc7662.html)、[RFC 7009：Token Revocation](https://www.rfc-editor.org/rfc/rfc7009.html)，远程验证、缓存与撤销。
- [RFC 6265：HTTP State Management](https://www.rfc-editor.org/rfc/rfc6265.html)，Cookie 的基础机制；[Fetch Standard](https://fetch.spec.whatwg.org/)，浏览器请求及 CORS。
