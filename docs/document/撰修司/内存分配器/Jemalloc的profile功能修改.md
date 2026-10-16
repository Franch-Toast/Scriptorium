---
title: "Jemalloc 的 Profile 功能修改（定时输出）"
date: 2026-10-15
description: "说明 jemalloc profiler/minimal 双库构建、heap profile 与 stats 定时输出开关、实现和验证方式。"
categories:
  - "撰修司"
tags: [jemalloc, profile]
---

# Jemalloc 的 Profile 功能修改（定时输出）

> 本文说明当前 jemalloc 仓库的 profile 与定时自动输出实现。多架构 CI、Debian 打包及上传流程另见 [jemalloc Linux 自动发版 CI 与测试体系解析](./开发与发版规范/jemalloc%20Linux%20自动发版%20CI%20与测试体系解析.md)。

## 1. 背景与目标

jemalloc 原生 profiler 在编译时启用后，可通过 MALLOC_CONF 中的 prof 选项控制运行时 heap profiling。仓库增加了按时间间隔输出 heap profile 和 allocator stats 的 Auto-Dump 逻辑，并提供两种编译产物：

1. profile 库：使用 --enable-stats --enable-prof 编译，支持 profiling 和 stats 输出。
2. minimal 库：使用 --disable-stats --disable-prof 编译，重命名为 libjemalloc_minimal.so.2；它不包含本仓库新增的自动 dump 实现。
3. profile 库中 heap profile 与 stats 使用独立运行时开关。prof:false 不会阻止显式开启的 stats-only 输出。
4. interval 或输出目录缺失、无效时，不创建自动输出线程。

Auto-Dump 在 allocator 初始化阶段读取环境变量；进程启动后再修改环境变量不会动态变更其输出行为。

## 2. 配置与开关设计

### 2.1 环境变量

|配置|类型|作用|默认行为|
|---|---|---|---|
|MALLOC_CONF 的 prof:true|jemalloc 配置项|开启 profile 库中的 heap profiling|未开启时不输出 heap profile|
|MALLOC_CONF 的 lg_prof_sample|整数配置项|控制 profiler 的采样间隔/粒度|使用 jemalloc 默认值；需要 profile 时按业务需求设置|
|JEMALLOC_STATS_ENABLE|布尔字符串|独立开启 stats 定时输出|未设置、false 或非精确字符串 true 时关闭|
|JEMALLOC_PROF_TIME_INTERVAL|正整数，秒|heap 和 stats 的公共输出周期|未设置、空值或解析结果不大于 0 时不启动 Auto-Dump|
|JEMALLOC_AUTODUMP_DIR|目录路径|heap 与 stats 文件的共同输出目录|未设置或无法解析/创建时不启动 Auto-Dump|

JEMALLOC_STATS_ENABLE 仅当值与小写字符串 true 完全相同时开启。该变量只影响编译时启用了 stats 的 profile 库；minimal 库的自动 dump 入口是 no-op。

MALLOC_CONF 的 prof:true 是 heap profiling 的运行时开关；JEMALLOC_STATS_ENABLE=true 是 stats 输出开关。两者相互独立：stats-only 不要求 prof:true，也不要求设置 lg_prof_sample。

### 2.2 独立激活条件

|库及运行配置|heap profile|stats|
|---|---:|---:|
|profile 库，prof:true，stats 未开|输出|不输出|
|profile 库，prof:true，JEMALLOC_STATS_ENABLE=true|输出|输出|
|profile 库，prof:false，JEMALLOC_STATS_ENABLE=true|不输出|输出|
|profile 库，prof:false，stats 未开或为 false|不输出|不输出|
|minimal 库，无论 prof/stats 环境变量如何设置|不输出|不输出|

profile 库在 Auto-Dump 初始化时先检查 opt_prof 和 JEMALLOC_STATS_ENABLE。两种输出都未请求时立即返回，不读取 interval 和输出目录，也不创建后台线程。只请求其中一种时，仍需配置有效的 interval 和 JEMALLOC_AUTODUMP_DIR；它们无效会使本次 Auto-Dump 初始化整体停止。

minimal 库在编译期禁用了 profiler，且本仓库在 JEMALLOC_PROF 未定义时将 prof_auto_dump_boot() 编译为空实现。因此即使设置 prof:true、JEMALLOC_STATS_ENABLE=true、周期和目录，也不会产生自动 heap/stats 文件。minimal 库的其他有效 MALLOC_CONF 参数仍按 jemalloc 自身规则工作。

### 2.3 输出目录环境变量展开

JEMALLOC_AUTODUMP_DIR 支持 ${VAR_NAME} 形式的环境变量展开，例如：

```bash
export DR_MODULE_LOG_DIR=/data/logs
export JEMALLOC_AUTODUMP_DIR="${DR_MODULE_LOG_DIR}/jemalloc"
```

被引用的环境变量不存在、路径过长、目录创建失败或最终目录不可用时，Auto-Dump 初始化失败并停止自动输出。目录不存在时会尝试递归创建。建议显式使用绝对路径，并确保运行进程有写权限。

## 3. 输出文件

### 3.1 命名规则

```text
{JEMALLOC_AUTODUMP_DIR}/{进程名}.log.{YYYYMMDD.HHMMSS.微秒}.heap
{JEMALLOC_AUTODUMP_DIR}/{进程名}.log.{YYYYMMDD.HHMMSS.微秒}.stats
```

进程名从 Linux prctl(PR_GET_NAME) 读取并在初始化时缓存；读取失败时使用 pid{PID}。时间戳包含微秒。后台线程启动后先等待一个完整 interval，再执行第一次输出；后续按同一周期持续输出。

### 3.2 文件内容

- .heap：通过 jemalloc 的 prof.dump mallctl 输出的 heap profile 数据。
- .stats：通过 je_malloc_stats_print 输出的 jemalloc 统计信息。

profile 库中某一轮只输出已开启的类型；例如 prof:false 且 stats 开启时，该轮只会生成 .stats。

## 4. 实现说明

### 4.1 修改位置

- src/prof_auto_dump.c：实现运行时开关判断、路径展开、目录创建、文件命名及 heap/stats 定时输出。
- src/jemalloc.c：在 jemalloc 初始化收尾阶段调用 prof_auto_dump_boot()。
- include/jemalloc/internal/prof_auto_dump.h：声明 Auto-Dump 初始化入口。
- pipeline/Makefile.deb：分别配置、编译和安装 profile/minimal 两个变体，再将两者打入同一平台 deb。
- build_jemalloc.bash：开发者手动构建脚本也分别生成 profile/minimal 变体；支持相应平台工具链和页面大小参数。

### 4.2 初始化和后台线程

prof_auto_dump_boot() 在 jemalloc 初始化流程中调用，并通过 pthread_once 保证 Auto-Dump 配置只初始化一次。profile 编译中，初始化顺序大致如下：

1. 从 jemalloc 已解析的运行配置读取 opt_prof，作为 heap profile 开关。
2. 仅当 JEMALLOC_STATS_ENABLE 的值精确为 true 时开启 stats 输出。
3. 两个开关都关闭时立即返回，不解析周期或目录。
4. 至少一个开关开启后，读取 JEMALLOC_PROF_TIME_INTERVAL 并要求其解析结果为正数。
5. 展开并创建 JEMALLOC_AUTODUMP_DIR。
6. 创建 detached 后台线程；线程按周期调用 prof.dump 和/或 malloc_stats_print。

heap profile 使用 jemalloc 的 prof.dump mallctl；stats 输出使用回调将 malloc_stats_print 内容写入文件。线程按配置持续运行，当前实现没有停止/动态重配置接口。

### 4.3 编译变体与安装

CI 的 pipeline/Makefile.deb 和手动 build_jemalloc.bash 均使用独立构建目录，避免两组 configure 选项互相覆盖：

```text
profile: --enable-stats --enable-prof
         安装为 libjemalloc.so.2

minimal: --disable-stats --disable-prof
         安装后将 libjemalloc.so.2 复制并命名为 libjemalloc_minimal.so.2
```

打包时以 profile 的安装树为主，再放入 minimal 的改名库。改文件名本身不会改变 ELF 内部 SONAME；部署时应确认使用方的加载方式，必要时通过库文件绝对路径选择变体。

## 5. 配置示例

以下示例假设目标进程加载 profile 库，且该库以 --enable-stats --enable-prof 编译。

### 5.1 仅输出 heap profile

```bash
export MALLOC_CONF='prof:true,lg_prof_sample:19'
export JEMALLOC_PROF_TIME_INTERVAL=60
export JEMALLOC_AUTODUMP_DIR=/tmp/jemalloc_dump
unset JEMALLOC_STATS_ENABLE
LD_PRELOAD=/opt/deeproute/jemalloc/lib/libjemalloc.so.2 ./your_application
```

### 5.2 仅输出 stats

```bash
export MALLOC_CONF='prof:false'
export JEMALLOC_STATS_ENABLE=true
export JEMALLOC_PROF_TIME_INTERVAL=60
export JEMALLOC_AUTODUMP_DIR=/tmp/jemalloc_dump
LD_PRELOAD=/opt/deeproute/jemalloc/lib/libjemalloc.so.2 ./your_application
```

该配置只生成 .stats，不会启用 heap profiling；不需要配置 lg_prof_sample。

### 5.3 同时输出 heap profile 和 stats

```bash
export MALLOC_CONF='prof:true,lg_prof_sample:19'
export JEMALLOC_STATS_ENABLE=true
export JEMALLOC_PROF_TIME_INTERVAL=60
export JEMALLOC_AUTODUMP_DIR="${DR_MODULE_LOG_DIR}/jemalloc"
LD_PRELOAD=/opt/deeproute/jemalloc/lib/libjemalloc.so.2 ./your_application
```

### 5.4 关闭自动输出及使用 minimal 库

profile 库中设置 prof:false，并且不设置 JEMALLOC_STATS_ENABLE=true 时，不启动 Auto-Dump。使用 libjemalloc_minimal.so.2 时，即使存在上述 profile/stats 环境变量也不会自动输出：

```bash
export MALLOC_CONF='prof:true,lg_prof_sample:19'
export JEMALLOC_STATS_ENABLE=true
export JEMALLOC_PROF_TIME_INTERVAL=60
export JEMALLOC_AUTODUMP_DIR=/tmp/jemalloc_dump
LD_PRELOAD=/opt/deeproute/jemalloc/lib/libjemalloc_minimal.so.2 ./your_application
```

minimal 库中 profiler 未编译；prof 相关配置不会让它变成 profile 库。其他可用的 jemalloc MALLOC_CONF 参数仍可配置。

## 6. 验证

当前实现已在 x86_64 本机构建 profile 与 minimal 两个变体，并用进程级 smoke test 检查以下组合：

|场景|实际检查结果|
|---|---|
|profile 库，prof:false，stats=true|只生成 .stats|
|profile 库，prof:false，stats 未设置|不生成 heap/stats|
|profile 库，prof:true，stats=true|生成 heap 和 stats|
|profile 库，prof:true，stats 未设置|只生成 heap|
|minimal 库，prof:true 且 stats=true|不生成 heap/stats；其他 MALLOC_CONF 参数仍生效|

这些是本地验证，不代表仓库 CI 已有对应的自动化运行时测试。当前发布流水线会构建、安装和打包两个库，但没有 jemalloc 专属的 profiler 行为测试阶段；也没有在本次文档中新增持久化测试程序。完整 GitLab 上传流程、ARM runner 与目标设备验证需另行执行。

建议后续将上述矩阵加入仓库测试：每个场景用独立的临时目录启动短时进程，检查 .heap/.stats 文件数量，同时检查关闭输出时目录没有被创建。

## 7. 注意事项

1. 在进程启动前设置 MALLOC_CONF、JEMALLOC_STATS_ENABLE、周期和目录；初始化完成后再修改环境变量不会生效。
2. prof:true 只对编译时启用了 profiler 的库有意义；JEMALLOC_STATS_ENABLE=true 只对编译时启用了 stats 且包含 Auto-Dump 实现的 profile 库生效。
3. profile 库的 prof:false 不等于 minimal 库：profile 库仍保留 profiler/stats 编译能力，stats-only 可独立启动；minimal 库则没有该 Auto-Dump 实现。
4. interval 和目录由 heap/stats 两类输出共用；配置无效会阻止所有本次请求的自动输出。
5. 加载 jemalloc 时遵守单进程只使用一个 malloc 实现的约束；不要与其他 allocator 同时通过 LD_PRELOAD 抢占分配符号。
6. 交叉编译时确认目标架构和目标系统页面大小；构建出 arm64 ELF 不等于已经在对应设备上验证运行。

