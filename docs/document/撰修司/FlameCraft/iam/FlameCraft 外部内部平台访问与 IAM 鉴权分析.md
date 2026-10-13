---
title: "FlameCraft 外部内部平台访问与 IAM 鉴权分析"
date: 2026-09-22
description: "代码仓库：/sandbox/FlameCraft"
categories:
  - 撰修司
tags:
  - FlameCraft
---

# FlameCraft 外部内部平台访问与 IAM 鉴权分析

> 更新时间：2026-09-10  
> 适用分支：`feature/iam-auth`  
> 代码仓库：`/sandbox/FlameCraft`

## 1. 文档目的与前提

FlameCraft 是基于 Parca 改造的性能分析平台。它本身不产生完整的车端性能数据，而是接收用户指定的 Trip、Driver、Release 等业务对象，从公司内部的 DR Platform、ADAS Farm、Artifacts、Driver Factory 和内部对象存储中读取数据，在 FlameCraft 服务端完成下载、解析、符号化、入库和对比展示。

本文回答四个问题：

1. FlameCraft 具体依赖哪些公司内部平台；
2. 每个平台在业务流程中提供什么数据，以及这些数据如何被使用；
3. FlameCraft 当前的鉴权边界是什么，接入 IAM 后哪些链路仍未自动贯通；
4. 后续是否需要各平台团队协作，DrFile 是否必须从旧 SDK 迁移到 REST API。

本文中的“外部平台”是指 FlameCraft 进程之外的平台，不是互联网不可信平台。下载的 profile、日志、Driver 包和业务元数据均来自公司内部系统。本文不把“内部平台下载”定义为不安全行为，也不以“所有内部请求都必须使用用户 IAM token”为前提。

接入 IAM 的主要价值是统一用户 SSO、明确服务身份和用户身份的边界、减少个人账号依赖、支持权限审计和凭据轮换，并保证 stg/prod 的配置隔离。某个平台如果已经有稳定的服务账号、S3 原生凭据或网络级信任模型，不应为了形式统一而强行改成 Web 用户 IAM。

## 2. FlameCraft 的业务定位

FlameCraft 面向自动驾驶性能分析，核心对象是一次车端或系统运行记录，即 Trip。Trip 中包含不同采集器产生的 profiler 文件、heap dump、驾驶模式日志和其他运行日志。分析人员希望通过 Trip 名称直接得到：

- CPU 火焰图；
- Off-CPU 火焰图；
- 内存/Heap 快照和内存泄漏对比；
- 进程、线程、函数热点和时间范围；
- 驾驶模式（例如 NCA、ACC、ICA、APA）对应的时间区间；
- 与该 Trip 实际运行环境匹配的 Driver、BSP 和符号信息；
- 不同 Milestone/Release/Driver 版本之间的性能差异。

因此，FlameCraft 的数据处理不是单次简单的文件下载，而是一条关联链：

```text
Trip 名称
  -> Pipeline 查询 Trip 元数据
  -> 确定 Driver 版本、车型、架构和运行时间
  -> 查询 Artifacts 或 S3 获取 Driver 包及校验信息
  -> 从 DrFile 下载 profiler、heap、BLC 等文件
  -> 下载/解压 Driver，生成符号索引
  -> 解析并写入 FlameCraft Profile Store
  -> 查询火焰图、热点、快照和差异
```

Release 对比是另一条入口：

```text
Driver Factory
  -> Project / Milestone / Release
  -> Release 中的 Driver 包和关联 Trip
  -> Pipeline 补充 Trip 信息
  -> FlameCraft 批量分析 Trip
  -> Profile Store 生成版本对比结果
```

## 3. 当前认证边界

### 3.1 用户到 FlameCraft

当前 FlameCraft 已接入 DeepRoute IAM（drauth）的 OAuth/OIDC 登录：

- `/auth/login` 发起 Authorization Code 流程；
- `/auth/callback` 交换 code，并优先使用 OIDC `id_token` 建立 FlameCraft session；
- Web session cookie 保存经过验证的用户身份，不直接保存 OAuth access token；
- `/api/`、`/metrics`、`/debug/`、原生 gRPC 和 gRPC-Web 请求由服务端中间件保护；
- `/healthz` 保持公开，供容器和负载均衡探活；
- CLI 或其他 API 客户端可以通过 `Authorization: Bearer <token>` 访问；
- MCP 不在本文后续改造范围内，当前不维护 MCP 接入。

相关代码：

- IAM client
- IAM handler
- IAM middleware
- HTTP 服务注册

### 3.2 FlameCraft 到下游平台

当前系统的实际身份模型并不是一个统一的“用户 IAM token 向下游透传”模型：

```text
浏览器用户 --IAM SSO--> FlameCraft
                         +--> DrFile：旧 SDK 的用户名/密码登录并缓存 SDK token
                         +--> Pipeline：当前 HTTP 请求不带认证头
                         +--> Artifacts：专用 token，或用户名/密码换 token
                         +--> Driver S3：当前直接 GET/List，代码未带 S3 Authorization
                         +--> Driver Factory：当前 HTTP 请求不带认证头
                         +--> Profile Store/对象存储：基础设施服务凭据
                         +--> Debuginfod：配置的 upstream HTTP 服务
```

这意味着 FlameCraft 登录成功，只能证明“用户可以进入 FlameCraft”。它不会自动让 DrFile、Pipeline、Artifacts 或 Driver Factory 识别这个用户，也不会把浏览器 session cookie 变成下游可接受的 Bearer token。

更重要的是，Trip 分析入口返回任务后，处理过程在后台 goroutine 执行，当前代码在分析管线内部使用 `context.Background()`。即使请求上下文中曾经存在用户 Bearer token，也不能假设任务结束后该 token 仍然可用。因此异步分析默认更适合使用 FlameCraft 的服务身份，而不是依赖原始浏览器会话。

## 4. 端到端业务流程

### 4.1 Trip 自动分析

用户在首页输入 Trip 名称后，前端调用 `/api/trip/analyze`。后端创建异步任务，任务主要执行以下步骤：

#### 第一步：判断平台并列出 profiler 文件

FlameCraft 使用 DrFile 的 `trip` namespace 检查候选目录：

- `/{trip}/logs/perf_ebpf/cpu_tracker`：Linux CPU profiler 文件；
- `/{trip}/logs/perf_ebpf/sched_tracker`：Linux Off-CPU 文件；
- `/{trip}/logs/perf_collector/qnx_profiler`：QNX profiler 文件。

程序会根据文件后缀和文件名前缀筛选 `.tmp`、`.zst`、`.folded` 等文件，去重并根据用户提供的时间范围过滤。这里拿到的是“有哪些可以分析的原始采样文件”，还没有真正读取 profile 内容。

#### 第二步：确定并准备 Driver

FlameCraft 调用 `GetDriverPackageByTripNameWithContext` 获取与 Trip 匹配的 Driver 包。当前实现的优先顺序是：

1. 调用 Pipeline 查询 Trip 信息，拿到 `driverVersion`、`shortnameVersion`、`archType`、车型、运行位置和时间范围；
2. 根据 Driver 名称、版本、shortname、架构和 delivery 类型组装 S3 key 前缀，尝试列举 Driver 包；
3. 如果 S3 找到包，则再调用 Artifacts API 尽力补充 UUID、MD5、平台、车型、`baseImage` 和 `bspMiniVersion`；
4. 如果 S3 查找失败，再根据 Pipeline 返回的 Driver 版本调用 Artifacts Server 查询完整制品信息。

得到 Driver 包后，FlameCraft 会：

- 下载 zip 到 Driver cache；
- 只提取 ELF 可执行文件和动态库；
- 找到 Driver 内的二进制目录；
- 根据 ELF 符号生成压缩符号索引；
- 如果返回了 `baseImage`，尝试提取对应 BSP 系统库；
- 后续分析优先复用符号索引，减少重复下载和解压。

Driver 的作用不是作为业务展示数据，而是为 profile 中的地址或符号提供“地址到函数名”的映射。没有匹配 Driver 时，profile 仍可能被读取，但函数名解析、热点定位和火焰图可读性会明显下降。

#### 第三步：下载和解析 CPU/Off-CPU 文件

程序并行从 DrFile 下载候选 profiler 文件，必要时解压自定义 zstd 格式，识别 folded 或 Off-CPU 格式，然后把文件写入临时目录。解析时附加 `trip=<TripName>` 标签，并使用 Driver ELF 目录、BSP 库目录和生成的符号索引，将采样数据写入 FlameCraft 的 Profile Store。

之后 CPU、Off-CPU 查询就从 FlameCraft 自己的存储读取，不需要每次打开火焰图都重新下载 DrFile 文件。DrFile 的主要职责是获取原始数据，FlameCraft 的主要职责是解析、索引、存储和查询。

#### 第四步：下载和解析 Heap 文件

如果用户选择内存分析，程序会先列出 `/{trip}/logs`，寻找 `heap_dump*` 目录，再列出其中的 `.heap` 文件。每个文件包含一个进程在某个时间点的堆快照。

FlameCraft 下载 heap 文件后解析进程名和快照时间，将 heap 数据转换成 pprof 形式，并带上：

- `__name__=heap_memory`；
- `comm=<进程名>`；
- `trip=<TripName>`。

然后写入 Profile Store。这样前端可以按时间点导出 heap 火焰图，或比较两个快照来分析内存增长。

#### 第五步：解析 BLC 驾驶模式日志

如果用户请求驾驶模式，程序从 `/{trip}/logs/blc` 查找 `blc.log.INFO.*` 文件，下载到内存并解析模式切换事件，保存为 FlameCraft 本地的 Trip modes 文件。它用于在前端显示某段时间属于哪种驾驶模式，也可帮助分析人员把性能异常与驾驶模式联系起来。

#### 第六步：查询和可视化

分析入库后，前端通过 FlameCraft 自身的 Query API 查询：

- CPU/Off-CPU merge；
- 单点 profile；
- 两个时间点的 diff；
- Heap in-use/allocated bytes 或 objects；
- 热点函数和时间线。

这些查询主要访问 FlameCraft 本地 Profile Store 和 Query Engine，而不是重复调用 DrFile。对应代码：Trip 分析管线。

### 4.2 手动 profile/Driver 分析

FlameCraft 也支持手动上传 profile 文件，或选择本地 Driver 目录、Driver 文件和内部 S3 URL。此类流程不一定访问 DrFile：profile 文件可以来自用户上传或本地目录，Driver 可以来自用户上传或已经挂载的目录。

如果用户提供内部 Driver URL，服务端会直接下载并用于符号化。该入口仍然是 FlameCraft API，开启 IAM 后由 FlameCraft 登录保护。当前 `DownloadDriverPackageByURL` 接受调用方传入的 URL；这不是公司内部平台不可信的问题，而是服务配置和业务边界问题。正式环境应由平台允许列表、签发的下载地址或服务端配置约束 URL 来源，避免业务调用随意改变数据源。

### 4.3 Milestone/Release 对比

前端的 Milestone 对比页面通过 FlameCraft `/api/df/*` API 使用 Driver Factory 数据：

1. 获取 Project 列表；
2. 根据 Project 获取 Milestone；
3. 根据 Milestone 获取 Release；
4. 获取 Release 的 pipeline 和 task，解析其中的 Driver 包全名、车型和平台；
5. 如果 Release pipeline 没有完整 Driver 信息，则按 Milestone 和 Release 名称构造包名前缀，查询 Driver Factory 的 Driver infos；
6. 根据 Driver 版本批量查询 Driver overview，提取关联的 Trip 列表；
7. 前端再通过 Pipeline 搜索 Trip，确认哪些 Trip 已经入库；
8. 对未入库 Trip 发起批量分析；
9. 从 FlameCraft Profile Store 查询并展示两个 Release 的性能指标差异。

Driver Factory 在这个流程中提供的是“版本发布和 Driver 关联关系”，不是 profiler 原始数据。Pipeline 提供的是“Trip 的业务元数据和搜索能力”，DrFile 提供的是“Trip 目录中的实际文件”。三者互相不能简单替代。

相关代码：

- Driver Factory client
- Driver Factory proxy routes
- Milestone 对比页面调用

### 4.4 符号解析和 Debuginfod

如果本地 Driver 或 BSP 库中缺少某个 Build ID 对应的调试信息，Parca/FlameCraft 的 debuginfo 流程会查询本地元数据和缓存，再通过配置的 Debuginfod upstream 请求 `/buildid/<buildid>/debuginfo` 或 source，最后把成功下载的内容缓存到对象存储。

Debuginfod 是“按 Build ID 获取调试信息”的基础设施数据面，不是 Trip 业务数据源。是否需要用户级 IAM 取决于 Debuginfod 平台是否按用户或租户隔离数据。当前代码把它作为配置的服务端 upstream 使用。

## 5. 平台逐项分析

### 5.1 DR Platform / DrFile

#### 业务作用

DrFile 是 FlameCraft 最核心的数据源，保存 Trip 目录及其原始采集文件。FlameCraft 通过它完成：

- 列出 Trip 下的 profiler 目录和文件；
- 下载 CPU、Off-CPU、Heap、BLC 等原始文件；
- 查询或操作 namespace、目录和文件；
- 搜索、上传、下载 Bag；
- 在需要时读取或写入 Trip 相关文件。

当前 FlameCraft 暴露了 `/api/drfile/*`，其中既包含只读接口，也包含上传、移动、删除、命名空间权限和事件发布等能力。Trip 自动分析主要使用只读的 List/Download 路径，但模块整体权限范围比自动分析更大。

#### 当前实现

FlameCraft 使用 vendor 中的 `drfile-sdk-go`：

- SDK 登录接口是 `POST /api/user/login`；
- SDK 配置要求 `Username` 和 `Password`；
- SDK 登录后把返回的 `accessToken` 保存在内部 `DrHttp.auth`；
- 后续需要认证的请求由 SDK 自动设置 `Authorization: Bearer <SDK token>`；
- SDK 自身有 token 过期判断和重新登录逻辑；
- FlameCraft 的 `WithContext` 包装方法多数只是调用 SDK 方法，没有把请求 context 继续传到 SDK 的调用链。

当前 vendor 源码没有发现公开的“直接注入外部 Bearer token”或“替换认证 transport”的 API。SDK 的配置校验也将用户名和密码作为认证前提。相关位置：

- FlameCraft DrFile client
- FlameCraft DrFile 配置
- vendor SDK auth.go
- vendor SDK drhttp.go

#### 是否必须接入 IAM

不应简单地得出“FlameCraft 已接 IAM，所以 DrFile 必须马上改成 IAM token”。需要先确认 DrFile 的权限语义。

**方案 A：DrFile 继续使用 FlameCraft 服务身份。**

这是当前 Trip 异步分析最容易落地的方案。为 FlameCraft 注册 stg/prod 分离的服务账号、服务 token 或 client credentials，FlameCraft 通过 DrFile SDK 使用该身份。用户权限由 FlameCraft IAM 控制，DrFile 侧记录的是 FlameCraft 服务身份。

适用条件：FlameCraft 对 Trip 数据是统一的只读分析服务，不要求 DrFile 按每一个 Web 用户做二次授权，并且服务账号可以获得当前业务需要的最小权限。

**方案 B：DrFile 支持 IAM 用户委托或 OBO。**

如果要求 DrFile 按用户权限判断 Trip 是否可读，需要 DrFile 或 IAM 平台提供 token exchange/OBO 能力。FlameCraft 不能用自己的 session cookie 代替 DrFile token，也不能仅凭 session 中的用户名重新构造一个合法的 IAM access token。

**方案 C：升级 SDK 或维护 SDK 分支。**

如果 DrFile 平台已经支持 IAM token，但旧版 SDK 只支持用户名密码，优先询问 SDK 维护者是否有新版本、分支或配置选项支持传入已有 Bearer token、自定义 token provider、HTTP transport 或 OBO token exchange。若新 SDK 仍然没有这些能力，应由 DrFile SDK 团队提供一个小版本，而不是 FlameCraft 私自修改 vendor 内部字段。

**方案 D：改用 DrFile REST API。**

只有在 DrFile 团队明确提供与现有 SDK 功能对应的稳定 REST API，且 REST API 已接入 IAM 或支持平台认可的服务身份，并明确 List、Head、Download、Bag、Namespace、分页、错误和大文件下载协议时，才建议 FlameCraft 自己实现 REST client。

直接切 REST 的成本不只是替换登录接口。现有 SDK 还负责 DrFile API 封装、S3/存储介质选择、文件传输、批量下载、重试、trace header 和响应模型。若只为支持 IAM 而把全部能力重写成 REST，容易产生行为差异。更优先的顺序是：新 SDK > SDK 增加 Bearer/token provider > FlameCraft 自建 REST 适配层。

### 5.2 DR Platform Pipeline

#### 业务作用

FlameCraft 使用 Pipeline 的 `POST /dr-pipeline/trip/query/highLevel` 查询 Trip 元数据，当前封装了按 Trip 名称精确查找、按条件分页搜索、`driverVersion`、`shortnameVersion`、车型/车辆 ID、架构类型、位置、开始/结束时间和状态。

这些字段决定 FlameCraft 去哪里找 profiler 文件、下载哪一个 Driver、使用哪种架构映射，以及在前端显示哪些业务信息。

#### 当前实现与后续判断

FlameCraft 自己创建 HTTP client，请求只设置 `Content-Type` 和 `Accept`，当前没有 Bearer、DRPAT 或服务 token。默认 endpoint 是内部 DR Platform 地址，也可以由 `DRFILE_PIPELINE_ENDPOINT` 配置。相关代码：pipeline_api.go。

需要 Pipeline 团队确认该接口是内部网络可访问的公开只读接口，还是已经由 drauth 网关保护；如果保护，需确认接受的 token 类型、audience、scope 以及 stg/prod 入口。

如果 Pipeline 是内部统一只读查询接口，可以继续使用服务身份或现有网络信任，不必为了与 FlameCraft Web 登录看起来一致而改动。若 Pipeline 需要按用户授权，则增加用户委托或服务身份注入。

### 5.3 ADAS Farm / Artifacts Server

#### 业务作用

Artifacts Server 提供 Driver 制品元数据和下载信息，包括 Driver UUID、包名和版本、zip 大小、下载地址、MD5、车型、平台、架构、发行版、delivery 状态、构建来源、创建时间、`baseImage` 和 `bspMiniVersion`。其中 `baseImage` 和 `bspMiniVersion` 会影响 BSP 系统库准备，MD5/大小可用于制品确认，下载地址供 Driver cache 使用。

#### 当前实现与后续判断

当前调用链为：

```text
POST https://adas-farm.srv.deeproute.cn/authApi/api/v1/auth/login
GET  https://prod-artifacts-server.srv.deeproute.cn/api/v1/packages/drivers
```

配置优先使用 `DRFILE_ARTIFACTS_TOKEN`，否则使用 `DRFILE_ARTIFACTS_AUTH_USERNAME`/`DRFILE_ARTIFACTS_AUTH_PASSWORD`，再回退到 DrFile 的用户名/密码。token 在进程内缓存，收到 401 后清除并重新获取。Artifacts 请求的 `Authorization` 格式遵循当前平台返回 token 的既有约定，不能仅凭标准 OAuth 假设直接修改。

Artifacts 查询通常是后台分析准备动作，推荐优先采用 FlameCraft 服务身份或专用的制品读取身份，而不是让 FlameCraft 长期保存个人 ADAS Farm 密码。只有当制品权限必须跟随 Web 用户时，才需要 OBO 或用户委托。

需要 Artifacts/ADAS Farm 团队确认：是否支持 drauth access token 或 DRPAT、OAuth client credentials、服务身份的最小读取权限、token 过期/刷新方式，以及返回的 `downloadUrl` 是否已经是带签名或带平台身份的地址。

### 5.4 Driver S3 / 对象存储

FlameCraft 维护了一套直接从内部 S3 查找 Driver 包的备用路径。它根据 Pipeline 的 Trip 信息解析 shortname、Ubuntu 路径、`arm64`/`amd64` 架构、`delivery`/`non-delivery` 类型、Driver 名称和版本，然后在 `prod-artifacts` bucket 的 `drivers/strip` 前缀下列举对象，找到 `.zip` 后组装下载 URL。

当前配置的内部 endpoint 是 `s3-bigdata-ssd-16.deeproute.cn:9000` 和 `ota-ssd-01.deeproute.cn:9000`。S3 直接路径速度较快，但不携带 BSP 信息，且当前实现没有 S3 Authorization header。

S3 是数据面，不必默认改成 IAM。需要对象存储团队确认 bucket 的权限来源、access key/临时签名 URL/IAM federation 能力、下载 URL 有效期、对象列表和读取权限是否分离，以及 stg/prod bucket 是否分离。如果使用 S3 原生 access key 或 presigned URL，FlameCraft 应继续使用对象存储原生方式，并按服务端数据面凭据管理。

### 5.5 Driver Factory

Driver Factory 负责版本发布和 Driver 关联信息，支撑 Milestone 对比页面：查询 Project、Milestone、Release、Release pipeline/task、Driver package infos、Driver overview、系统性能和子模块性能 histogram、primitive metrics 对比，以及 Release 关联 Trip。

Release task 中的 `driver_full_name` 会被解析成 `packageName=version`，再用于和 Driver 包、Trip、Profile Store 数据关联。Driver Factory 是“版本和实验样本选择器”，不是原始 profile 数据存储。

FlameCraft 将 Driver Factory 代理为 `/api/df/*`。client 当前请求 `/api/v1/projects`、项目下的 milestones/releases、Driver infos、driver overview、sys-perf、submodules-perf 及 `/api/v2/gating/driver_primitive_metrics/compare`，请求只设置 JSON header，没有认证头。FlameCraft IAM 保护了 `/api/df/*` 入口，但 Driver Factory 看到的仍是 FlameCraft 的无身份请求。

需要 Driver Factory 团队确认统一网关、服务身份和用户授权方式。若数据只由 FlameCraft 统一只读展示，建议使用 FlameCraft 服务身份；若权限和审计必须落到具体用户，则增加用户委托或 OBO。

### 5.6 FlameCraft Profile Store 和对象存储

Trip 分析完成后，原始 profile 被转换为内部 profile 表数据，前端火焰图、热点和 diff 查询都从 Profile Store 读取。部署还使用对象存储支持 FrostDB block 持久化、debuginfo 缓存和 Debuginfod source/debuginfo 缓存。

这些是 FlameCraft 服务自身的基础设施连接，不是最终用户直接调用的业务 API。推荐使用服务账号、S3/GCS 原生凭据或现有 Profile Store token，不要把浏览器用户 IAM token 传播到所有内部基础设施。只有未来存在用户、项目或租户级数据隔离时，才需要重新设计租户上下文和 OBO。

### 5.7 Debuginfod

Debuginfod 根据 Build ID 提供 ELF debuginfo 和源码，在 FlameCraft 找不到本地符号时被动调用并缓存结果。它提供的是通用符号化基础设施，不负责 Trip 关联和 Driver 版本选择。

当前 HTTP client 通过配置的 upstream server 发起 GET 请求，没有用户认证头。是否需要 IAM 取决于 Debuginfod 的平台策略；如果它是公司内部统一只读符号服务，服务端访问即可；如果按项目权限限制源码，则应由平台提供服务身份或 OBO 能力。

## 6. DrFile SDK 与 REST API 的具体判断

### 6.1 旧 SDK 为什么不能直接接收 IAM 登录结果

当前旧 SDK 的认证是封装在 SDK 内部的：

```text
Configuration.Username/Password
  -> DrHttp.Auth()
  -> POST /api/user/login
  -> DrHttp.auth.AccessToken
  -> SDK 请求自动设置 Authorization: Bearer <SDK token>
```

FlameCraft 的 OAuth 回调得到的是 IAM token 响应，且当前 session 只保存身份，不保存 access token。这个 token 与旧 DrFile `/api/user/login` 返回的 token 不是同一种凭据。即使两者都使用 HTTP `Authorization` 头，也不能假设 DrFile 会接受 IAM issuer/audience 的 token。

因此，当前 SDK 存在两个独立问题：

1. 它没有公开的外部 token 注入接口；
2. DrFile 服务端是否接受 IAM token 本身尚未确认。

只解决第一个问题并不能保证调用成功，必须同时确认 DrFile resource server 的 token 校验方式。

### 6.2 是否要使用新的 REST API

结论：**不是必然要改 REST，但必须和 DrFile 团队确认新的认证能力。**

推荐决策顺序：

1. 询问是否已有支持 IAM/service token/Bearer token 的新版 `drfile-sdk-go`；
2. 如果没有，询问是否可以在 SDK 增加 `WithBearerToken`、token provider 或自定义 transport；
3. 如果 SDK 团队不维护旧 SDK，确认是否有稳定 REST API，且 REST API 已支持目标认证模式；
4. 只有 REST API 的认证、权限、分页、文件传输和错误协议都明确后，才在 FlameCraft 增加 REST adapter；
5. 迁移期间保留旧 SDK 作为兼容路径，并用配置或 feature flag 选择新旧实现；
6. 完成 stg Trip 读取、profile 下载、heap 下载、BLC 下载和 Driver 关联回归后，再移除旧用户名/密码路径。

### 6.3 为什么不能只修改 FlameCraft 的 vendor SDK

直接在 FlameCraft 的 vendor 目录中改 SDK 内部字段会带来：SDK 升级时修改丢失、认证逻辑与平台协议难以同步、大文件传输/S3 映射/重试容易遗漏、其他系统无法复用以及排障困难等问题。

如果必须临时适配，应将适配封装在明确的接口后面，并把上下游协议写成测试，不要散落修改 vendor 内部实现。

## 7. 是否需要各平台团队协作

需要，但不是所有平台都要同时进行代码改造。协作目标是确认每条调用的身份模型和平台能力，然后由 FlameCraft 按模型接入。

### 7.1 必须协作的团队

| 团队 | 需要确认的内容 | 对 FlameCraft 的影响 |
|-|-|-|
| IAM 管理员 | OAuth client、issuer、audience、scope、服务身份、token exchange/OBO、stg/prod 配置 | 决定用户 SSO 和下游用户委托能否实现 |
| DrFile/DR Platform | IAM/DRPAT 是否可用、REST API、SDK 新版、权限映射、下载和大文件协议 | 决定继续 SDK、升级 SDK 还是写 REST adapter |
| Pipeline 团队 | `highLevel` 接口的认证要求、scope、stg/prod endpoint、限流 | 决定 Trip 元数据查询使用用户身份还是服务身份 |
| ADAS Farm/Artifacts 团队 | token 获取、Driver 包查询权限、下载 URL 身份、过期策略 | 决定是否保留专用 token/服务账号 |
| Driver Factory 团队 | API 网关、服务身份、用户授权、项目/Release 权限 | 决定 Milestone 对比是否需要下游用户审计 |
| 对象存储/制品存储团队 | bucket ACL、S3 access key、presigned URL、IAM federation、环境隔离 | 决定 Driver 包数据面采用何种凭据 |
| 基础设施/Parca 团队 | Profile Store、Debuginfod、对象存储服务账号及租户隔离 | 决定后台分析和符号缓存使用何种服务身份 |

### 7.2 不需要等所有团队完成后才做的工作

FlameCraft 可以先独立完成：

- 梳理下游 client 接口和统一 transport 抽象；
- 明确同步用户请求和异步后台任务的身份差异；
- 为 Bearer 注入、service identity、401 重试和 token 不落日志写单元测试；
- 保留旧 SDK/旧 token 的兼容配置；
- 将 endpoint、scope、audience 和环境配置外置；
- 为每个下游增加 httptest，不连接真实生产平台；
- 在 stg 上进行真实 Trip 只读回归。

但在平台团队确认协议之前，不应直接删除现有 DrFile 用户名/密码配置，也不应假设 IAM access token 可以代替 DrFile、Artifacts 或 S3 token。

## 8. 推荐目标架构

### 8.1 三种身份模型

每个下游平台都应明确属于以下一种模型：

#### 用户委托身份

适用于用户权限必须被下游识别的同步查询：

```text
用户 IAM token
  -> FlameCraft 验证
  -> IAM OBO/token exchange
  -> 下游 resource server token
  -> 下游按用户权限执行
```

#### FlameCraft 服务身份

适用于 Trip 异步分析、Driver 包准备、共享只读数据和后台任务：

```text
FlameCraft service identity
  -> DrFile/Pipeline/Artifacts/Driver Factory
  -> 平台按服务账号权限执行
```

这是当前异步分析最推荐的默认模型。

#### 原生数据面凭据

适用于 S3/GCS、Profile Store、Debuginfod 等基础设施：

```text
FlameCraft service
  -> S3 access key / presigned URL / native service credential
```

只有平台明确支持 IAM federation 时，才切换为 IAM token。

### 8.2 统一下游调用层

FlameCraft 后续可以增加统一的 downstream auth/transport 层，负责从请求上下文读取用户 Bearer（仅用于允许用户委托的平台）、为后台任务显式选择服务身份、注入下游需要的 Authorization 头或原生凭据、统一分类 401/403/过期错误、设置超时/重试/trace header、防止凭据进入日志，以及校验 stg/prod endpoint、audience、scope 和 bucket 成套配置。

这个层不能替平台决定认证协议。每个 client 仍然需要声明它使用的是 user-delegated、service-identity 还是 native-data-plane 模式。

## 9. 分阶段实施建议

### Phase 0：跨团队确认

优先顺序建议是 DrFile、Pipeline、Artifacts、Driver Factory、对象存储和 IAM 管理员。每个平台至少确认 endpoint、认证方式、audience/scope、用户委托或服务身份、读权限范围、token 有效期和刷新方式、stg 测试方式、兼容期和下线时间。

### Phase 1：DrFile 和 Pipeline

这是 Trip 自动分析的 P0 依赖。先解决 DrFile SDK 是否支持新 token、是否有新版 SDK、是否要使用 REST、Pipeline 是否需要认证，以及异步任务使用服务身份的实现方式。

验收内容：使用 stg 的真实 Trip 完成文件列举、CPU/Off-CPU 下载、heap 下载、BLC 下载、Driver 关联和 Profile Store 入库。

### Phase 2：Artifacts、S3 和 Driver Factory

统一 Driver 元数据、下载 URL、S3 bucket 和 Release 对比的环境配置，清理个人账号回退逻辑，增加服务身份或平台 token 的 stg 回归。

### Phase 3：Profile Store、对象存储和 Debuginfod

核对服务账号、secret rotation、缓存权限和是否存在用户级数据隔离需求。没有用户级隔离时，不把这些基础设施强行改成浏览器用户 IAM。

## 10. 需要向各团队提出的问题

### IAM 团队

- FlameCraft 的用户 access token 是否允许作为 DrFile、Pipeline、Artifacts 或 Driver Factory 的 resource token？
- 如果不允许，是否支持 OBO/token exchange？目标 audience 和 scope 是什么？
- 是否有 FlameCraft 的 stg/prod service client？client credentials 如何轮换？
- IAM issuer、JWKS、introspection 和 token endpoint 在 stg/prod 是否不同？

### DrFile 团队

- 当前 `drfile-sdk-go` 是否有支持 IAM/DRPAT/Bearer token 的版本或分支？
- 如果没有，是否计划增加 token provider 或自定义 transport？
- 是否提供支持相同文件、Bag、namespace 和传输能力的 REST API？
- REST API 的 endpoint、权限、分页、下载、限流和错误协议是什么？
- DrFile 是否支持 FlameCraft 服务身份？只读权限如何配置？
- Trip 异步分析是否可以使用服务身份，而不要求每次携带具体用户身份？

### Pipeline 团队

- `POST /dr-pipeline/trip/query/highLevel` 当前是否无需认证？
- 如果需要认证，接受哪类 token、需要哪些 scope？
- 服务身份是否可以查询 Trip 的 `driverVersion`、架构、位置、状态和时间？

### Artifacts/ADAS Farm 团队

- Artifacts 查询是否支持 IAM/service token？
- `downloadUrl` 是公开内部 URL、签名 URL，还是需要再次带 token？
- 是否有专用的只读 artifact-reader service identity？
- token 过期后应调用哪个刷新接口？

### Driver Factory 和对象存储团队

- Driver Factory 是否有统一网关和 service identity？
- Release、Driver overview 和 Trip 关联数据是否需要按用户权限审计？
- `prod-artifacts` 是否存在 stg 对应 bucket？
- S3 是否要求 access key、presigned URL 或 IAM federation？

## 11. 最终结论

1. FlameCraft 接入 IAM SSO 只完成了“用户进入 FlameCraft”的认证，不会自动完成所有下游平台的认证。
2. DrFile 是核心数据源，旧版 `drfile-sdk-go` 从源码看是用户名/密码登录模型，没有明显的外部 Bearer 注入能力；是否改 REST 取决于 DrFile 团队是否提供支持 IAM 的新版 SDK 或稳定 REST API。
3. Trip 自动分析是异步后台任务，默认应使用 FlameCraft 服务身份；如果必须保留用户权限，需要 IAM OBO/token exchange 和下游平台配合。
4. Pipeline、Artifacts、Driver Factory 当前也没有统一的 IAM 透传，必须逐个平台确认认证模型。
5. Driver S3、Profile Store、对象存储和 Debuginfod 属于数据面/基础设施，不必强行改成 Web 用户 IAM，应优先使用各平台的原生服务凭据。
6. 需要各平台团队协作确认协议和权限，但不需要所有平台同时改代码。FlameCraft 可以先做好统一调用抽象、配置隔离、兼容路径和单元测试。
7. MCP 已明确不在维护和改造范围内。
