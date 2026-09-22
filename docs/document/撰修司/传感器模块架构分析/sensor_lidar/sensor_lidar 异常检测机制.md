---
title: "sensor_lidar 异常检测机制"
date: 2026-09-20
description: "基准平台：LP8650-V1-SHARE"
categories:
  - 撰修司
tags:
  - sensor_lidar
---

# sensor_lidar 异常检测机制

> 基准平台：LP8650-V1-SHARE  
> 生成日期：2026-04-16

---

## 1. 异常检测层次总览

| 层级 | 检测机制 | 检测维度 | 执行线程 | 输出方式 |
|-|-|-|-|-|
| L1 | `LidarTimeChecker` | 包间隔异常 / 系统-数据时间差 | 接收线程（同步调用） | `MLOG(WARN/ERROR)` + `ReportEvent` + 可选丢包 |
| L2 | 输入超时检测 | UDP 连续无数据 | 接收线程（同步调用） | `MLOG(ERROR)` + `ReportEvent` |
| L3 | 点云数量检测 | 发布点数过少 | ProcessCloud 线程 | `MLOG(ERROR)` + `ReportEvent` |
| L4 | `Watchdog` 看门狗 | 数据包接收超时 | `sensors_watch_dog` | `MLOG(ERROR)` + `ReportEvent`（需项目注册） |
| L5 | `FrameRateCheck` 帧率检查 | 帧率过低 / 过高 | `sensors_frame_rate_checker` | `MLOG(ERROR/WARN)` + `ReportEvent`（需项目注册） |
| L6 | SPSC 队列满检测 | ring_buffer 溢出 | 接收线程 (多雷达) | `MLOG(ERROR)` + `ReportEvent` |
| L7 | 帧超时强制发布 | FrameTimer 超时 | CloudCheck 线程 | 设 `manual_update_flag` → 强制 Publish |
| C1 | Church `ChannelSuspendAlarm` | 输出通道消息停发 | Church 监控线程 | `MLOG(WARN)` |
| C2 | Church `ComProcTimeUnit` | Proc() 执行超时 | `c_anomaly_monitor` | `MLOG(ERROR)` + `CHURCH_PROC_TIMEOUT_EVENT` |
| C3 | Church `EventReporter` | 事件聚合发布 | `event_report` | `/church/module_events` |

> **与 sensor_radar 的关键区别**：sensor_lidar **不使用 lpcom**，因此没有 L1 级别的 lpcom SDK Topic 监控（`topic_monitor` / `ErrorCodeCallback`）。sensor_lidar 的 L1 层由应用内的 `LidarTimeChecker` 承担。

---

## 2. L1: LidarTimeChecker — 包时间校验

### 2.1 位置

`sensors/utility/lidar/lidar_utils.hpp` 中的 `LidarTimeChecker` 类，在每次收包后同步调用。

### 2.2 检测逻辑

每次收到数据包后执行两项检查：

**检查 A：包间隔异常**（`pkt_time_interval`）

- 计算当前包的 **LiDAR 硬件时间戳** 与上一包硬件时间戳的差值（`|timestamp - last_pkt_timestamp_|`）
- 超过 `pkt_interval_threshold_` → `ReportEvent(SENSOR_LIDAR, LIDAR_INPUT_PKT_TIME_DIFF_TOO_LARGE)`

**检查 B：系统时间-数据时间差**（`pkt_sys_time_diff`）

- 计算 `|DataPlaneTime::Now() - pkt_timestamp|`，即 **PTP 系统时间** 与包内 LiDAR 硬件时间戳的偏差
- 超过 `error_pkt_and_sys_interval_threshold_` → `ReportEvent(SENSOR_LIDAR, LIDAR_INPUT_PKT_SYS_TIME_DIFF_TOO_LARGE)`
- 超过 `drop_pkt_and_sys_interval_threshold_` → 丢弃该包（返回 `false`）
- 介于两者之间 → 打日志 "still using"，数据保留但上报事件

### 2.3 阈值

| 雷达型号 | Event 阈值 | Drop 阈值 | 上报间隔 |
|-|-|-|-|
| 默认 | 100,000 µs (100ms) | 400,000 µs (400ms) | 50-100ms |
| RoboSense RS_MX_SOLID | 150,000 µs (150ms) | 600,000 µs (600ms) | 50-100ms |

---

## 3. L2: 输入超时检测

### 3.1 单雷达模式

```cpp
// lidar_helper_single.cpp
constexpr int kTimeoutCountThres = 50;  // 连续 ~50 次 EAGAIN
```

当 `data_stream_ptr_->read()` 连续返回 EAGAIN 超过 `kTimeoutCountThres` 次：

- `ReportEvent(SENSOR_LIDAR, LIDAR_INPUT_TIMEOUT)`

UDP socket 配置 `kUdpRecvTimeout = 3000 µs`，因此 50 次超时约等于 \~150ms 无数据。

### 3.2 多雷达模式

```cpp
// lidar_helper_multi.cpp
constexpr int kRptInputTimeoutIntv = 1000;  // ms
```

每个接收线程独立检测 EAGAIN，以 1000ms 为间隔去重上报：

- `ReportEvent(SENSOR_LIDAR, LIDAR_INPUT_TIMEOUT, json_with_frame_id, kRptInputTimeoutIntv)`

JSON payload 包含 `frame_id`，用于区分哪个雷达超时。

### 3.3 QNX 多雷达模式

使用 `poll(..., 10ms)`，无独立超时事件上报。

---

## 4. L3: 点云数量检测

发布时检查点云点数：

```cpp
// lidar_helper_base.h
size_t point_cloud_min_threshold_ = 500;
```

如果 `current_cloud_ptr_->size() < point_cloud_min_threshold_`：

- `ReportEvent(SENSOR_LIDAR, LIDAR_OUTPUT_CLOUD_NUM_TOO_FEW)`

此检查在 `Publish()` 路径中同步执行。

---

## 5. L4: Watchdog 看门狗

### 5.1 机制

`Watchdog` 单例（`sensors/utility/common/sensors_utils.hpp`）运行一个后台线程 `sensors_watch_dog`：

- 项目通过 `WatchdogInstance().RegisterMs(key, interval, module, event)` 注册
- 后台线程周期检查 `last_feed_time + interval` 是否已过
- 超时 → `ReportEvent(module, event)`

数据收包路径中调用 `WatchdogInstance().FeedLoop(key)` 喂狗。

### 5.2 项目注册情况

| 项目 | 是否注册 | 超时阈值 | 事件 |
|-|-|-|-|
| LP8650-V1 | **未注册** | — | watchdog 线程空转 |
| LP8797-V1 | **未注册** | — | watchdog 线程空转 |
| Smart HY11 | ✅ 注册 | 100ms | `LIDAR_LOST_COMMUNICATION` |
| GWM C01 | 需确认 | — | — |

> **重要发现**：LP8650 的 `LidarManager` 未调用 `WatchdogInstance().RegisterMs()`，因此虽然 `sensors_watch_dog` 线程存在且 `FeedLoop` 被调用，但由于没有注册 key，watchdog 不会产生任何事件。这意味着 **LP8650 上 LiDAR 数据完全中断时，watchdog 层面不会上报**。

---

## 6. L5: FrameRateCheck 帧率检查

### 6.1 机制

`FrameRateCheck` 单例运行 `sensors_frame_rate_checker` 线程：

- 项目通过 `FrameRateCheckRegister(key, interval, min, max, module, event)` 注册
- 在 Publish 路径中调用 `AddFrameCount(key)` 累加计数
- 线程每 `interval` ms 检查计数是否在 `[min, max]` 范围内

### 6.2 项目注册情况

| 项目 | 是否注册 | 检查间隔 | 期望帧数范围 |
|-|-|-|-|
| LP8650-V1 | **未注册** | — | frame_rate 线程空转 |
| Smart HY11 | ✅ 注册（仅单雷达模式） | 1000ms | 6300 ± 2000 (每秒包数) |

---

## 7. L6: SPSC 队列满检测

仅存在于多雷达 Linux 模式 (`LidarHelperMulti`)：

```cpp
// lidar_helper_multi.cpp
boost::lockfree::spsc_queue<..., capacity<256>> ring_buffer_;
```

当 `ring_buffer_.push()` 失败（队列满）：

- `MLOG(ERROR)` 记录溢出
- `ReportEvent(SENSOR_LIDAR, LIDAR_RUNTIME_CLOUD_OVERFLOW)`

触发条件：接收线程持续产出数据，但 ProcessCloud 拼装线程消费不及。

---

## 8. L7: 帧超时强制发布

多雷达模式下，`CloudCheck` 线程周期检查 FrameTimer：

```
if (current_time - last_frame_time > kFrameInterval + cloud_timeout_threshold):
    set manual_update_flag_
    cv_.notify_one()  → ProcessCloud 强制 Publish
```

- `kFrameInterval = 100,000 µs` (100ms)
- `cloud_timeout_threadshold`（proto 中原始命名）来自 lidar_config.proto，默认 20,000 µs (20ms)
- 即超过 **120ms** 无帧完成信号时强制发布

---

## 9. Church 层级异常检测 (C1-C3)

与 sensor_radar 和 sensor_ins_online 共用同一套 Church 框架机制：

### C1: ChannelSuspendAlarm

监控 `output_channels` 中声明了 `need_topic_supervision: true` 的 topic：

- 主点云 topic (`/sensors/lidar/combined_point_cloud_proto`) 启用
- 长时间无消息发布 → `MLOG(WARN)`

### C2: ComProcTimeUnit

监控 `Proc()` 执行耗时：

- 由于 `Proc()` 为空实现，通常不会触发
- 超时 → `CHURCH_PROC_TIMEOUT_EVENT`

### C3: EventReporter

聚合所有 `ReportEvent()` 调用，通过 `/church/module_events` topic 发布到系统级事件总线。

---

## 10. 事件码汇总

| 事件码 | 含义 | 触发层级 | 上报方式 |
|-|-|-|-|
| `LIDAR_INIT_DECODER_TYPE_WRONG` | 解码器类型不匹配 | Init | `ReportEvent` |
| `LIDAR_INIT_STREAM_TYPE_WRONG` | 流类型配置错误 | Init | `ReportEvent` |
| `LIDAR_INIT_STREAM_CONNET_WRONG` | 网络连接失败 | Init | `ReportEvent` |
| `LIDAR_INPUT_TIMEOUT` | 输入超时（UDP 无数据） | L2 | `ReportEvent` |
| `LIDAR_INPUT_READ_FAIL` | 读取失败 | L2 | `ReportEvent` |
| `LIDAR_INPUT_PKT_TIME_DIFF_TOO_LARGE` | 包间隔异常 | L1 | `ReportEvent` |
| `LIDAR_INPUT_PKT_SYS_TIME_DIFF_TOO_LARGE` | 系统-数据时间差异常 | L1 | `ReportEvent` |
| `LIDAR_RUNTIME_CLOUD_OVERFLOW` | SPSC 队列溢出 | L6 | `ReportEvent` |
| `LIDAR_OUTPUT_CLOUD_NUM_TOO_FEW` | 输出点数过少 | L3 | `ReportEvent` |
| `LIDAR_ABNORMAL_FRAME_JITTER` | 帧抖动（仅 HY11 构建） | L1 | `ReportEvent` |
| `LIDAR_ABNORMAL_FRAME_RATE` | 帧率异常 | L5 | `ReportEvent` |
| `LIDAR_LOST_COMMUNICATION` | 通信丢失 | L4 | `ReportEvent` |
| `CHURCH_PROC_TIMEOUT_EVENT` | Proc 超时 | C2 | Church 内部 |

---

## 11. 与 sensor_radar / sensor_ins_online 异常检测对比

| 维度 | sensor_lidar | sensor_radar | sensor_ins_online |
|-|-|-|-|
| lpcom Topic 监控 | ❌ 不使用 lpcom | ✅ `topic_monitor` + `ErrorCodeCallback` | ✅ `topic_monitor` + `ErrorCodeCallback` |
| 时间校验 | `LidarTimeChecker` (应用内) | `TimestampAnomalyDetection` | `event_statistics` (C 层) |
| 硬件状态检查 | ❌ 无 | ✅ `CheckRadarStatus` | — |
| Watchdog | 项目依赖（LP8650 未注册） | ✅ 所有项目注册 | — |
| FrameRate | 项目依赖（LP8650 未注册） | ✅ 所有项目注册 | — |
| SPSC 溢出 | ✅ (多雷达模式) | ✅ | ✅ |
| Church C1-C3 | ✅ | ✅ | ✅ |
| lpcom 线程 | ❌ 无 | `thread_pool`、`event_loop` 等 | `thread_pool`、`event_loop`、`mq_recv` 等 |

### LP8650 上的监控覆盖缺口

由于 LP8650 平台的 `LidarManager` 未注册 Watchdog 和 FrameRateCheck 回调：

1. **LiDAR 完全断流**时，只能依靠 Church C1 (`ChannelSuspendAlarm`) 检测输出 topic 停发
2. **帧率异常**（如从 10Hz 降到 5Hz）不会被检测
3. 建议 LP8650 平台也注册 Watchdog 和 FrameRateCheck，与 Smart HY11 对齐
