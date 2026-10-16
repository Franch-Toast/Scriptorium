---
title: "perf-collector 启动阶段 Crash 分析报告"
date: 2026-10-15
description: "本次问题表现为 perf-collector 启动后立即 Crash 的分析报告。"
categories:
  - "秘藏龛"
tags: [crash分析]
---

# perf_collector 启动阶段 Crash 分析报告

## 1. 报告概览

| 项目 | 内容 |
| --- | --- |
| 故障对象 | `perf_collector` / `perf_collector_cpp` |
| 故障类型 | 启动阶段 `SIGABRT` / `abort()` |
| 分析日期 | 2026-10-15 |
| 堆栈文件 | `/sandbox/temp/1015_perf_collector_crash/crash_backtrace.txt` |
| 分析二进制 | `/sandbox/temp/1015_perf_collector_crash/opt/deeproute/perf-collector/bin/perf_collector_cpp` |
| 参考代码仓库 | `/sandbox/onboard_application/perf_collector` |
| 参考仓库版本 | 分支 `dev_master`，HEAD `ecb7db7` |
| 软件包信息 | `LP8797-V2-SHARE`，版本 `1.0.51583345` |
| 二进制 Build ID | `d52ea767ef84451166a96295a2137aa5` |
| 当前结论状态 | IPC 应用通道创建失败已确认；具体系统 errno 尚待现场日志确认 |

## 2. 背景与分析范围

本次问题表现为 `perf_collector` 启动后立即 Crash。输入材料包括：

1. QNX 现场生成的 crash backtrace；
2. 软件包中的 `perf_collector_cpp` 可执行文件；
3. `/sandbox/onboard_application/perf_collector` 源码仓库；
4. 本地 Church/iceoryx 源码，用于还原 IPC 初始化路径。

本报告覆盖以下内容：

- 将堆栈中的地址解析到 C++ 函数；
- 从二进制反汇编确认 iceoryx 错误码；
- 将调用链与 `perf_collector` 源码对齐；
- 分析应用 IPC channel 创建失败的可能原因；
- 给出现场确认项与代码改进方向。

本报告没有修改业务源码，也没有将某个具体 QNX errno 当作已确认事实。因为当前堆栈只保留了 iceoryx 的高层错误码，没有包含生成该错误码的 `socket()` / `bind()` 具体 errno。

## 3. 总结结论

### 3.1 已确认结论

该 Crash 不是业务采集线程中的内存访问异常，而是程序启动时创建 iceoryx 应用 IPC channel 失败：

```text
ReporterManager::initialize()
  -> churchNode("perf_collector_cpp")
  -> AddPublisher(..., ChannelType::ICEORYX)
  -> PoshRuntimeImpl
  -> IpcRuntimeInterface
  -> m_AppIpcInterface 初始化失败
  -> errorHandler(Error 142)
  -> std::terminate()
  -> abort()
  -> SIGABRT
```

错误码 142 对应：

```text
IPC_INTERFACE__UNABLE_TO_CREATE_APPLICATION_CHANNEL
```

iceoryx 默认 Fatal handler 对该错误执行 `std::terminate()`，所以程序没有机会返回到 `ReporterManager::initialize()`，`main()` 中原本用于降级的失败判断实际上无法生效。

### 3.2 尚未确认的部分

当前不能仅凭堆栈判断是以下哪一种现场条件导致 socket 创建或绑定失败：

- `/ramdisk` 不存在、未挂载或运行环境路径不匹配；
- `/ramdisk` 权限不足或文件系统只读；
- QNX `socket()` / `bind()` 资源不足；
- socket 路径、地址或文件系统状态异常；
- 并发启动或残留资源导致绑定冲突。

需要 crash 同时刻的 stderr/iceoryx 日志，或者现场执行检查命令，才能将原因进一步收敛到具体 errno。

## 4. 二进制与符号解析证据

### 4.1 ELF 基本信息

提供的目标文件为：

```text
ELF 64-bit LSB shared object, ARM aarch64
QNX interpreter: /usr/lib/ldqnx-64.so.2
Type: DYN（PIE）
not stripped
Build ID: d52ea767ef84451166a96295a2137aa5
```

二进制保留 `.symtab`，因此可以解析函数符号；但没有 `.debug_*` / DWARF 行号信息，因此无法仅凭该 ELF 精确定位到源码行。

堆栈中的进程路径为：

```text
/opt/map/data/oem/cache/tmp/dem/ln_binary/dr_perf_collector
```

分析使用的包内文件路径为：

```text
/opt/deeproute/perf-collector/bin/perf_collector_cpp
```

两者的函数偏移和调用逻辑能够对应，但现场运行文件与提供文件的路径名称不同。若需要确认是否为完全相同的构建，应在现场对实际运行文件执行 Build ID 校验。

### 4.2 关键堆栈符号

| 堆栈 | 地址偏移 | 解析结果 | 作用 |
| --- | ---: | --- | --- |
| #0 | libc `+0x50368` | `SignalKill` | 发送终止信号 |
| #1 | libc `+0x394f0` | `abort` | 进程主动终止 |
| #2 | libc++ `+0xde420` | `__verbose_terminate_handler` | C++ terminate 处理 |
| #3 | libc++ `+0xdba6c` | `__terminate` | 执行 terminate |
| #4 | libc++ `+0xdbad0` | `__unexpected` | C++ 异常运行时路径 |
| #5 | `perf_collector +0x100588` | `iox::ErrorHandler::defaultHandler(...)` | iceoryx 默认错误处理 |
| #6 | `perf_collector +0x33aeb4` | `iox::errorHandler(...)` | iceoryx 错误入口 |
| #7 | `perf_collector +0x340348` | `iox::runtime::IpcRuntimeInterface::IpcRuntimeInterface(...)` | 创建应用 IPC 接口 |
| #8 | `perf_collector +0x335e44` | `iox::runtime::PoshRuntimeImpl::PoshRuntimeImpl(...)` | 初始化 iceoryx runtime |
| #9 | `perf_collector +0xc416c` | `deeproute::church::node::Transport::FindOrCreateTransport(...)` | 查找/创建 Church transport |
| #10 | `perf_collector +0x330d44` | Church Publisher 创建路径 | 创建 Publisher |
| #11 | `perf_collector +0xa0d3c` | `ReporterManager::add_reporter(...)` | 添加 Reporter |
| #12 | `perf_collector +0xa1a34` | `ReporterManager::initialize()` | 初始化 ReporterManager |
| #13 | `perf_collector +0x37aa8` | `main` | 程序入口 |
| #14 | `perf_collector +0x41f70` | `_start` | 进程启动入口 |

原始堆栈中 #6、#7 显示的部分 `__cxa_throw` 是 QNX 展开器给出的近似符号，不是这两个栈帧的实际业务含义。结合 ELF 符号表和调用关系后，实际路径是 iceoryx 错误处理和 runtime 构造。

## 5. 错误码定位证据

对二进制中 `IpcRuntimeInterface` 相关代码反汇编后，在对应路径发现：

```asm
mov w0, #142
bl  iox::errorHandler(...)
```

本地 iceoryx 错误枚举定义位于：

`/sandbox/platform/church/third_party/iceoryx/iceoryx_hoofs/include/iceoryx_hoofs/error_handling/error_handling.hpp`

其中包含：

```cpp
error(IPC_INTERFACE__UNABLE_TO_CREATE_APPLICATION_CHANNEL)
```

对应 runtime 源码为：

`/sandbox/platform/church/third_party/iceoryx/iceoryx_posh/source/runtime/ipc_runtime_interface.cpp:36-40`

```cpp
if (!m_AppIpcInterface.isInitialized())
{
    errorHandler(Error::kIPC_INTERFACE__UNABLE_TO_CREATE_APPLICATION_CHANNEL);
    return;
}
```

默认 handler 位于：

`/sandbox/platform/church/third_party/iceoryx/iceoryx_hoofs/source/error_handling/error_handling.cpp:42-67`

其 Fatal 路径为：

```cpp
logger.LogError() << errorText;
assert(false);
std::terminate();
```

这解释了堆栈中的 `__terminate`、`abort` 和最终 `SIGABRT`。

## 6. perf_collector 源码调用链

### 6.1 `main()` 启动 ReporterManager

代码位置：

[`deep_os_tool_cpp/main.cc`](/sandbox/onboard_application/perf_collector/deep_os_tool_cpp/main.cc:269)

```cpp
std::shared_ptr<ReporterManager> reporter_manager =
    std::make_shared<ReporterManager>(monitor_conf);

if (!reporter_manager->initialize()) {
    MLOG(ERROR) << "Reporter 初始化失败";
    reporter_manager = nullptr;
}
```

代码设计意图是 Reporter 初始化失败后继续运行，但 iceoryx 的 Fatal error handler 在 `initialize()` 返回前直接终止进程，因此这里的降级逻辑无法处理本次故障。

### 6.2 `ReporterManager::initialize()` 创建 Church node

代码位置：

[`reporter_manager.cc:48-101`](/sandbox/onboard_application/perf_collector/deep_os_tool_cpp/common/reporter/reporter_manager.cc:48)

```cpp
church_node_ = std::make_shared<churchNode>("perf_collector_cpp");
```

随后遍历配置中的 reporters，逐个执行 `add_reporter()`。

### 6.3 `Reporter` 构造时创建 Publisher

代码位置：

[`reporter.h`](/sandbox/onboard_application/perf_collector/deep_os_tool_cpp/common/reporter/reporter.h:29)

```cpp
topic_name_ = config_->getTopic();
queue_size_ = config_->getQueueSize();
channel_type_ = config_->getChannelType();

church_node_->AddPublisher(topic_name_, queue_size_, channel_type_);
```

`AddPublisher()` 最终进入 Church 的 transport 创建路径，并触发 iceoryx runtime 初始化。

### 6.4 Church node 与 Publisher 的对应关系

代码位置：

[`churchNode.cc:8-16`](/sandbox/onboard_application/perf_collector/deep_os_tool_cpp/common/reporter/churchNode.cc:8)

```cpp
churchNode::churchNode(const std::string& name)
    : node_(std::make_shared<deeproute::church::node::Node>(name)) {}

void churchNode::AddPublisher(...) {
  node_->AddPublisher<dr::common::ModuleEvents>(...);
}
```

因此 runtime name 是：

```text
perf_collector_cpp
```

## 7. 配置证据

实际软件包配置：

`/sandbox/temp/1015_perf_collector_crash/opt/deeproute/perf-collector/bin/deep_os_monitor_orin.json`

配置中虽然：

```json
"tracer": false
```

但 `reporter_manager` 仍然存在，并配置了两个 Reporter：

```json
{
  "topic": "/common/module_events",
  "queue_size": 100,
  "trans_channel": 4,
  "batch_size": 60
}
```

```json
{
  "topic": "/perf_collector/module_events",
  "queue_size": 100,
  "trans_channel": 4,
  "batch_size": 60
}
```

代码中 `trans_channel` 的默认值也是 4：

[`reporter_config.h:31-33`](/sandbox/onboard_application/perf_collector/deep_os_tool_cpp/common/reporter/reporter_config.h:31)

```cpp
return getValue<int>("trans_channel").value_or(4);
```

Church 的 channel type 定义为：

```text
1 = ROS
2 = INTRA_PROCESS
3 = SHM
4 = ICEORYX
5 = ZMQ
```

所以本次启动必然会进入 iceoryx IPC 初始化，即使 tracer 功能关闭也不例外。

## 8. iceoryx IPC 创建路径

完整路径为：

```text
Church Publisher
  -> Transport::FindOrCreateTransport()
  -> PoshRuntimeImpl
  -> IpcRuntimeInterface
  -> IpcInterfaceCreator
  -> IpcInterfaceBase::openIpcChannel(SERVER)
  -> UnixDomainSocket::create()
  -> socket(AF_LOCAL, SOCK_DGRAM, 0)
  -> bind(...)
```

相关源码：

- `ipc_runtime_interface.cpp`：检查应用 IPC channel 是否初始化；
- `ipc_interface_creator.cpp:24-52`：创建应用侧 IPC interface；
- `ipc_interface_base.cpp:159-168`：调用 Unix domain socket 创建；
- `unix_domain_socket.cpp:366-423`：执行 `socket()` 和 `bind()`。

### 8.1 LP8797 QNX 路径

LP8797 QNX 平台配置位于：

`/sandbox/platform/church/third_party/iceoryx/iceoryx_hoofs/platform/qnx/include/iceoryx_hoofs/platform/platform_settings.hpp`

关键配置为：

```cpp
#if defined(DR_VEHICLE_LP8797_V1_SHARE) || defined(DR_VEHICLE_LP8797_V2_SHARE)
constexpr const char IOX_UDS_SOCKET_PATH_PREFIX[] = "/ramdisk/";
#endif

constexpr const char IOX_LOCK_FILE_PATH_PREFIX[] =
    "/opt/map/data/oem/cache/tmp/";
```

结合 runtime name，可以推导出现场重点检查对象：

```text
/ramdisk/perf_collector_cpp
/opt/map/data/oem/cache/tmp/perf_collector_cpp.lock
```

### 8.2 具体失败点的范围

Unix domain socket 初始化中：

```cpp
auto socketCall = socket(AF_LOCAL, SOCK_DGRAM, 0);
...
auto bindCall = bind(...);
```

失败后会转换为 `IpcChannelError`，最终只通过 `isInitialized() == false` 暴露给 `IpcRuntimeInterface`，再统一触发错误 142。

因此当前堆栈不能区分：

- `socket()` 失败；
- `bind()` 失败；
- 路径目录不存在；
- 权限/只读文件系统问题；
- FD、系统 socket 或内存资源不足。

## 9. 根因分析

### 9.1 直接根因

`perf_collector_cpp` 启动时创建 ICEORYX Publisher，iceoryx 无法创建应用侧 Unix domain socket channel，导致：

```text
IPC_INTERFACE__UNABLE_TO_CREATE_APPLICATION_CHANNEL
```

iceoryx 默认将其作为 Fatal 错误处理，调用 `std::terminate()`，最终导致 Crash。

### 9.2 最可能的现场原因排序

#### 1. `/ramdisk` 环境异常

LP8797 V2 SHARE 的构建配置将 iceoryx socket 放在 `/ramdisk/`。如果该目录没有创建、没有挂载，或者启动时机早于挂载完成，`bind("/ramdisk/perf_collector_cpp")` 会失败。

这是当前最优先的排查项。

#### 2. 权限或文件系统状态异常

运行用户可能没有对 `/ramdisk` 的写入/创建权限，或者文件系统处于只读状态。

#### 3. 系统资源不足

可能包括：

- 进程 FD 达到上限；
- 系统 FD 或 socket 资源耗尽；
- 内核 socket buffer / 内存不足；
- QNX 相关资源限制达到上限。

iceoryx 对 `EMFILE`、`ENFILE`、`ENOBUFS`、`ENOMEM` 等 errno 都会转化为 channel 初始化失败。

#### 4. 运行环境与构建平台不匹配

二进制是 LP8797 V2 SHARE 构建，期望 `/ramdisk/`；如果实际启动环境使用的是另一套目录布局，则会出现应用 IPC channel 创建失败。

#### 5. socket 残留或并发启动

Unix domain socket 创建前会尝试清理旧 channel，理论上可以处理非正常退出产生的残留文件。但如果存在并发启动、路径状态异常或绑定冲突，仍可能失败。

如果是 iceoryx runtime lock 被另一个同名进程持有，通常会先报：

```text
IPC_INTERFACE__APP_WITH_SAME_NAME_STILL_RUNNING
```

因此它不是当前错误码下的首要怀疑对象。

### 9.3 RouDi 是否是根因

从当前调用链看，应用侧 IPC channel 创建发生在连接 RouDi 之前：

```text
m_AppIpcInterface 创建
  -> 检查成功
  -> 才进入 RouDi IPC channel 和注册流程
```

所以不能把“RouDi 未启动”作为本次错误的直接根因。RouDi 状态仍值得检查，但即使 RouDi 正常，`/ramdisk` 或应用 socket 创建失败仍然会产生本次 Crash。

## 10. 代码设计问题与改进方向

### 10.1 初始化失败降级逻辑无法覆盖 Fatal 错误

`main()` 期望 `ReporterManager::initialize()` 返回 `false` 后继续运行，但 iceoryx 的默认 Fatal handler 在返回前终止进程。

因此以下逻辑对本故障无效：

```cpp
if (!reporter_manager->initialize()) {
    reporter_manager = nullptr;
}
```

改进方向：

- 在创建 Church/iceoryx runtime 前进行 IPC 环境预检查；
- 为可选上报功能设计非 Fatal 的错误处理路径；
- 让 Church 层能够将 iceoryx 初始化失败转换为可检查的失败状态；
- 只有在确认 Reporter 创建成功后再启动依赖 Reporter 的模块。

### 10.2 Reporter 初始化与 tracer 配置耦合不清晰

当前包中 `tracer=false`，但 ReporterManager 仍无条件初始化两个 ICEORYX Publisher。若业务上关闭 tracer 时不需要跨进程事件上报，应考虑：

- 关闭 tracer 时同步关闭不必要的 Reporter；或
- 使用明确的 `reporter_manager.enable` 配置；或
- 在 IPC 不可用时使用明确的降级策略。

是否可以关闭 Reporter，取决于其他监控模块是否依赖 `/common/module_events` 上报，不能直接删除配置而不验证功能影响。

### 10.3 配置默认值风险

`ReporterConfig::getChannelType()` 默认返回 4，即 ICEORYX：

```cpp
value_or(4)
```

这意味着配置字段缺失时也会自动依赖 iceoryx。若 IPC 是可选能力，默认值应改为经过明确设计的行为，而不是静默选择 Fatal 风险较高的传输方式。

## 11. 现场验证清单

请在问题车辆上重点收集以下信息。

### 11.1 目录、socket 与 lock

```sh
ls -ld /ramdisk
ls -l /ramdisk/perf_collector_cpp*
ls -l /opt/map/data/oem/cache/tmp/perf_collector_cpp.lock
```

关注：

- `/ramdisk` 是否存在；
- 所属用户、用户组和权限；
- 文件系统是否可写；
- 是否存在同名 socket；
- lock 文件是否被实际进程持有。

### 11.2 进程与 RouDi 状态

```sh
pidin ar | grep -E 'dr_perf_collector|perf_collector_cpp|dr_roudi'
```

关注：

- 是否存在多个 perf_collector 实例；
- 是否存在旧的 `dr_perf_collector`；
- `dr_roudi` 是否已经启动；
- 是否存在启动顺序或并发重启问题。

### 11.3 crash 同时刻日志

优先收集 stderr、启动日志和系统日志，搜索以下关键词：

```text
ICEORYX error
permission to create unix domain socket denied
unix domain socket already in use
process limit reached
system limit reached
out of memory
not a directory error
read only error
```

这些日志可以直接区分权限、路径、资源和地址冲突。

### 11.4 确认现场运行文件版本

对现场实际执行文件和提供的包内文件分别获取 Build ID，确认是否完全一致。当前堆栈中的运行路径和提供文件路径不同，不能仅凭文件名完成版本闭环。

## 12. 最终判断

本问题的故障链可以归纳为：

```text
LP8797 配置下需要创建 /ramdisk/perf_collector_cpp
              ↓
应用侧 iceoryx Unix domain socket 创建/绑定失败
              ↓
IpcRuntimeInterface 报 Error 142
              ↓
默认 iceoryx Fatal handler 调用 std::terminate()
              ↓
perf_collector_cpp 触发 abort / SIGABRT
```

因此当前最准确的结论是：

> perf_collector 在启动 ReporterManager、创建 ICEORYX Publisher 时，无法创建应用侧 IPC channel；iceoryx 默认 Fatal 错误处理将该初始化失败升级为进程终止。最优先检查 LP8797 运行环境中的 `/ramdisk` 挂载、权限、可写性及 socket/系统资源状态。具体 errno 仍需要现场 stderr 或系统日志确认。

## 13. 证据索引

- Crash 堆栈：`/sandbox/temp/1015_perf_collector_crash/crash_backtrace.txt`
- 分析二进制：`/sandbox/temp/1015_perf_collector_crash/opt/deeproute/perf-collector/bin/perf_collector_cpp`
- 包内配置：`/sandbox/temp/1015_perf_collector_crash/opt/deeproute/perf-collector/bin/deep_os_monitor_orin.json`
- ReporterManager：`/sandbox/onboard_application/perf_collector/deep_os_tool_cpp/common/reporter/reporter_manager.cc`
- Reporter：`/sandbox/onboard_application/perf_collector/deep_os_tool_cpp/common/reporter/reporter.h`
- Church node：`/sandbox/onboard_application/perf_collector/deep_os_tool_cpp/common/reporter/churchNode.cc`
- 程序入口：`/sandbox/onboard_application/perf_collector/deep_os_tool_cpp/main.cc`
- iceoryx runtime：`/sandbox/platform/church/third_party/iceoryx/iceoryx_posh/source/runtime/ipc_runtime_interface.cpp`
- iceoryx Unix socket：`/sandbox/platform/church/third_party/iceoryx/iceoryx_hoofs/source/posix_wrapper/unix_domain_socket.cpp`
- QNX 平台配置：`/sandbox/platform/church/third_party/iceoryx/iceoryx_hoofs/platform/qnx/include/iceoryx_hoofs/platform/platform_settings.hpp`
