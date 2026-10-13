---
title: "Off-CPU 火焰图数据处理流程"
date: 2026-09-20
description: "Off-CPU 火焰图展示线程因等待资源（锁、I/O、调度、futex 等）而无法在 CPU 上执行的时间分布。FlameCraft 从 offcpu_flam"
categories:
  - 撰修司
tags:
  - FlameCraft
  - off-CPU
---

# Off-CPU 火焰图数据处理流程

## 概述

Off-CPU 火焰图展示线程因等待资源（锁、I/O、调度、futex 等）而无法在 CPU 上执行的时间分布。FlameCraft 从 `offcpu_flamegraph.log` 文件中解析 Off-CPU 数据，转换为 pprof 格式写入 profile store，并通过 UI 可视化。

## 数据源

Off-CPU 数据由车端 `sched_tracker` eBPF 工具采集，存储在 DrFile 的路径：

```
/{tripName}/logs/perf_ebpf/sched_tracker/offcpu_flamegraph.log.YYYYMMDD.HHMMSS.microseconds.tmp
```

## 文件格式

### 整体结构

文件与 `cpu_profile.log` 一样，使用时间戳标记分段：

```
========== [2026-03-06 11:13:46.124351] ==========
========== [2026-03-06 11:13:47.124656] ==========
[offcpu_u:3,k:5|waker_u:2,k:4] blocked_process(pid)->waker_process(pid);frame1;frame2;...;--- WAKER ---;waker_frame1;waker_frame2;... duration_us
[u:1,k:2] process(pid);frame1;frame2;... duration_us
========== [2026-03-06 11:13:48.124750] ==========
...
```

- 每个 `========== [timestamp] ==========` 标记开始一个新的时间段（约 1 秒间隔）
- 空的时间段（无 offcpu 事件）是正常的
- 每行代表一次阻塞事件

### 单行格式

每行包含以下部分：

```
[metadata] process_info;stack_frames... duration_us
```

#### 1. 元数据前缀 `[metadata]`

两种格式：

- **带 waker**: `[offcpu_u:3,k:5|waker_u:2,k:4]`

  - `u:N` = 用户态帧数量, `k:N` = 内核态帧数量
  - `|` 分隔 blocked 侧和 waker 侧
- **不带 waker**: `[u:3,k:5]`

#### 2. 进程信息

- 带 waker: `blocked_process(blocked_pid)->waker_process(waker_pid)`
- 不带 waker: `process(pid)`

#### 3. 调用栈帧

以分号 `;` 分隔。如果有 waker，使用 `--- WAKER ---` 分隔 blocked 栈和 waker 栈：

```
blocked_frame1;blocked_frame2;...;--- WAKER ---;waker_frame1;waker_frame2;...
```

#### 4. 持续时间 `duration_us`

行末尾的数字，单位为**微秒 (μs)**，表示这次阻塞事件在该 1 秒窗口内的聚合持续时间。  
解析器在读取后会自动乘以 1000 转换为纳秒，以匹配 pprof 的 nanoseconds 约定。这是最重要的度量值：

- 决定 metrics 时间线柱状图的高度（某秒内所有阻塞事件 duration 之和）
- 决定火焰图中每个函数框的宽度（累计 duration）

## 解析流程

```
offcpu_flamegraph.log.xxx.tmp
        │
        ▼
   ┌─────────────┐
   │ 自定义 zst   │  DecompressCustomZst()
   │ 解压缩       │
   └─────┬───────┘
         ▼
   ┌─────────────┐
   │ 按时间戳标记  │  ParseOffCPUSections()
   │ 分段解析      │  → []OffCPUSection
   └─────┬───────┘
         ▼
   ┌─────────────┐
   │ 每段按进程    │  grouped[process|pid]
   │ 分组         │  → map[string][]OffCPUStack
   └─────┬───────┘
         ▼
   ┌─────────────┐
   │ 转换为 pprof │  OffCPUStacksToPprof()
   │ (blocked +   │  → blocked.pprof.gz + waker.pprof.gz
   │  waker)     │
   └─────┬───────┘
         ▼
   ┌─────────────┐
   │ 写入 profile │  WriteRaw() → profilepb.RawProfileSeries
   │ store        │  __name__ = process_offcpu / process_offcpu_waker
   └─────────────┘
```

### 关键步骤详解

#### 1. 分段解析 `ParseOffCPUSections()`

文件: `pkg/filereader/offcpu_parser.go`

逐行扫描文件，遇到 `========== [timestamp] ==========` 标记时开始新段。每段内的 offcpu 行由 `parseOffCPULine()` 解析为 `OffCPUStack` 结构。

输出: `[]OffCPUSection`，每段包含时间戳和该时间段内的所有 `OffCPUStack`。

#### 2. 按进程分组

文件: `pkg/filereader/reader.go` → `processOffCPUFile()`

对每个时间段，按 `BlockedProcess|BlockedPID` 分组，使同一进程的所有阻塞事件聚合到一起。

#### 3. 转换为 pprof `OffCPUStacksToPprof()`

文件: `pkg/filereader/offcpu_parser.go`

将 `[]OffCPUStack` 转换为两个 gzipped pprof profile：

- **blocked profile** (`process_offcpu`): 被阻塞线程的调用栈
- **waker profile** (`process_offcpu_waker`): 唤醒阻塞线程的调用栈

pprof 配置：

- `PeriodType`: `offcpu:nanoseconds`
- `SampleType`: `offcpu:nanoseconds`
- `TimeNanos`: 来自当前时间段的时间戳
- `Sample.Value[0]`: `DurationNs`（每行末尾的阻塞持续时间）

#### 4. 写入 profile store

以 `profilepb.RawProfileSeries` 写入，标签包含：

- `__name__`: `process_offcpu` 或 `process_offcpu_waker`
- `comm`: 进程名
- `pid`: 进程 ID
- `trip`: Trip 名称

## Metrics 柱状图计算

柱状图中每根柱子的高度 = 该时间段内**所有 pprof sample 的 DurationNs 之和**。

例如某秒内有 3 个阻塞事件：

- 线程 A 阻塞 500,000 ns (0.5ms)
- 线程 B 阻塞 1,200,000 ns (1.2ms)
- 线程 C 阻塞 300,000 ns (0.3ms)

该秒柱高 = 2,000,000 ns (2ms)

## 火焰图宽度计算

火焰图中每个函数框的宽度 = 该函数出现在调用栈中时所有 sample 的 `DurationNs` 累计之和。宽度越大表示该函数参与的阻塞时间越长。

## Trip 分析集成

在 `trip_handler.go` 的 `processTripAnalyze()` 中：

1. `profilerPathCandidates()` 返回 3 个候选路径，按顺序全部检查（不 break）：

   - `/{trip}/logs/perf_ebpf/cpu_tracker` → CPU profile
   - `/{trip}/logs/perf_ebpf/sched_tracker` → Off-CPU profile
   - `/{trip}/logs/perf_collector/qnx_profiler` → QNX profile
2. 来自不同路径的文件通过 `fileEntry.DirPath` 追踪各自的远程目录
3. 下载后统一放入临时目录，由 `filereader.Reader` 自动检测格式并分别处理

## Profile 类型

| Profile 类型 | `__name__` | 含义 |
|-|-|-|
| CPU | `process_cpu` | 线程在 CPU 上执行的时间 |
| Off-CPU (blocked) | `process_offcpu` | 线程因等待而不在 CPU 上执行的时间 |
| Off-CPU (waker) | `process_offcpu_waker` | 唤醒被阻塞线程的调用栈 |

## 格式检测优先级

`processFile()` 中的检测顺序：

1. 如果是 `.zst`/`.tmp` → 尝试解压（支持 offcpu 和 folded 格式的 plaintext fallback）
2. `IsOffCPULogFile(filename)` 或 `IsOffCPUFormat(data)` → `processOffCPUFile()`
3. `IsCpuProfileLogFile(filename)` → `processFoldedFile()`
4. `IsFoldedFormat(data)` → `processFoldedFile()`
5. 默认 → 作为标准 pprof 处理
