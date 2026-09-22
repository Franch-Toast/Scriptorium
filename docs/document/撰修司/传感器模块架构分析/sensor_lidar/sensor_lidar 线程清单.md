---
title: "sensor_lidar 线程清单"
date: 2026-09-20
description: "基准平台：LP8650-V1-SHARE"
categories:
  - 撰修司
tags:
  - sensor_lidar
---

# sensor_lidar 线程清单

> 基准平台：LP8650-V1-SHARE  
> 生成日期：2026-04-16

---

## 1. 线程总览

| # | 线程名称 | 类别 | 创建者 | 职责简述 |
|-|-|-|-|-|
| 1 | `t_Lidar` | Church 任务线程 | Church Scheduler | 组件 `Proc()` 执行线程（空实现） |
| 2 | `sensor_lidar` | 核心业务线程 | `LidarHelper*::Start()` | 数据接收 + 解码 + 帧拼装 + 发布 |
| 3 | (CloudCheck) | 业务辅助线程 | `LidarHelper*::Start()` | 帧超时检查，强制发布（仅多雷达模式） |
| 4 | `sensors_watch_dog` | 公共监控线程 | `Watchdog` 单例 | 数据包超时看门狗（需项目注册） |
| 5 | `sensors_frame_rate_checker` | 公共监控线程 | `FrameRateCheck` 单例 | 帧率异常检测（需项目注册） |
| 6 | `iceoryx_dispatch` | Church 基础线程 | Church Runtime | iceoryx 消息分发 |
| 7 | `sched_monitor` | Church 基础线程 | Church Runtime | 调度事件记录 |
| 8 | `event_report` | Church 基础线程 | Church Runtime | 事件聚合与发布 |
| 9 | `c_anomaly_monitor` | Church 基础线程 | Church Runtime | `Proc()` 执行超时监控 |
| 10 | `c_node_timer` | Church 基础线程 | Church Runtime | 定时器管理 |
| 11 | `s_monitor` | Church 基础线程 | Church Runtime | 系统监控 |
| 12 | `s_timer` | Church 基础线程 | Church Runtime | 系统定时器 |
| 13 | `iox_keepalive` | iceoryx 线程 | iceoryx Runtime | 心跳维持 |
| 14 | `async_logger` | 日志线程 | MLOG 系统 | 异步日志写入 |
| 15 | `compress_logfiles` | 日志线程 | 日志系统 | 日志文件压缩 |
| 16 | `crash_reporter` | 崩溃处理线程 | Crash 框架 | 崩溃信号捕获与报告 |

> 注 1：与 sensor_radar 不同，sensor_lidar **不使用 lpcom**，因此没有 `thread_pool`、`event_loop`、`topic_monitor` 等 lpcom 内部线程。  
> 注 2：多雷达 Linux 模式下，每个 LiDAR 额外创建一个接收线程（线程名同为 `sensor_lidar`），线程总数取决于雷达数量。  
> 注 3：LP8650 平台的 `LidarManager` 未注册 watchdog 和 frame_rate 回调，因此 `sensors_watch_dog` 和 `sensors_frame_rate_checker` 线程实际空转。Smart HY11 平台注册了这些回调。

---

## 2. 核心线程详解

### 2.1 `t_Lidar` — Church 任务线程

**创建**：Church `SchedulerOneTaskOneThread` 根据 `sensor_lidar.jsonnet` 配置创建。

**配置**（来自 `thread_config/LP8650-V1-SHARE/sensor_lidar.json`）：

```json
{
    "name": "t_Lidar",
    "policy": "SCHED_RR",
    "priority": 35,
    "cpuset": "4-7"
}
```

**行为**：

- `Proc()` 实现为空（`return true`），不处理任何数据
- 因为 `trigger_policy: 'IMMEDIATE'` 且 `input_channels` 为空，该线程主要为 Church 框架提供组件生命周期管理
- `Init()` 完成后真正的数据处理交由 Helper 的独立线程执行

### 2.2 `sensor_lidar` — 核心数据处理线程

**单雷达模式** (`LidarHelperSingle`)：

**创建**：通过 `deeproute::common::ThreadPool(1, "sensor_lidar")` 创建单线程池，`Enqueue(ProcessCloud)`。

**执行循环**：

```
while(is_running):
    GetCloud():
        read(buffer)       ← 阻塞在 UDP socket read
        DecodePacket()     ← 解码
        return cloud_ptr
    帧拼装逻辑
    if 帧完成:
        Publish()
            PCLToProto()
            publish_cloud_cb_1_()   → SHM + node()->PublishWithHeader()
            publish_cloud_downsample_cb_()
```

**多雷达 Linux 模式** (`LidarHelperMulti`)：

- **接收线程** ×N：每个 LiDAR 一个，线程名 `sensor_lidar`

  - `ReceiveAndProcessPacket()`: `read` → `DecodePacket` → `ring_buffer_.push()` → `cv_.notify_one()`
- **拼装线程** ×1：`ProcessCloud()`

  - `cv_.wait(lck)` → drain 所有 SPSC → 帧拼装 → `CheckPubFlag()` → `Publish()`

**多雷达 QNX 模式** (`LidarHelperQnxMulti`)：

- **接收线程** ×1：`poll` 所有 LiDAR fd → `recvmmsg` 批量收包 → `ProcessSinglePacket()`

  - 在 `mtx_` 锁下直接合并到 `current_cloud_ptr_`，无 SPSC 中间队列
- **拼装线程** ×1：`ProcessCloudQnx()`

  - `cv_.wait_for(lck, predicate: CheckPubFlag())` → `Publish()`

**配置**：

```json
{
    "name": "sensor_lidar",
    "policy": "SCHED_RR",
    "priority": 45,
    "cpuset": "4-7"
}
```

### 2.3 CloudCheck — 帧超时检查线程

**创建**：多雷达模式 Helper 内部创建。

**行为**：

- 周期检查 FrameTimer 是否超时
- 超时时设置 `manual_update_flag_` → `cv_.notify_one()` → 强制 `Publish()`
- 避免某个雷达掉线导致帧永不完成

---

## 3. 线程交互图

```
                 单雷达模式 (LidarHelperSingle)
                 ─────────────────────────────
                    ┌─────────────────────┐
  UDP Socket ──→   │  sensor_lidar (1)    │
                    │  read → decode →    │
                    │  frame → publish    │──→ ShmPool → iceoryx → 下游
                    └─────────────────────┘


                 多雷达 Linux 模式 (LidarHelperMulti)
                 ──────────────────────────────────
  UDP Socket 1 ──→ ┌─────────────────┐
                    │ sensor_lidar (1) │──→ SPSC[0] ──┐
                    │ recv + decode    │              │
                    └─────────────────┘              │
  UDP Socket 2 ──→ ┌─────────────────┐              ├─ cv_ ─→ ┌─────────────────────┐
                    │ sensor_lidar (2) │──→ SPSC[1] ──┤         │ ProcessCloud 线程    │
                    │ recv + decode    │              │         │ drain all SPSC      │
                    └─────────────────┘              │         │ frame merge         │
  UDP Socket N ──→ ┌─────────────────┐              │         │ CheckPubFlag()      │
                    │ sensor_lidar (N) │──→ SPSC[N] ──┘         │ Publish()           │──→ 下游
                    │ recv + decode    │                        └─────────────────────┘
                    └─────────────────┘                                 ▲
                                                                        │
                                                   ┌─────────────────────┐
                                                   │ CloudCheck 线程      │
                                                   │ timeout → force pub  │
                                                   └─────────────────────┘


                 多雷达 QNX 模式 (LidarHelperQnxMulti)
                 ─────────────────────────────────────
  UDP Socket 1 ─┐
  UDP Socket 2 ─┼──→ ┌──────────────────────────┐
  UDP Socket N ─┘    │ ReceiveAndProcessPacketsQnx│
                      │ poll() → recvmmsg()       │
                      │ mtx_ lock:                │
                      │   decode → merge cloud    │──→ cv_ ──→ ┌──────────────────┐
                      │   CheckPubFlag()          │            │ ProcessCloudQnx  │
                      └──────────────────────────┘            │ cv_.wait(pub?)   │
                                                               │ Publish()        │──→ 下游
                                                               └──────────────────┘
```

---

## 4. 线程配置

### 4.1 LP8650-V1-SHARE

```json
{
    "process_conf": [{
        "name": "sensor_lidar",
        "default_thread_task_cpuset": "4-7",
        "default_thread_policy": "SCHED_RR",
        "default_thread_priority": 45,
        "threads": [
            { "name": "iceoryx_dispatch",          "policy": "SCHED_RR", "priority": 10, "cpuset": "4-7" },
            { "name": "t_Lidar",                   "policy": "SCHED_RR", "priority": 35, "cpuset": "4-7" },
            { "name": "sensor_lidar",              "policy": "SCHED_RR", "priority": 45, "cpuset": "4-7" },
            { "name": "watch_dog",                 "policy": "SCHED_RR", "priority": 10, "cpuset": "4-7" },
            { "name": "sensors_frame_rate_checker", "policy": "SCHED_RR", "priority": 35, "cpuset": "4-7" },
            { "name": "sensors_watch_dog",         "policy": "SCHED_RR", "priority": 35, "cpuset": "4-7" },
            { "name": "compress_logfiles",         "policy": "SCHED_RR", "priority": 10, "cpuset": "4-7" },
            { "name": "sched_monitor",             "policy": "SCHED_RR", "priority": 21, "cpuset": "4-7" }
        ]
    }]
}
```

### 4.2 LP8797-V1-SHARE

```json
{
    "process_conf": [{
        "name": "sensor_lidar",
        "default_thread_task_cpuset": "6-11",
        "default_thread_policy": "SCHED_RR",
        "default_thread_priority": 20,
        "threads": [
            { "name": "iceoryx_dispatch",          "policy": "SCHED_RR", "priority": 35, "cpuset": "6-11" },
            { "name": "t_Lidar",                   "policy": "SCHED_RR", "priority": 35, "cpuset": "6-11" },
            { "name": "sensor_lidar",              "policy": "SCHED_RR", "priority": 35, "cpuset": "6-11" },
            { "name": "watch_dog",                 "policy": "SCHED_RR", "priority": 10, "cpuset": "6-11" },
            { "name": "sensors_frame_rate_checker", "policy": "SCHED_RR", "priority": 35, "cpuset": "6-11" },
            { "name": "sensors_watch_dog",         "policy": "SCHED_RR", "priority": 35, "cpuset": "6-11" },
            { "name": "compress_logfiles",         "policy": "SCHED_RR", "priority": 10, "cpuset": "6-11" },
            { "name": "sched_monitor",             "policy": "SCHED_RR", "priority": 21, "cpuset": "6-11" }
        ]
    }]
}
```

> **LP8650 vs LP8797 差异**：LP8650 的 `sensor_lidar` 线程优先级为 45（最高），而 LP8797 为 35（与 `t_Lidar`、`iceoryx_dispatch` 同级）。LP8797 的 cpuset 为 `6-11`（6 个核），LP8650 为 `4-7`（4 个核）。

### 4.3 C01 / HY11

```json
{
    "process_conf": [{
        "name": "sensor_lidar",
        "default_thread_task_cpuset": "0,9-10",
        "default_thread_policy": "SCHED_OTHER",
        "default_thread_priority": -10,
        "threads": [
            { "name": "iceoryx_dispatch",          "policy": "SCHED_RR", "priority": 6, "cpuset": "6-8" },
            { "name": "t_Lidar",                   "policy": "SCHED_RR", "priority": 6, "cpuset": "6-8" },
            { "name": "sensor_lidar",              "policy": "SCHED_RR", "priority": 6, "cpuset": "6-8" },
            { "name": "watch_dog",                 "policy": "SCHED_OTHER", "priority": -10, "cpuset": "0,9-10" },
            { "name": "sensors_frame_rate_checker", "policy": "SCHED_RR", "priority": 6, "cpuset": "6-8" },
            { "name": "sensors_watch_dog",         "policy": "SCHED_RR", "priority": 6, "cpuset": "6-8" }
        ]
    }]
}
```

### 4.4 优先级层次

| 平台 | 最高 | 中间 | 最低 |
|-|-|-|-|
| LP8650 | `sensor_lidar` (45) | `t_Lidar` / `sensors_*` (35) | `iceoryx_dispatch` / `watch_dog` (10) |
| LP8797 | `sensor_lidar` / `t_Lidar` / `iceoryx_dispatch` / `sensors_*` (35) | `sched_monitor` (21) | `watch_dog` / `compress_logfiles` (10) |
| C01/HY11 | `sensor_lidar` / `t_Lidar` / `sensors_*` (6) | — | `watch_dog` (-10, SCHED_OTHER) |

---

## 5. 与 sensor_radar / sensor_ins_online 线程对比

| 维度 | sensor_lidar | sensor_radar | sensor_ins_online |
|-|-|-|-|
| 总线程数 (LP8650) | \~16 (不含多雷达额外接收线程) | \~20 | \~25 |
| Church 任务线程 | `t_Lidar` (空 Proc) | `t_Radar` (空 Proc) | `t_SnrInsOnln` (空 Proc) |
| 核心业务线程 | `sensor_lidar` (自命名) | `SnrRadAsembProc` | `SnrInsOnlnProc` |
| I/O 线程 | 自管理 UDP recv 线程 | lpcom `thread_pool` / `event_loop` | lpcom `thread_pool` + `mq_recv` |
| 中间队列 | SPSC (cap=256, 仅多雷达) | SPSC (cap=64) | SPSC (cap=64) |
| 状态监控线程 | ❌ 无独立 status_thread | ✅ `status_thread` | — |
| lpcom 线程 | ❌ 无 | ✅ 有 | ✅ 有 |
| 接收线程数 | 可变（N 个雷达 = N 个线程，单雷达 = 1） | 固定 | 固定 |
