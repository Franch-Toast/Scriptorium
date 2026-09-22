---
title: "sensor_radar 线程清单"
date: 2026-09-20
description: "基准平台：LP8650-V1-SHARE"
categories:
  - 撰修司
tags:
  - sensor_radar
---

# sensor_radar 线程清单

> 基准平台：LP8650-V1-SHARE  
> 生成日期：2026-04-02

---

## 1. 线程总览

| # | 线程名称 | 类别 | 创建者 | 职责简述 |
|-|-|-|-|-|
| 1 | `t_Radar` | Church 任务线程 | Church Scheduler | 组件 `Proc()` 执行线程（空实现） |
| 2 | `SnrRadAsembProc` | 核心业务线程 | `RadarHelper::Start()` | 解码、汇总、坐标变换、合并发布 |
| 3 | (status_thread) | 业务监控线程 | `RadarHelper::Start()` | 每秒检查各雷达在线状态 |
| 4 | `RadarPcProc` | 业务线程 | `RadarHelperPointCloud::Start()` | 4D 点云合并发布（LP 平台未启用） |
| 5 | `thread_pool` | lpcom 内部线程 | `liblpCom.so` | lpcom 接收回调分发 |
| 6 | `event_loop` | lpcom 内部线程 | `liblpCom.so` | lpcom 事件循环 |
| 7 | `sensors_watch_dog` | 公共监控线程 | `Watchdog` 单例 | 数据包超时看门狗 |
| 8 | `sensors_frame_rate_checker` | 公共监控线程 | `FrameRateCheck` 单例 | 帧率异常检测 |
| 9 | `iceoryx_dispatch` | Church 基础线程 | Church Runtime | iceoryx 消息分发 |
| 10 | `sched_monitor` | Church 基础线程 | Church Runtime | 调度事件记录 |
| 11 | `event_report` | Church 基础线程 | Church Runtime | 事件聚合与发布 |
| 12 | `c_anomaly_monitor` | Church 基础线程 | Church Runtime | `Proc()` 执行超时监控 |
| 13 | `c_node_timer` | Church 基础线程 | Church Runtime | 定时器管理 |
| 14 | `s_monitor` | Church 基础线程 | Church Runtime | 系统监控 |
| 15 | `s_timer` | Church 基础线程 | Church Runtime | 系统定时器 |
| 16 | `topic_monitor` | Church 基础线程 | Church Runtime | lpcom Topic 监控 |
| 17 | `iox_keepalive` | iceoryx 线程 | iceoryx runtime | 心跳维持 |
| 18 | `async_logger` | 日志线程 | MLOG 系统 | 异步日志写入 |
| 19 | `compress_logfiles` | 日志线程 | 日志系统 | 日志文件压缩 |
| 20 | `crash_reporter` | 崩溃处理线程 | Crash 框架 | 崩溃信号捕获与报告 |

> 注：LP8650 平台 `sensor_radar` 不使用 `RadarHelperPointCloud`，因此 `RadarPcProc` 线程实际不会创建。

---

## 2. 核心线程详解

### 2.1 `t_Radar` — Church 任务线程

**创建**：Church `SchedulerOneTaskOneThread` 根据 `sensor_radar.jsonnet` 配置创建。

**配置**（来自 `thread_config/LP8650-V1-SHARE/sensor_radar.json`）：

```json
{
    "name": "t_Radar",
    "policy": "SCHED_RR",
    "priority": 35,
    "cpuset": "0-3"
}
```

**行为**：

- `Proc()` 实现为空（`return true`），不处理任何数据
- 因为 `input_channels` 为空且 `trigger_policy: 'ANY'`，该线程几乎不会被触发
- 主要为 Church 框架提供组件生命周期管理（`Init()`, `Clear()`）

### 2.2 `SnrRadAsembProc` — 核心解码汇总线程

**创建**：`RadarHelper::Start()` 中通过 `deeproute::base::Thread` 创建。

**配置**：

```json
{
    "name": "SnrRadAsembProc",
    "policy": "SCHED_RR",
    "priority": 35,
    "cpuset": "0-3"
}
```

**执行循环**：

```
while(is_running):
    ┌─ mutex lock ─┐
    │ cv_.wait()   │ ← 等待 is_available_ 为 true
    └──────────────┘
    mutex unlock（立即释放，避免阻塞回调线程）

    CheckTimeoutTriggerIgnore()
      → 检查各雷达首次接收时间
      → 超过 timeout_ignore_threshold_us_ 则标记 OFFLINE

    AssembleAndPublish():
      ┌─ mutex lock ─┐
      │ 获取活跃 decoder 快照 │
      └──────────────┘
      for each active decoder (无锁区域):
        while queue->pop(data):
          DecodePacket(data → Radar proto)
          TimeStampCheck(key, timestamp)
          TransformProject(buffer, transform)
          decoder_info->buffer = buffer
          decoder_info->is_ready = true
          if AllDecodersReady():
            CollectBuffers() → publish_callback_()

    is_available_ = false
```

**关键设计**：

- `cv_.wait()` 之后**立即释放 mutex**，避免与 lpcom 回调线程死锁
- `AssembleAndPublish()` 在获取活跃 decoder 快照后以**无锁方式**处理队列数据
- 是 `sensor_radar` 中唯一执行 DecodePacket 和发布的线程

### 2.3 status_thread — 雷达在线状态监控

**创建**：`RadarHelper::Start()` 中通过 `std::thread` 创建（无命名线程）。

**执行循环**：

```
while(is_running):
    for each decoder:
        if !is_live_func() || live_status == OFFLINE:
            MLOG(ERROR) << frame_id << " radar is not live"
    sleep_for(1s)
```

**说明**：

- 每秒检查一次所有雷达的在线状态
- `is_live_func()` 由 RadarManager 提供，检查 lpcom 通道匹配状态
- 当雷达被 `CheckTimeoutTriggerIgnore()` 标记为 `OFFLINE` 后，该线程持续报错
- **与 `sensor_ins_online` 和 `sensor_uss` 的区别**：这是 radar 独有的专用在线状态监控线程

### 2.4 `thread_pool` — lpcom 回调分发线程

**创建**：`liblpCom.so` 内部创建。

**职责**：

- 当 lpcom 共享内存收到新的雷达数据包时，`thread_pool` 调用注册的 `MessageCallback`
- 对应调用链：

  ```
  thread_pool → HandleMrr1Message() → memcpy → radar_callback_map_["mrr_1"]()
                                        → SPSC queue push → cv_.notify_one()
  ```
- 同一个 `thread_pool` 线程为三个 topic 的回调服务

### 2.5 公共监控线程

#### `sensors_watch_dog`

**创建**：`Watchdog` 单例构造函数中通过 `deeproute::base::Thread` 创建。

**配置**：

```json
{
    "name": "sensors_watch_dog",
    "policy": "SCHED_RR",
    "priority": 35,
    "cpuset": "0-3"
}
```

**职责**：

- `RadarHelper` 回调中每次收到数据调用 `WatchdogInstance().FeedLoop(key)` 喂狗
- 如果在注册的时间间隔内未收到喂狗信号，触发 `MLOG(ERROR)` 和 `ReportEvent()`
- 与 `sensor_ins_online` / `sensor_uss` 共用同一个 `Watchdog` 类实现

#### `sensors_frame_rate_checker`

**创建**：`FrameRateCheck` 单例构造函数中创建。

**职责**：

- 按注册的时间窗口统计帧计数
- 帧率低于 `minCount` 或高于 `maxCount` 时输出 `MLOG(ERROR/WARN)` 并上报事件
- RadarManager 中可通过 `FrameRateCheck::AddFrameCount()` 注册使用

---

## 3. 线程交互图

```
                            lpcom 共享内存
                                 │
                    ┌────────────▼────────────┐
                    │  thread_pool (lpcom)     │
                    │  HandleMrr1Message()     │
                    │  HandleSrr1Message()     │
                    │  HandleSrr2Message()     │
                    │    │                     │
                    │    ├─ memcpy → RadarObjects
                    │    ├─ WatchdogInstance().FeedLoop()──────────┐
                    │    ├─ SPSC queue.push() ──────────────┐      │
                    │    └─ cv_.notify_one()────────────┐   │      │
                    └──────────────────────────────────│───│──────│┘
                                                       │   │      │
                    ┌──────────────────────────────────▼───▼──┐   │
                    │  SnrRadAsembProc                         │   │
                    │    cv_.wait()                            │   │
                    │    ├─ SPSC queue.pop()                   │   │
                    │    ├─ DecodePacket()                     │   │
                    │    ├─ TimeStampCheck() ──────────────────│───│──┐
                    │    ├─ TransformProject()                 │   │  │
                    │    ├─ AllDecodersReady()?                │   │  │
                    │    └─ CollectBuffers()                   │   │  │
                    │         └─ publish_callback_() ──────┐  │   │  │
                    └──────────────────────────────────────│──┘   │  │
                                                           │      │  │
                    ┌──────────────────────────────────────▼──┐   │  │
                    │  t_Radar (Church)                        │   │  │
                    │    node()->PublishWithSourceTimestamp()   │   │  │
                    │    → iceoryx 发布                         │   │  │
                    └─────────────────────────────────────────┘   │  │
                                                                  │  │
                    ┌─────────────────────────────────────────────▼┐ │
                    │  sensors_watch_dog                            │ │
                    │    Monitor():                                 │ │
                    │      检查 FeedLoop 间隔                        │ │
                    │      超时 → MLOG(ERROR) + ReportEvent()      │ │
                    └──────────────────────────────────────────────┘ │
                                                                     │
                    ┌────────────────────────────────────────────────▼┐
                    │  TimestampAnomalyDetection (同步调用, 无独立线程) │
                    │    Check():                                      │
                    │      PKT_INTERVAL_ERROR → MLOG(WARN)            │
                    │      DIFF_DATA_AND_PKT_ERROR → 丢弃帧            │
                    │      PKT_TIME_BACK_ERROR → 丢弃帧                │
                    └──────────────────────────────────────────────────┘

                    ┌──────────────────────────────────────────────┐
                    │  status_thread (无名线程)                      │
                    │    每秒遍历所有 decoder:                       │
                    │      is_live_func()==false → MLOG(ERROR)     │
                    │      LiveStatus::OFFLINE → MLOG(ERROR)       │
                    └──────────────────────────────────────────────┘
```

---

## 4. 线程配置（LP8650-V1-SHARE）

来自 `/sandbox/driver/config/thread_config/LP8650-V1-SHARE/sensor_radar.json`：

| 线程名称 | 调度策略 | 优先级 | CPU 亲和性 |
|-|-|-|-|
| `t_Radar` | `SCHED_RR` | 35 | 0-3 |
| `SnrRadAsembProc` | `SCHED_RR` | 35 | 0-3 |
| `service_monitor` | `SCHED_RR` | 10 | 0-3 |
| `sensors_watch_dog` | `SCHED_RR` | 35 | 0-3 |
| `compress_logfiles` | `SCHED_RR` | 10 | 0-3 |
| `sched_monitor` | `SCHED_RR` | 21 | 0-3 |

**默认配置**（未列出的线程）：

- `default_thread_task_cpuset`: `0-3`
- `default_thread_policy`: `SCHED_RR`
- `default_thread_priority`: 20

---

## 5. 与 sensor_ins_online / sensor_uss 的线程对比

| 对比项 | sensor_ins_online | sensor_uss | sensor_radar |
|-|-|-|-|
| Church 任务线程 | `t_SensorInsOnline` (Proc 存数据) | `t_Ultrasonic` (Proc 空) | `t_Radar` (Proc 空) |
| 核心解码线程 | `SnrInsAsembProc` | `SnrUssAsembProc` | `SnrRadAsembProc` |
| 发布驱动线程 | `SnrInsOnlnProc` (独立频率) | `SnrUssAsembProc` | `SnrRadAsembProc` |
| 专用状态监控 | 无 | 无 | **status_thread（每秒检查）** |
| 点云发布线程 | 无 | 无 | `RadarPcProc`（LP 未启用） |
| lpcom 线程 | `thread_pool`, `event_loop`, `mq_recv` | `thread_pool`, `event_loop` | `thread_pool`, `event_loop` |
| Watchdog 线程 | `sensors_watch_dog` | `sensors_watch_dog` | `sensors_watch_dog` |
| 帧率检查线程 | `sensors_frame_rate_checker` | `sensors_frame_rate_checker` | `sensors_frame_rate_checker` |
| C 日志线程 | `tlog_work` (MCU_MLOG) | 无 | 无 |
| 总线程数 (估计) | \~25 | \~18 | \~20 |

**sensor_radar 独有特点**：

1. **status_thread**：雷达特有的在线状态周期性检查（1 秒间隔），其他模块无此设计
2. **RadarPcProc**（潜在）：4D 雷达点云的独立发布线程，LP 平台虽未启用但代码支持
3. 无 C 语言算法，因此无 `tlog_work` 日志线程
4. 无 POSIX MQ 通信，因此无 `mq_recv` 线程
