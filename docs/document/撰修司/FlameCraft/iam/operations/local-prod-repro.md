---
title: "本地以生产形态启动 FlameCraft（prod IAM + 域名拦截）—— 原理与复测手册"
date: 2026-09-20
categories:
  - 撰修司
tags:
  - FlameCraft
---

# 本地以生产形态启动 FlameCraft（prod IAM + 域名拦截）—— 原理与复测手册

<blockquote id="doxcn79ljFdPFMQ2P7FtKN2p9jd"><p id="doxcnuXEYD8XCRNT0uHU2CdcAie">用途：在开发机上以<b>接近生产</b>的配置启动 FlameCraft（<code>FLAMECRAFT_AUTH_ENABLED=`true</code>`、<br/>prod IAM、<code>https://flamecraft.srv.deeproute.`cn</code>`），供手动验证 SSO 登录与出站取数。<br/>一键脚本：<code>./.prod-run/run.sh {setup|build|start|stop|status|logs|verify|teardown}</code><br/>相关：<code>prod IAM 端到端验证</code>（登录链路实测）、</p><p id="doxcnPPKw5FfRWkRmMqV69pHBLb"><cite doc-id="WVotdBqE9o2G9MxcCNPcdZEcnsb" file-type="docx" title="出站用户身份" type="doc"></cite></p></blockquote>

---

## 一、为什么需要「域名拦截」

FlameCraft 的 OAuth 是**授权码模式**，`redirect_uri` 必须与 IAM 管理员注册的地址  
**逐字符一致**，否则 drauth 会拒绝。该客户端注册的回调是：

```
prod 环境：https://flamecraft.srv.deeproute.cn/auth/callback
```

问题在于这个域名在 DNS 上**真实存在**：

```
$ getent hosts flamecraft.srv.deeproute.cn
10.3.8.101      stg-traefik-large-lb.deeproute.cn flamecraft.srv.deeproute.cn
```

它指向 stg 的 traefik 网关。若不做处理，浏览器完成登录后会被回跳到**真实网关**  
而不是你本机的实例，本机拿不到 `code`，登录自然失败。

因此必须把该域名在**本机**劫持到 `127.0.0.1`：

```
/etc/hosts:  127.0.0.1 flamecraft.srv.deeproute.cn
```

这就是「域名拦截」的全部含义 —— 让浏览器访问该域名时落到本机，而不是真实 LB。

### 关键前提：hosts 必须改在**浏览器所在的机器**上

**这是最容易踩的第二个坑。**`/etc/hosts` 是**每台机器各自生效**的：

- 在沙箱/服务器里改 hosts，只影响**该机器上运行的进程**（比如你 `curl` 测试）；
- **不会**影响你笔记本上的浏览器 —— 它按自己的 DNS 解析，仍会打到真实 LB。

典型症状：

| 观察点 | 结果 |
|-|-|
| 沙箱内 `curl https://flamecraft.srv.deeproute.cn/auth/status` | `enabled:true`（打到沙箱实例） |
| 你浏览器打开同一个 URL | `enabled:false`（打到真实 LB 的 v1.9.8，它没开认证） |

两个实例的区分方法（`APP_VERSION` 与 JS 文件名都不同）：

```bash
# 真实 LB（v1.9.8，AUTH 关闭）
curl -sk --resolve flamecraft.srv.deeproute.cn:443:10.3.8.101 https://flamecraft.srv.deeproute.cn/auth/status
curl -sk --resolve flamecraft.srv.deeproute.cn:443:10.3.8.101 https://flamecraft.srv.deeproute.cn/ | grep APP_VERSION

# 沙箱实例（dev，AUTH 开启）
curl -sk --resolve flamecraft.srv.deeproute.cn:443:<沙箱IP> https://flamecraft.srv.deeproute.cn/auth/status
```

因此：**在沙箱里跑完 `setup` 之后，还要在你自己笔记本上再改一次 hosts**（见「二、首次准备」第 6 步）。  
执行 `./.prod-run/run.sh client-setup` 会打印出你笔记本上需要执行的命令。

> 注意：`FLAMECRAFT_EXTERNAL_URL` 必须是 `https://flamecraft.srv.deeproute.cn`  
> （与 IAM 注册值一致），**不能**改成 `http://localhost:7070`，否则 `redirect_uri`  
> 不匹配。这也是本地复测必须做域名拦截、而不能直接用 localhost 的原因。

### 为什么还要 nginx

`FLAMECRAFT_EXTERNAL_URL` 是 `https://`，而 FlameCraft 自身只监听明文 HTTP，  
且会话 Cookie 的 `Secure` 属性直接取自该 URL 前缀：

```go
// pkg/iamauth/session.go
Secure: strings.HasPrefix(c.cfg.ExternalURL, "https://"),
```

所以需要一层 TLS 终止：nginx 监听 443 用自签证书解密，再反代到 `127.0.0.1:7070`。  
这样浏览器侧是 HTTPS（Cookie 能正常下发），后端仍是明文 HTTP。

```
浏览器 ──https──▶ nginx:443 ──http──▶ FlameCraft:7070
         (自签证书)          (TLS 终止)
              │
         /etc/hosts 把 flamecraft.srv.deeproute.cn 指到 127.0.0.1
```

---

## 二、一键复测（推荐）

### 首次准备

```bash
cd /sandbox/FlameCraft

# 1) 生成自签证书 + 写 hosts 拦截 + 配 nginx + 把证书装入系统信任库
./.prod-run/run.sh setup

# 2) 填 prod 凭据（仅首次；文件已被 .gitignore 忽略）
vim .prod-run/flamecraft.env     # 见下方「三、配置项」

# 3) 构建前端 + 编译二进制（关键，见「四、易错点」）
./.prod-run/run.sh build

# 4) 启动
./.prod-run/run.sh start

# 5) 一键核验（在沙箱内）
./.prod-run/run.sh verify

# 6) 打印「你的笔记本」上需要执行的 hosts 命令（关键！）
./.prod-run/run.sh client-setup
```

第 6 步会在**你的笔记本**上改 hosts，把域名指向沙箱 IP（或走 SSH 隧道）。  
完成后浏览器打开 [**https://flamecraft.srv.deeproute.cn**](https://flamecraft.srv.deeproute.cn)，应自动跳转 SSO 登录。

### 日常使用

```bash
./.prod-run/run.sh status    # 查看状态
./.prod-run/run.sh logs      # 跟踪日志
./.prod-run/run.sh stop      # 停止后端
./.prod-run/run.sh start     # 再次启动
```

### 测完恢复现场

```bash
./.prod-run/run.sh teardown
```

会依次：停后端 → 删 `/etc/hosts` 拦截行 → 删 nginx 配置并 reload → 移除信任证书。  
`.prod-run/` 目录（含 prod 密钥）会保留，可自行删除。

---

## 三、配置项（`.prod-run/flamecraft.env`）

| 变量 | 值 | 说明 |
|-|-|-|
| `FLAMECRAFT_AUTH_ENABLED` | `true` | 开启 IAM 认证 |
| `FLAMECRAFT_IAM_BASE_URL` | `https://drplatform-backend.deeproute.cn/drauth` | **prod** IAM |
| `FLAMECRAFT_IAM_CLIENT_ID` | `flamecraft-oauth` | 由 IAM 管理员注册 |
| `FLAMECRAFT_IAM_CLIENT_SECRET` | *(prod 密钥)* | 仅存本文件，勿入库 |
| `FLAMECRAFT_EXTERNAL_URL` | `https://flamecraft.srv.deeproute.cn` | 必须与 IAM 注册回调一致 |
| `FLAMECRAFT_SESSION_SECRET` | `openssl rand -hex 32` | ≥32 字节；变更会使所有人重新登录 |
| `FLAMECRAFT_INTERNAL_TOKEN` | `openssl rand -hex 32` | 内部自调用令牌 |
| `FLAMECRAFT_HTTP_ADDRESS` | `127.0.0.1:7070` | 只经 nginx 对外 |

**`DRFILE_ENDPOINT` 必须显式指定**（留空会踩「集群内部别名」的坑，见第七节）。

出站身份：**不设任何服务端备用凭据**（`DRFILE_API_TOKEN` / `DRFILE_USERNAME` 等一律不配）。  
出站请求一律使用登录用户的 IAM 令牌；无用户身份即 `drfile.ErrNoUserIdentity` 失败 ——  
这是预期行为，代表该用户对该资源没有权限。

> `DR_ACCESS_TOKEN` 只在 `FLAMECRAFT_AUTH_ENABLED=false`（纯本地开发）时生效。  
> AUTH=true 时会被**完全忽略**，若设置了只会在启动日志里打一条告警。

---

## 四、易错点：前端产物必须包含 SSO 代码

**这是最容易踩的坑。** 前端负责在页面加载时主动探测会话并跳转登录：

```ts
// ui/packages/app/web/src/index.tsx
installAuthRedirect();              // 任何 API 返回 401 → 跳 /auth/login
if (!(await ensureAuthenticated())) // 主动探测 /auth/me，未登录即跳转
  return;
```

而前端产物是通过 `go:embed`**打进 Go 二进制**的（`ui/ui.go`）：

```go
//go:embed packages/app/web/build
var FS embed.FS
```

所以如果 `ui/packages/app/web/build/` 是**旧的**（不含 auth 代码），  
即使后端认证配置完全正确，浏览器打开首页也**不会跳转 SSO** ——  
因为运行的 JS 里根本没有跳转逻辑。

**现象**：`/auth/status` 返回 `enabled: true`、`/auth/login` 手动访问能正常 302，  
但直接打开首页停在未登录状态、接口 401 却不跳登录页。

**判定方法**：检查实际服务的 JS 里有没有 auth 代码

```bash
JS=$(curl -s https://flamecraft.srv.deeproute.cn/ | grep -o 'assets/[^"]*\.js' | head -1)
curl -s "https://flamecraft.srv.deeproute.cn/$JS" -o /tmp/served.js
grep -a -o -F '/auth/login' /tmp/served.js | wc -l   # 0 = 产物是旧的，需要重建
```

**修复**：重新构建前端并重新编译二进制（`go:embed` 才会打入新产物）

```bash
./.prod-run/run.sh build && ./.prod-run/run.sh start
```

> `build` 会自动保留 `ui/packages/app/web/build/keep.go`（embed 占位文件），  
> 等价于 `make ui/build` + `make go/bin`。

---

## 五、手动操作步骤（不用脚本时）

```bash
cd /sandbox/FlameCraft

# 1. hosts 拦截
sudo tee -a /etc/hosts <<'EOF'
127.0.0.1 flamecraft.srv.deeproute.cn
EOF
getent hosts flamecraft.srv.deeproute.cn     # 应显示 127.0.0.1

# 2. 自签证书（SAN 必须含该域名）
mkdir -p .prod-run/tls && cd .prod-run/tls
openssl req -x509 -nodes -newkey rsa:2048 -days 365 \
  -keyout server.key -out server.crt \
  -subj "/CN=flamecraft.srv.deeproute.cn" \
  -addext "subjectAltName=DNS:flamecraft.srv.deeproute.cn,IP:127.0.0.1"
cd ../..

# 3. nginx：443 TLS 终止 → 127.0.0.1:7070（配置见 run.sh setup 生成的内容）
sudo nginx -t && sudo systemctl start nginx

# 4. 证书装入系统信任库（可选，避免浏览器告警）
sudo cp .prod-run/tls/server.crt /usr/local/share/ca-certificates/flamecraft-local-prod.crt
sudo update-ca-certificates

# 5. 构建 + 启动
./.prod-run/run.sh build
set -a; source .prod-run/flamecraft.env; set +a
setsid nohup ./bin/flamecraft > .prod-run/server.log 2>&1 &
```

恢复：

```bash
# 停服务
pkill -f 'bin/flamecraft'
# 删 hosts 行
sudo sed -i '/flamecraft.srv.deeproute.cn/d' /etc/hosts
# 删 nginx 配置
sudo rm -f /etc/nginx/conf.d/flamecraft.conf && sudo systemctl reload nginx
# 删信任证书
sudo rm -f /usr/local/share/ca-certificates/flamecraft-local-prod.crt && sudo update-ca-certificates --fresh
```

---

## 六、核验清单

`./.prod-run/run.sh verify` 覆盖以下各项，也可手动逐条执行：

| # | 检查项 | 期望 |
|-|-|-|
| 1 | `getent hosts flamecraft.srv.deeproute.cn` | `127.0.0.1`（拦截生效） |
| 2 | `curl https://flamecraft.srv.deeproute.cn/healthz` | `200`，且无证书告警 |
| 3 | `curl https://flamecraft.srv.deeproute.cn/auth/status` | `{"enabled":true,...}` |
| 4 | 匿名访问 `/api/trips`、`/metrics`、`/debug/pprof/` | `401` |
| 5 | 匿名访问 `/`（静态 UI） | `200` |
| 6 | `curl -D - https://flamecraft.srv.deeproute.cn/auth/login` | `302` 到 drauth，`redirect_uri` 与注册值一致 |
| 7 | 跟随上一步 | `302` 到 `iam.deeproute.cn/#/signin?...` |
| 8 | 实际服务的 JS 含 `/auth/login`、`/auth/me` | 均 ≥1（否则见「四、易错点」） |

最后一步人工确认：浏览器打开 [**https://flamecraft.srv.deeproute.cn**](https://flamecraft.srv.deeproute.cn)，  
应自动跳 SSO；登录后右上角显示当前用户，`/auth/me` 返回你的 `sub` / `name`。

> 若浏览器里 `enabled` 仍为 `false`，先确认你笔记本的 hosts 已改（见第一节  
> 「关键前提」），并在浏览器里核对 `APP_VERSION` 是 `dev`（沙箱实例）而不是 `v1.9.8`（真实 LB）。

---

## 七、常见问题

**Q：打开首页不跳登录页，但 `/auth/login` 手动访问正常？**  
A：前端产物是旧的（不含 SSO 代码）。见「四、易错点」，执行 `./.prod-run/run.sh build`。

**Q：登录回跳后报 `redirect_uri` 不匹配？**  
A：`FLAMECRAFT_EXTERNAL_URL` 与 IAM 注册值不一致，或 hosts 拦截没生效  
（回跳打到了真实 LB）。检查 `getent hosts` 是否为 `127.0.0.1`。

**Q：浏览器提示证书不受信任？**  
A：没执行「装入系统信任库」那步（`run.sh setup` 的第 4 步），或浏览器未重启。

**Q：取数报「无登录用户身份」/ 401？**  
A：出站一律用登录用户的 IAM 令牌，没有服务端兜底。若已登录仍失败，  
说明**你本人对该 Trip / 命名空间没有权限** —— 这是预期结果。

**Q：`/api/trips` 返回 401 是正常的吗？**  
A：未登录时正常且预期。受保护路径包含 `/api/`、`/metrics`、`/debug/`。

**Q：日志报 `lookup dataocean-file-galaxy ... server misbehaving`？**  
A：`DRFILE_ENDPOINT` 留空了，必须显式指定（见第七节）。

**Q：沙箱里 `/auth/status` 是 `true`，浏览器里却是 `false`？**  
A：你的浏览器没走沙箱实例，打到了真实 LB（`10.3.8.101`，v1.9.8 且未开认证）。  
hosts 必须改在**浏览器所在的那台机器**上，见「一、为什么需要域名拦截 → 关键前提」。

**Q：`./.prod-run/run.sh verify` 全过，但浏览器还是不跳转？**  
A：`verify` 是在沙箱内自测的，只能证明沙箱实例正常。浏览器侧要另外确认两件事：  
① 笔记本 hosts 指向沙箱；② 打开页面后 `APP_VERSION` 显示 `dev`（而非 `v1.9.8`）。

**Q：为什么不能用 `http://localhost:7070` 测 SSO？**  
A：该 OAuth 客户端注册的回调是 `https://flamecraft.srv.deeproute.cn/auth/callback`，  
用 localhost 会导致 `redirect_uri` 不匹配。stg 客户端注册的是  
`http://localhost:7070/auth/callback`，如需本地免拦截测试可改用 stg 客户端。

---

## 八、坑：`DRFILE_ENDPOINT` 留空 → 解析 `dataocean-file-galaxy` 失败

### 现象

```
level=warning msg="Post \"http://dataocean-file-galaxy/file-galaxy/namespace/listFiles\": dial tcp: lookup dataocean-file-galaxy on 127.0.0.53:53: server misbehaving, Attempt 4"
level=info msg="cannot list logs dir for heap dumps" path=/YR-P01T-8_20260918_142215/logs err="...server misbehaving"
```

Trip 分析会在「列 profiler/日志文件」这一步失败，进而找不到 heap dump 等数据。

### 根因：DrFile SDK 把 file-galaxy 的地址**硬编码**成集群内部别名

`vendor-deps/drfile-sdk-go-v2/drfile/modules/filegalaxy/namespace_api.go` 里写的是：

```go
apiListFiles = `@POST(url="http://dataocean-file-galaxy/file-galaxy/namespace/listFiles")`
```

`dataocean-file-galaxy` 是**集群内部的服务别名**，只在 DR 平台的 k8s 集群里可解析；  
开发机/容器里必然解析失败（NAMESERVER 直接 SERVFAIL）。

这些硬编码 host 只有在 `Configuration.Endpoint`**非空**时才会被改写。  
关键代码在 `drfile/modules/drhttp/drhttp.go`：

```go
func (c *DrHttp) FormatEndpointUrl(url string) string {
    endpoint := c.metadata.Config.Endpoint
    if drconfig.IsInternalEnpoint(c.metadata.Config.Endpoint) {
        endpoint = ""            // 内网互相调用：刻意不改写 host
    }
    u, err := BuildApiEndpoint(url, endpoint)
    ...
}
```

而 `BuildApiEndpoint(api, "")` 在 endpoint 为空时**什么都不做**，直接返回原 URL。  
实测三种取值（`go test` 验证）：

| `DRFILE_ENDPOINT` | 最终请求地址 |
|-|-|
| `""`（留空） | `http://dataocean-file-galaxy/file-galaxy/...` ← **解析失败** |
| `https://drplatform-backend.deeproute.cn` | `https://drplatform-backend.deeproute.cn/file-galaxy/...` ✅ |
| `drplatform-backend.deeproute.cn` | `http://drplatform-backend.deeproute.cn/file-galaxy/...` ✅ |

> 启动日志里可以确认是否生效：  
> `msg="Configuration {endpoint: https://drplatform-backend.deeproute.cn, ...}"`  
> 若 `endpoint:` 后面为空，就是这个坑。

### 修复

```bash
# .prod-run/flamecraft.env
DRFILE_ENDPOINT=https://drplatform-backend.deeproute.cn
```

改完重启：`./.prod-run/run.sh stop && ./.prod-run/run.sh start`

重启后确认：

```bash
grep "Configuration {" .prod-run/server.log | tail -1   # endpoint 非空
grep -c dataocean-file-galaxy .prod-run/server.log       # 不再新增
```

### 排查提示

此前的<cite doc-id="WVotdBqE9o2G9MxcCNPcdZEcnsb" file-type="docx" title="出站用户身份" type="doc"></cite>已提醒过这一点：

> 建议显式指定端点：留空时 SDK 可能走集群内部别名（dataocean-file-galaxy），容器内未必可解析。

但仓库里那份 `.env` 示例把 `DRFILE_ENDPOINT` 留空了，容易照抄踩坑 —— 本地/容器  
部署请务必显式填写。
