---
title: "TCMALLOC 的 Profile 功能修改（定时输出）V3"
date: 2026-10-14
description: "> 发版方式参考 tcmalloc (gperftools) QNX 自动发版 CI 与测试体系解析%20QNX%20自动发版%20CI%20与测试体系解析.md)。本文仅描述 gperftools/tcmalloc 的实现，不包含 jemalloc 和 monorepo 自动化规则。"
categories:
  - "撰修司"
tags: [tcmalloc]
---

# TCMALLOC 的 Profile 功能修改（定时输出）V3

> 发版方式参考 [tcmalloc (gperftools) QNX 自动发版 CI 与测试体系解析](./开发与发版规范/tcmalloc%20(gperftools)%20QNX%20自动发版%20CI%20与测试体系解析.md)。本文仅描述 gperftools/tcmalloc 的实现，不包含 jemalloc 和 monorepo 自动化规则。

## 1. 背景与目标

完整版 TCMalloc 支持 Heap Sampling，可通过 `TCMALLOC_SAMPLE_PARAMETER` 设置采样间隔，并通过 `MallocExtension::GetHeapSample()` 获取采样数据。仓库中的 Auto-Dumper 在此基础上按时间间隔输出 heap sample 和 tcmalloc stats。

旧配置需要开发人员理解采样参数、定时输出和文件位置之间的关系。V3 增加显式开关，使这些配置可以常驻于进程环境中，但默认不会开启采样或输出：

1. `TCMALLOC_SAMPLE_ENABLE` 控制实际 Heap Sampling 和 `.heap` 文件输出，默认关闭。
2. `TCMALLOC_STATS_ENABLE` 独立控制 `.stats` 文件输出，默认关闭。
3. Heap Sample 与 Stats 可以分别开启，也可以同时开启。
4. 输出目录和周期配置缺失或无效时，不启动 Auto-Dumper。

## 2. 环境变量设计

|环境变量|类型|作用|默认行为|
|---|---|---|---|
|`TCMALLOC_SAMPLE_ENABLE`|布尔字符串|开启实际 heap sampling 及 heap sample 定时输出|未设置或不是 `true` 时关闭|
|`TCMALLOC_STATS_ENABLE`|布尔字符串|开启 stats 定时输出|未设置或不是 `true` 时关闭|
|`TCMALLOC_SAMPLE_PARAMETER`|正整数|Heap Sampling 的采样间隔，单位为字节|未设置或无效时不采样|
|`TCMALLOC_SAMPLE_DUMP_TIME_INTERVAL`|正整数|Auto-Dumper 输出间隔，单位为秒|未设置或无效时不启动输出线程|
|`TCMALLOC_AUTODUMP_DIR`|目录路径|heap 和 stats 文件的共同输出目录，支持 `${ENV_VAR}` 展开|未设置或无效时不启动输出线程|

开关仅接受小写字符串 `true`。未设置、`false`、空值及其他字符串均按关闭处理；其他非空字符串会输出 warning。开关在库初始化时读取，进程运行中修改环境变量不会动态启停采样或 dump。

### 2.1 独立激活条件

|功能|必须满足的条件|
|---|---|
|Heap Sampling 采集|`TCMALLOC_SAMPLE_ENABLE=true`、`TCMALLOC_SAMPLE_PARAMETER` 为正整数|
|Heap Sample 定时文件|Heap Sampling 已启用，且 interval 为正整数、`TCMALLOC_AUTODUMP_DIR` 有效|
|Stats 定时文件|`TCMALLOC_STATS_ENABLE=true`、interval 为正整数、`TCMALLOC_AUTODUMP_DIR` 有效|

Stats 输出不依赖 `TCMALLOC_SAMPLE_ENABLE` 或 `TCMALLOC_SAMPLE_PARAMETER`，因此支持 stats-only。Auto-Dumper 对 heap 和 stats 两类文件分别判断开关及必需配置；两类输出都未满足条件时，不创建输出目录、不启动后台线程。共享的 interval 或目录无效时，所有已请求的文件输出均关闭。Heap Sampling 本身仍可通过 `MallocExtension::GetHeapSample()` 获取数据，但不会自动写出 `.heap` 文件。

`TCMALLOC_SAMPLE_ENABLE=false` 时，采样初始化将采样参数强制设为 0，即使 `TCMALLOC_SAMPLE_PARAMETER` 已配置为正数，也不会启用 Heap Sampling。

### 2.2 路径中的环境变量展开

`TCMALLOC_AUTODUMP_DIR` 支持 `${VAR_NAME}` 语法引用其他环境变量，例如：

```bash
export TCMALLOC_AUTODUMP_DIR="${DR_MODULE_LOG_DIR}/tcmalloc"
```

被引用的变量不存在、展开后路径为空或目录不可创建时，Auto-Dumper 输出 warning 并停止初始化。

## 3. 输出文件

### 3.1 文件命名

```text
{TCMALLOC_AUTODUMP_DIR}/{进程名}.log.{YYYYMMDD.HHMMSS.UUUUUU}.heap
{TCMALLOC_AUTODUMP_DIR}/{进程名}.log.{YYYYMMDD.HHMMSS.UUUUUU}.stats
```

进程名通过 `/proc/self/cmdline` 获取并在初始化时缓存；读取失败时使用 PID。时间戳精确到微秒。后台线程先等待一个完整 interval，再执行第一次 dump。

### 3.2 文件内容

- `.heap`：TCMalloc Heap Sample 数据，可使用 `pprof` 分析。
- `.stats`：`MallocExtension::GetStats()` 输出的 TCMalloc 内存统计信息。

示例：

```text
/data/logs/tcmalloc/perception.log.20261014.143025.123456.heap
/data/logs/tcmalloc/perception.log.20261014.143025.654321.stats
```

## 4. 实现说明

### 4.1 修改位置

- `src/sampler.cc`：在采样初始化处应用 `TCMALLOC_SAMPLE_ENABLE`；Auto-Dumper 分别判断 heap 和 stats 的开关及各自必需配置。
- `src/tests/tcmalloc_auto_dump_test_helper.cc`、`src/tests/tcmalloc_auto_dump_test.sh`：新增进程级启动测试，验证环境变量在库初始化阶段的实际效果。
- `Makefile.am`：构建测试 helper 并注册 Auto-Dumper 集成测试。
- `run_linux_unit_tests.bash`：在隔离构建目录中编译并运行新增测试。

### 4.2 库初始化与线程

Auto-Dumper 仍通过 `REGISTER_MODULE_INITIALIZER` 注册，并使用 `TCMallocGuard` 保证 allocator 已初始化。`pthread_once` 确保每个进程只执行一次初始化；只有至少一种输出满足全部条件时才创建 detached 后台线程。

Auto-Dumper 仍被 `#ifndef NO_TCMALLOC_SAMPLES` 包裹。`libtcmalloc_minimal` 定义了 `NO_TCMALLOC_SAMPLES`，不包含 Heap Sampling 和该 Auto-Dumper；需要 profile 的进程必须加载完整版 `libtcmalloc`。

## 5. 配置示例

### 5.1 仅输出 Heap Sample

```bash
export TCMALLOC_SAMPLE_ENABLE=true
export TCMALLOC_SAMPLE_PARAMETER=524288
export TCMALLOC_STATS_ENABLE=false
export TCMALLOC_SAMPLE_DUMP_TIME_INTERVAL=60
export TCMALLOC_AUTODUMP_DIR="${DR_MODULE_LOG_DIR}/tcmalloc"
```

### 5.2 仅输出 Stats

```bash
export TCMALLOC_SAMPLE_ENABLE=false
export TCMALLOC_STATS_ENABLE=true
export TCMALLOC_SAMPLE_DUMP_TIME_INTERVAL=60
export TCMALLOC_AUTODUMP_DIR="${DR_MODULE_LOG_DIR}/tcmalloc"
```

此配置不需要设置 `TCMALLOC_SAMPLE_PARAMETER`。

### 5.3 同时输出

```bash
export TCMALLOC_SAMPLE_ENABLE=true
export TCMALLOC_SAMPLE_PARAMETER=524288
export TCMALLOC_STATS_ENABLE=true
export TCMALLOC_SAMPLE_DUMP_TIME_INTERVAL=60
export TCMALLOC_AUTODUMP_DIR="${DR_MODULE_LOG_DIR}/tcmalloc"
```

## 6. 验证

Linux 单测与 Auto-Dumper 进程级测试：

```bash
JOBS=8 bash run_linux_unit_tests.bash
```

集成测试覆盖默认关闭（即使采样参数已设置）、仅 heap、仅 stats、两类同时输出、stats-only 不启用采样、采样开关打开但采样参数缺失、周期缺失和缺少自动输出配置。测试检查输出类型、采样数据状态、关闭自动输出时不创建目录，以及原有 `TCMALLOC_AUTODUMP_DIR` 能正常生成 stats 文件；同时验证输出路径指向普通文件时不会启动输出。

QNX 修改验证按仓库 `验证 README` 执行，区分交叉构建、目标机 `LD_PRELOAD` 启动短测和其他未执行项；Linux 单测通过不代表 QNX 目标机运行通过。

## 7. 注意事项

1. `TCMALLOC_SAMPLE_ENABLE` 与 `TCMALLOC_STATS_ENABLE` 默认关闭；只有需要采样或统计输出的目标进程才显式设为 `true`。
2. 开启 Heap Sample 必须同时配置正数 `TCMALLOC_SAMPLE_PARAMETER`；Stats-only 不需要该变量。
3. interval 和输出目录由两类输出共用；任一缺失或无效都会阻止后台输出。
4. 加载 allocator 时保持单进程只使用一个 allocator 的约束；不要同时加载其他 malloc 实现。
5. 本版本只修改 gperftools/tcmalloc 和本设计文档，不修改 monorepo 自动化规则或目标进程配置。
