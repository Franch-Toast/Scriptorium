---
title: "sensor_ins_online 异常检测机制全景"
date: 2026-09-20
description: "sensor_ins_online 进程中存在 5 层独立的异常检测系统 + 1 个事件汇总层，它们的检测目标、输出方式和监控线程各不相同。"
categories:
  - 撰修司
tags:
  - sensor_ins_online
---

# sensor_ins_online 异常检测机制全景

## 概述

`sensor_ins_online` 进程中存在 **5 层独立的异常检测系统** + **1 个事件汇总层**，它们的检测目标、输出方式和监控线程各不相同。

```
┌───────────────────────────────────────────────────────────────────────────┐
│                     sensor_ins_online 异常检测全景                         │
├──────────────┬──────────────────────┬────────────────┬────────────────────┤
│    层级      │     检测者           │   检测目标     │     输出方式       │
├──────────────┼──────────────────────┼────────────────┼────────────────────┤
│ ① lpcom SDK  │ topic_monitor 线程   │ 通信层帧/断流  │ 事件上报 (DEM)     │
│ ② event_stat │ SnrInsOnlnProc 线程  │ 数据时间差     │ MCU_MLOG + 事件    │
│ ③ msg_report │ t_SensorInsOnline    │ cache 无消息   │ MLOG (.INFO)       │
│ ④ suspend    │ c_node_timer 定时器  │ channel 断流   │ MLOG (.INFO)       │
│ ⑤ proc_time  │ c_anomaly_monitor    │ Proc() 超时   │ MLOG + 事件        │
├──────────────┼──────────────────────┼────────────────┼────────────────────┤
│ ⑥ 汇总       │ event_report 线程    │ 事件收集转发   │ church topic 发布  │
└──────────────┴──────────────────────┴────────────────┴────────────────────┘
```

---

## 监控线程如何跨线程检测异常 — 核心设计模式

### 整体线程交互图

```
                  ┌─────────────────────────────────────────────────────────┐
                  │              t_SensorInsOnline (Thread 12)              │
                  │                                                         │
                  │  Component::Process()                                   │
                  │    ├─ observer->ProcessBegin(this, ...)  ← 在本线程执行  │
                  │    │    ├─ ScheduleMonitor::ProcessBegin() → 写 lockfree│
                  │    │    └─ ComProcTimeUnit::ProcessBegin() → 记录时间戳 │
                  │    │                                                     │
                  │    ├─ Proc() [用户业务逻辑]                              │
                  │    │                                                     │
                  │    ├─ observer->ProcessEnd(this, ...)     ← 在本线程执行 │
                  │    │    ├─ ScheduleMonitor::ProcessEnd() → 写 lockfree  │
                  │    │    └─ ComProcTimeUnit::ProcessEnd() → 计算耗时     │
                  │    │                                                     │
                  │    └─ ChannelCacheMessageReporter::OnCheckTimeout()      │
                  │         [通过 scheduler Timeout 回调在本线程触发]         │
                  └─────────────────────────────────────────────────────────┘
                         ↑写入                           ↑写入
                         │(lockfree queue)               │(mutex-protected map)
                         │                               │
         ┌───────────────┴───┐              ┌────────────┴────────────┐
         │  sched_monitor    │              │  c_anomaly_monitor      │
         │  (Thread 11)      │              │  (Thread 10)            │
         │                   │              │                         │
         │  每500ms:         │              │  每100ms sleep          │
         │  pop lockfree →   │              │  每1000ms: CheckState() │
         │  打包 Protobuf →  │              │    读取 timeout_process │
         │  Publish 到 topic │              │    检查 on_going_process│
         └───────────────────┘              │    → MLOG + ReportEvent │
                                            └─────────────────────────┘
```

### 关键设计：Observer 模式 + 跨线程数据共享

**核心问题**：`c_anomaly_monitor` 线程和 `t_SensorInsOnline` 线程是不同的线程，前者怎么知道后者的 Proc() 执行了多久？

**答案**：church 使用 **Observer（观察者）模式**，将数据采集和异常检测**拆分到两个线程**：

1. **数据采集**：Observer 回调（`ProcessBegin` / `ProcessEnd`）运行在 **被监控线程上**
2. **异常检测**：`UnitRoutine()` / `CheckState()` 运行在 **监控线程上**
3. **数据共享**：通过 mutex-protected 的共享数据结构（map）或 lockfree queue

```
                        在 t_SensorInsOnline 线程执行            在 c_anomaly_monitor 线程执行
                        ─────────────────────────────            ────────────────────────────
Proc 开始 ──► ProcessBegin() {                          
                lock(mutex)                             
                on_going_process[frame_id] = {          
                  begin_time = CurrentTime()             
                }                                        
                unlock(mutex)                            
              }                                         

... Proc 执行中 ...                                       ... sleep 100ms ...

                                                         CheckState() {
                                                           lock(mutex)
                                                           for (each on_going_process) {
                                                             duration = now - begin_time
                                                             if (duration >= timeout)
                                                               → 报告超时!
                                                           }
                                                           unlock(mutex)
                                                         }

Proc 结束 ──► ProcessEnd() {                            
                lock(mutex)                              
                duration = now - begin_time               
                if (duration >= timeout)                   
                  timeout_process.push_back(record)        
                on_going_process.erase(frame_id)           
                unlock(mutex)                              
              }                                          
```

### 五层监控的线程归属明细

| 层级 | 数据采集在哪个线程？ | 异常判定在哪个线程？ | 是否自监控？ |
|-|-|-|-|
| ① lpcom topic_monitor | lpcom 内部线程 | topic_monitor 线程 | 是（lpcom SDK 内部完成） |
| ② event_statistics | SnrInsOnlnProc | SnrInsOnlnProc | **是**（同步调用，100% 自监控） |
| ③ ChannelCacheMessageReporter | t_SensorInsOnline（通过 scheduler Timeout） | t_SensorInsOnline | **是**（定时回调在同一个 task 线程执行） |
| ④ ChannelSuspendAlarm | iceoryx_dispatch（通过 Node receive observer） | c_node_timer（通过 Timer） | 否（采集和判定在不同线程） |
| ⑤ ComProcTimeUnit | t_SensorInsOnline（ProcessBegin/End observer） | c_anomaly_monitor（CheckState） | **否**（典型的跨线程监控） |

### 自监控 vs 跨线程监控的优劣

| 特性 | 自监控（②③） | 跨线程监控（④⑤） |
|-|-|-|
| 精度 | 高（同步打点，无延迟） | 有延迟（依赖轮询周期） |
| 死线程检测 | **不能**（线程卡死则监控也停止） | **能**（on_going_process 超时即报警） |
| 实现复杂度 | 低（无锁竞争） | 高（需要 mutex / lockfree 共享数据） |
| 典型场景 | 数据时间差、处理间隔 | Proc() 超时（可能是死锁/无限循环） |

**重要**：`event_statistics` 的自监控有一个盲区 — 如果 `SnrInsOnlnProc` 线程本身被卡住（例如等待 mutex），`msg_time_diff_check()` 不会被调用，自然不会报告。只有当线程**恢复后处理积压数据时**，才会检测到之前的 sys_diff 异常。而 `c_anomaly_monitor` 的 `ComProcTimeUnit` 可以在**线程卡住期间**就检测到 on_going_process 超时。

---

## 一、第一层：lpcom SDK 内部监控

### 1.1 检测者

`topic_monitor` 线程 — lpcom SDK 内部创建，独立运行

### 1.2 配置

文件：`sensors/sensors/projects/lp8650_v1/ins/ins_topic_monitor.json`

```json
{
  "topic_monitor_config": [
    {
      "topic_name": "/leap/imu/imu_data_adas",
      "frame_timeout_threshold": 30000,
      "callback_timeout_threshold": 20000,
      "lose_timeout_threshold": 100000
    },
    {
      "topic_name": "/leap/gnss/gnss_data",
      "frame_timeout_threshold": 300000,
      "callback_timeout_threshold": 200000,
      "lose_timeout_threshold": 1000000
    }
  ]
}
```

单位：微秒 (μs)

### 1.3 五种异常类型

| 错误码 | 含义 | IMU 阈值 | GNSS 阈值 |
|-|-|-|-|
| `kFrameTimeout` | **帧超时**：相邻两帧到达间隔超过阈值 | 30ms | 300ms |
| `kCallbackTimeout` | **回调超时**：从收到数据到执行回调的时间超过阈值 | 20ms | 200ms |
| `kLoseTimeout` | **断流超时**：持续没有数据到达超过阈值 | 100ms | 1000ms |
| `kFindTopicTimeout` | **服务发现超时**：订阅 topic 时找不到发布者 | — | — |
| `kTopicUnavailable` | **服务不可用**：发布者断开连接 | — | — |

### 1.4 上报路径

```
lpcom topic_monitor 线程
    ↓ 检测到异常
    ↓ 调用 ErrorCodeCallback
InsManager::ErrorCodeCallback()
    ↓ switch(err_code)
deeproute::common::ReportEvent(事件码)
    ↓
EventLog 队列
    ↓
event_report 线程 → church topic 发布
```

### 1.5 对应事件码

| topic | 异常类型 | 事件码 |
|-|-|-|
| IMU | kFrameTimeout | `LP_INS_ONLINE_INMU_TOPIC_FRAME_TIMEOUT` |
| IMU | kCallbackTimeout | `LP_INS_ONLINE_INMU_TOPIC_CALLBACK_TIMEOUT` |
| IMU | kLoseTimeout | `INS_ONLINE_INMU_LOST_COMMUNICATION` |
| IMU | kFindTopicTimeout | `LP_INS_ONLINE_INMU_SRV_FIND_SERVICE_TIMEOUT` |
| IMU | kTopicUnavailable | `LP_INS_ONLINE_INMU_SRV_UNAVAILABLE` |
| GNSS | kFrameTimeout | `LP_INS_ONLINE_GNSS_TOPIC_FRAME_TIMEOUT` |
| GNSS | kCallbackTimeout | `LP_INS_ONLINE_GNSS_TOPIC_CALLBACK_TIMEOUT` |
| GNSS | kLoseTimeout | `INS_ONLINE_INMU_LOST_COMMUNICATION_GNSS` |
| GNSS | kFindTopicTimeout | `LP_INS_ONLINE_GNSS_SRV_FIND_SERVICE_TIMEOUT` |
| GNSS | kTopicUnavailable | `LP_INS_ONLINE_GNSS_SRV_UNAVAILABLE` |

### 1.6 线程模型

```
topic_monitor 线程 (lpcom SDK 内部)
    │ 定期检查每个订阅 topic 的最后到达时间
    │ 与当前时间对比，超过阈值即触发 ErrorCode 回调
    ↓
ErrorCodeCallback() ← 在 topic_monitor 线程中执行
    ↓
ReportEvent() → EventLog 队列（线程安全）
    ↓
event_report 线程读取并发布
```

整个检测和上报都在 lpcom SDK 内部完成，`sensor_ins_online` 的代码只需要注册回调函数。`topic_monitor` 是纯粹的**外部独立监控**，不受被监控数据流线程的影响。

### 1.7 代码位置

- 回调注册：`sensors/sensors/projects/lp8650_v1/ins/ins_manager.cpp:103`
- 回调实现：`sensors/sensors/projects/lp8650_v1/ins/ins_manager.cpp:172-237`
- 监控配置：`sensors/sensors/projects/lp8650_v1/ins/ins_topic_monitor.json`

---

## 二、第二层：event_statistics 时间差检测

### 2.1 检测者

`SnrInsOnlnProc` 线程 — 在处理每帧传感器数据时同步调用

### 2.2 线程模型 — 纯自监控

```
SnrInsOnlnProc 线程
    │
    ├─ pop(ins_recv_queue_) → 取出一帧 sensors_ins_packet
    │
    ├─ ParseImu() / ParseVel() / ParsePose()
    │    │
    │    ├─ msg_time_diff_check()     ← 同步调用，在本线程执行
    │    │    ├─ 计算 sys_pkt_diff / sys_diff / pkt_diff
    │    │    ├─ 超阈值 → MCU_MLOG + event_cb_fn
    │    │    └─ 综合判断 → DROP_FRAME / PKT_BLOCK / TIME_JUMP
    │    │
    │    ├─ process_interval_time_diff_check(TIMESTART)
    │    ├─ [执行 MSF/Publish 等操作]
    │    └─ process_interval_time_diff_check(TIMEEND)
    │         └─ 耗时超阈值 → MCU_MLOG
    │
    └─ 处理下一帧
```

**这是 100% 的自监控**：所有检测逻辑都在 `SnrInsOnlnProc` 线程内同步执行，没有跨线程交互。

**盲区**：如果 `SnrInsOnlnProc` 线程本身卡住（等待 mutex / CPU 被抢占），`msg_time_diff_check()` 不会被调用。只有线程恢复后处理积压帧时，才会检测到 `sys_diff` 异常。

### 2.3 代码位置

`localization-mcu/sensor_ins_online/utility/event_statistics.c`

### 2.3 三个核心时间差

在 `msg_time_diff_check(msg_type, grab_time, timestamp_us)` 中计算：

| 时间差 | 计算公式 | 含义 |
|-|-|-|
| **sys_pkt_diff** | `timestamp_us - grab_time` | SOC 系统时间 − 数据包硬件时间戳 → 反映**时钟同步 + 传输延迟** |
| **sys_diff** | `timestamp_us - last_sys` | 本次处理系统时间 − 上次处理系统时间 → 反映**实际处理间隔** |
| **pkt_diff** | `grab_time - last_pkt` | 本次包时间戳 − 上次包时间戳 → 反映**数据源发送间隔** |

### 2.4 IMU 事件（MSG_TYPE_RAW_IMU，200Hz，正常间隔 5ms）

| 事件 | 检测对象 | 触发条件 | 输出方式 |
|-|-|-|-|
| `IMU_PKT_SYS_TIME_DIFF_TOO_LARGE` | sys_pkt_diff | abs > 250ms 或 < 0 | MCU_MLOG + 事件上报 |
| `IMU_SYS_TIME_DIFF_TOO_LARGE` | sys_diff | abs > 15ms | MCU_MLOG + 事件上报 |
| `IMU_SYS_TIME_DIFF_TOO_SMALL` | sys_diff | abs < 5ms | MCU_MLOG + 事件上报 |
| `IMU_PKT_TIME_DIFF_TOO_LARGE` | pkt_diff | abs > 15ms | MCU_MLOG + 事件上报 |
| `IMU_PKT_TIME_DIFF_TOO_SMALL` | pkt_diff | abs < 5ms | MCU_MLOG + 事件上报 |
| `IMU_TIMESTAMP_ROLLBACK` | pkt_diff | < 0 | MCU_MLOG + 事件上报 |
| `IMU_SIX_AXIS_DATA_ALL_ZERO` | 六轴值 | 全为 0 | MCU_MLOG + 事件上报 |

另有 sys_pkt_diff > 40ms 的 warn 日志（仅 MCU_MLOG，不上报事件）。

#### IMU 综合错误判断

| 错误类型 | 条件 | 含义 | 输出方式 |
|-|-|-|-|
| `DROP_FRAME` | pkt ≥ 20ms, sys ≥ 20ms, sys_pkt < 5ms | 数据源端丢帧 | MCU_MLOG |
| `PKT_BLOCK` | pkt ≤ 15ms, sys ≥ 16ms, sys_pkt ≥ 16ms | 处理被阻塞 | MCU_MLOG |
| `TIME_JUMP` | pkt ∈ [900ms,1100ms], sys ≤ 15ms, sys_pkt ∈ [-1100ms,-900ms] | 时钟跳变 | MCU_MLOG |

### 2.5 GNSS/Wheel Speed 事件

| 数据类型 | 正常频率 | sys_pkt 阈值 | pkt/sys 大阈值 | pkt/sys 小阈值 |
|-|-|-|-|-|
| GNSS Pos | \~1-10Hz | 4s (ERROR) / 500ms (WARN) | LP:300ms / 其他:1100ms | LP:0 / 其他:900ms |
| GNSS Vel | \~1-10Hz | 同上 | 同上 | 同上 |
| Wheel Speed | \~50Hz | 4s (ERROR) / 40ms (WARN) | 40ms | 10ms |

LP 车型阈值不同：`kLargeTimeDiff = 300ms, kSmallTimeDiff = 0`（因 lpcom 传输特性）。

### 2.6 处理阶段耗时监控

`process_interval_time_diff_check()` 在各处理阶段前后打点：

| 阶段 | 阈值 | 输出方式 |
|-|-|-|
| `ETH_PKT_PROCESS`（解码器处理） | 10ms | MCU_MLOG + 事件上报 (`DECODER_PROCESS_TIME_TOO_LONG`) |
| `RAW_IMU_HANDLE`（MSF 处理 IMU） | 3ms | MCU_MLOG + 事件上报 (`MSF_PROCESS_TIME_TOO_LONG`) |
| `RAW_POS_HANDLE` / `RAW_VEL_HANDLE` | 3ms | MCU_MLOG + 事件上报 |
| `WHEEL_SPEED_HANDLE` / `LIDAR_HANDLE` | 3ms | MCU_MLOG + 事件上报 |
| `RAW_IMU_SAVE`（存入 map） | 1ms | MCU_MLOG |
| `RAW_POS_SAVE` / `RAW_VEL_SAVE` / ... | 1ms | MCU_MLOG |
| `RAW_IMU_PUBLISH`（消息发布） | 5ms | MCU_MLOG |
| `RAW_LOC_POSE_PUBLISH` / `INTERNAL_STATE_PUBLISH` | 5ms | MCU_MLOG |
| `GET_POSE_FUNC` | 3ms | MCU_MLOG |
| `SENSOR_DECODER_UPDATE_DATA` | 3ms | MCU_MLOG |

### 2.7 CPU 消耗监控

`process_cpu_time_cost_check()` 使用 `getrusage(RUSAGE_SELF)` 监控进程级 CPU 时间：

- 阈值：10ms
- 输出方式：MCU_MLOG

---

## 三、第三层：church ChannelCacheMessageReporter

### 3.1 检测者

`t_SensorInsOnline` 线程内部的定时回调（通过 church scheduler 的 Timeout 每 1 秒触发一次）

### 3.2 检测内容

church 组件的 input channel cache 是否长时间没有新消息到达

### 3.3 线程模型 — 自监控（scheduler 回调）

```
t_SensorInsOnline 线程
    │
    ├─ TaskThreadFunction() 主循环
    │    ├─ 等待消息 → 处理 Proc()
    │    └─ 检查 scheduler Timeout 回调
    │         └─ OnCheckTimeout() {
    │              for (each input channel cache) {
    │                if (cache 最新 index 没变化) {
    │                  if (距上次报告超过 30s)
    │                    → MLOG(WARN) "No message arrived..."
    │                }
    │              }
    │              重新注册 1s 后的 Timeout
    │            }
    │
    └─ 继续循环
```

`OnCheckTimeout()` 通过 church scheduler 的 `Timeout()` 机制在 **t_SensorInsOnline 线程内**执行（scheduler 在 task 线程的主循环中检查定时器）。所以这也是**自监控**。

**盲区**：如果 `t_SensorInsOnline` 线程本身被阻塞（如 Proc() 执行时间过长），Timeout 回调也无法触发。

### 3.4 阈值

`GetReportMessageNotArriveAfterLongIntervalNanoseconds()`（可配置，默认约 30s）

### 3.4 输出方式

**MLOG(WARN)** → `.INFO` 日志文件

### 3.5 日志格式

```
W16:00:06.091087 12 message_report.cc:71] No message arrived in the cache for a long time, task=1, topic=/sensors/someip/rawdata, seconds=18258
```

关键字段：`task=1`（组件 task ID），`topic=...`（断流 topic），`seconds=...`（距上次收到消息的秒数）

### 3.6 可通过配置关闭

`close_topic_report` 字段可以关闭特定 topic 的报告

### 3.7 代码位置

`platform/church/task/message_report.cc`

---

## 四、第四层：church ChannelSuspendAlarm

### 4.1 检测者

church 内部 `c_node_timer` 线程的定时器，每 1 秒检查一次

### 4.2 检测内容

所有组件的所有 input channel 是否超过 30 秒没有收到消息

### 4.3 线程模型 — 跨线程监控

```
iceoryx_dispatch 线程 (Thread 8)           c_node_timer 定时器线程
    │                                          │
    │ 收到 topic 消息                           │
    │ → Node receive observer 回调              │
    │ → UpdateChannelLastArriveTimestamp()       │
    │    └─ 更新 last_arrive_timestamp          │
    │       (直接写入 unordered_map)             │
    │                                          │
    │                                      每 1 秒:
    │                                      ChannelSuspendCheckAndAlarm()
    │                                          │
    │                                      for (each component, each channel) {
    │                                        if (now - last_arrive > 30s)
    │                                          → MLOG(WARN) "No message arrived..."
    │                                      }
```

**跨线程设计**：

- **数据采集**：`UpdateChannelLastArriveTimestamp()` 在 `iceoryx_dispatch` 线程中执行（由 GraphScheduler 注册的 receive observer 触发）
- **异常检测**：`ChannelSuspendCheckAndAlarm()` 在 Timer 线程中执行

注意 `channel_statistics_` 的 map 没有显式加锁（可能依赖于 Timer 和 observer 不并发访问同一 key 的假设，或者有隐式保证）。

### 4.4 阈值

`kAlarmTimeout = 30000000000ULL`（30s，硬编码）

### 4.4 输出方式

**MLOG(WARN)** → `.INFO` 日志文件

### 4.5 日志格式

```
MLOG(WARN) << "No message arrived for a long time, component=" << ... << ", topic=" << ... << ", seconds=" << ...;
```

注意：和第三层的日志格式略有不同（`component=` vs `task=`，`for a long time` vs `in the cache for a long time`）

### 4.6 与第三层的区别

| 属性 | 第三层 MessageReporter | 第四层 ChannelSuspendAlarm |
|-|-|-|
| 检测线程 | 组件 task 线程内部 | c_node_timer 定时器 |
| 粒度 | 每个 task 的 cache | 每个 component 的每个 channel |
| 适用范围 | 传统 SchedulerOneTaskOneThread | GraphPipe 调度器 |
| 日志关键字 | `task=` | `component=` |

### 4.7 代码位置

`platform/church/graph/channel_suspend_alarm.cc`

---

## 五、第五层：church ComProcTimeUnit

### 5.1 检测者

`c_anomaly_monitor` 线程 — 周期性检查所有组件的 Proc() 执行时间

### 5.2 检测内容

组件 `Proc()` 方法的实际执行时间是否超过 `expected_proc_duration_ms`

### 5.3 线程模型 — 典型跨线程 Observer 模式

这是最经典的跨线程监控设计：

```
t_SensorInsOnline 线程 (Thread 12)              c_anomaly_monitor 线程 (Thread 10)
─────────────────────────────────              ────────────────────────────────
                                               AnomalyMonitor::Start() {
                                                 while (!stop) {
                                                   sleep(100ms);
                                                   // 每 1000ms 执行一次:
Component::Process() {                             ComProcTimeUnit::UnitRoutine() {
  ┌─ observer->ProcessBegin() ─┐                     CheckState() {
  │  lock(proc_record_.mutex)  │                       lock(proc_record_.mutex)
  │  on_going[frame_id] = {    │                       ┌─ 检查 timeout_process 队列
  │    begin_time = now()      │                       │  (ProcessEnd 已发现的超时)
  │  }                         │                       │
  │  unlock(mutex)             │                       ├─ 遍历 on_going_process:
  └────────────────────────────┘                       │  duration = now - begin_time
                                                       │  if (duration >= 100ms * 1000)
  ┌─ Proc() [业务逻辑] ─┐                              │    → 检测到超时！
  │  ... 可能耗时很久 ... │ ← c_anomaly_monitor 此时   │
  └──────────────────────┘   能检测到 on_going 超时!    │  → MLOG(ERROR) "proc time out"
                                                       │  → ReportEvent(PROC_TIMEOUT)
  ┌─ observer->ProcessEnd() ──┐                        └─ unlock(mutex)
  │  lock(proc_record_.mutex)  │                     }
  │  duration = now - begin    │                   }
  │  if (duration >= timeout)  │                   sleep(100ms);
  │    timeout_process.push()  │                   ...
  │  on_going.erase(frame_id)  │                 }
  │  unlock(mutex)             │               }
  └────────────────────────────┘
```

**两阶段检测**：

1. **ProcessEnd 检测**（在 t_SensorInsOnline 线程）：Proc() 正常结束后，`ProcessEnd` 回调计算 duration，如果超时则放入 `timeout_process` 队列。这种情况下 Proc() 虽然慢但最终完成了。
2. **CheckState 检测**（在 c_anomaly_monitor 线程）：定期检查 `on_going_process` 中是否有长时间未完成的 Proc()。**这是唯一能检测到"线程卡死"的机制** — 如果 Proc() 一直没返回（死锁/无限循环），`ProcessEnd` 永远不会被调用，但 c_anomaly_monitor 可以发现 `on_going_process` 中的 begin_time 越来越老。

**线程安全**：通过 `proc_record_.mutex`（RealtimeMutex）保护共享的 `on_going_process` map 和 `timeout_process` vector。

### 5.4 阈值

由组件 jsonnet 配置文件指定。对于 `sensor_ins_online`：

```
expected_proc_duration_ms: 100
```

即 Proc() 执行时间超过 100ms 即告警。`component_timeout()` 返回 `expected_duration_ * 1000`（微秒）。

### 5.4 输出方式

双通道：

- **MLOG(ERROR)** → `.INFO` 日志文件
- **ReportEvent(`CHURCH_PROC_TIMEOUT_EVENT`)** → 事件上报

### 5.5 日志格式

```
E... sensor_ins_online proc time out !!!, proc run id: 42, begin time: ..., duration: 150 ms, expected duration: 100 ms
```

### 5.6 事件上报附带信息

```json
{
  "component_name": "sensor_ins_online",
  "proc_id": 42,
  "proc_start_timestamp_ns": 1234567890,
  "proc_duration_ms": 150,
  "expected_proc_duration_ms": 100
}
```

### 5.7 代码位置

`platform/church/component/proc_time_unit.cc`

---

## 六、事件汇总层：EventReporter

### 6.1 角色

`event_report` 线程不自己检测异常，而是收集所有通过 `ReportEvent()` 上报的事件，打包发布到 church topic `/church/module_events`。

### 6.2 溢出处理

如果一个周期内事件数量超过 `report_buffer_size_`（默认 60），只保留最新的 N 个事件，并将被裁剪的事件打印到 MLOG 日志：

```
W... event_reporter.cc:69] The number of events exceeds buffer size, report the newest 60 events.
I... event_reporter.cc:80] Event Log: module: SENSOR_INS ...
```

### 6.3 事件去重（Debounce）

DEM 系统对事件做 Debounce 处理，由 `driver/config/module_event/event_analysis.jsonnet` 配置：

| 事件类型 | Debounce 参数 |
|-|-|
| IMU 时间差事件 | `Debounce(true, 10, 0, 200)` → 10 次触发后上报，200s 恢复窗口 |
| Wheel Speed 事件 | `Debounce(true, 3, 0, 300)` → 3 次触发后上报，300s 恢复窗口 |
| 对准事件 | `Debounce(true, 3, 0, 300)` |
| lpcom 通信事件 | 各自独立配置 |

### 6.4 代码位置

`platform/church/component/event_reporter.cc`

---

## 七、输出方式汇总

| 输出方式 | 文件 / 目标 | 特点 |
|-|-|-|
| **MCU_MLOG** (.clog) | `dr_sensor_ins_online_clog.log` | 纯 C 日志，tlog 后端，`tlog_work` 线程写入 |
| **MLOG** (.INFO) | `dr_sensor_ins_online.log.INFO.*` | C++ 日志，glog/spdlog 后端，`async_logger` 线程写入 |
| **std::cout** (stdout) | 进程标准输出 | 无缓冲直接输出，无频率限制（如 Params error） |
| **事件上报** (ReportEvent) | EventLog 队列 → event_report 线程 → church topic | DEM 系统消费，带 Debounce |
| **ScheduleMonitor** | sched_monitor 线程 → church topic | 记录每次 Proc 的开始/结束时间戳，供外部分析 |

---

## 八、断流场景下各层的表现

以 402ms 断流为例（16:02:29.207 \~ 16:02:29.615）：

| 层级 | 是否触发 | 原因 |
|-|-|-|
| ① lpcom kFrameTimeout (30ms) | **未触发** | 数据在 lpcom 层正常到达，问题在下游 |
| ① lpcom kLoseTimeout (100ms) | **未触发** | 同上 |
| ② IMU_SYS_TIME_DIFF_TOO_LARGE | **触发** | 恢复后第一帧 sys_diff ≈ 407ms >> 15ms |
| ② IMU_PKT_SYS_TIME_DIFF_TOO_LARGE | **触发** | 积压帧 sys_pkt_diff ≈ 398ms >> 250ms |
| ② DECODER_PROCESS_TIME_TOO_LONG | **触发** | 解码器处理耗时 402200μs >> 10ms |
| ② IMU_SYS_TIME_DIFF_TOO_SMALL | **连续触发** | 积压帧连续处理 sys_diff ≈ 几十μs << 5ms |
| ③ MessageReporter | **未触发** | 断流 402ms << 30s 阈值 |
| ④ ChannelSuspendAlarm | **未触发** | 同上 |
| ⑤ ProcTimeUnit (100ms) | **可能触发** | 如果 Proc() 恰好在积压期间被调用且阻塞 |
| ⑥ EventReporter 溢出 | **触发** | 事件数量超过 buffer size 60 |

### 关键推断

**"帧超时和断流超时没报，但报了传输延时过长"** 说明：

1. 数据在 **lpcom 通信层（ADPU → lpLocation → mq_recv → thread_pool）正常传输**
2. 问题发生在 **SnrInsAsembProc 或 SnrInsOnlnProc 的处理阶段**
3. 数据正常到达了进程，但被阻塞在 SPSC 队列中，等待 402ms 才被处理
4. 可能原因：mutex 竞争、CPU 被抢占、Kalman 滤波积压处理

---

## 九、liball.dlib 坐标转换异常

### 9.1 open dl error（加载失败）

- 来源：`driver/integration/components/sensor_ins_online_component.cc:113`
- 含义：`/opt/usr/oem/opt/deeproute/localization/lib/deflection/liball.dlib` 文件缺失
- 输出方式：`MLOG_EVERY(ERROR, 100)` → `.INFO` 日志，每 100 次调用打印一次
- 频率：约 10 秒一次（GNSS 10Hz × 100 次 = 10s）
- 后果：GCJ02 坐标转换降级为软件算法 `WGS84ToGCJ02`

### 9.2 Params error（参数无效）

- 来源：`driver/integration/components/sensor_ins_online_component.cc:128-131`
- 含义：`WgtoChinaLb` 函数加载成功但返回错误（参数无效）
- 输出方式：`std::cout`（stdout），**无频率限制**
- 典型参数：`lon:0, lat:0, week:-522, heit:0`
- 原因：系统时钟未同步（停在 1970-01-01），GPS week 计算为负数
- 特征：启动阶段大量刷屏，NTP 同步后消失
