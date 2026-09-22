---
title: "sensor_uss 线程清单"
date: 2026-09-20
description: "sensor_uss 的线程数量远少于 sensor_ins_online，因为它没有独立的算法层和纯 C 日志系统。"
categories:
  - 撰修司
tags:
  - sensor_uss
---

# sensor_uss 线程清单

## 一、线程总览

sensor_uss 的线程数量远少于 sensor_ins_online，因为它没有独立的算法层和纯 C 日志系统。

### 预估线程列表（LP 车型）

| 序号 | 线程名 | 来源 | 作用 |
|-|-|-|-|
| 1 | (main) | OS | 主线程 |
| 2 | `async_logger` | MLOG | 异步日志写入 |
| 3 | `t_Ultrasonic` | church | 组件 task 线程（Proc 为空，仅作为 church 容器） |
| 4 | `SnrUssAsembProc` | UltrasonicHelper | 数据解码和组装发布线程 |
| 5 | `iceoryx_dispatch` | church/iceoryx | 消息分发 |
| 6 | `iox_keepalive` | iceoryx | 共享内存心跳 |
| 7 | `sched_monitor` | church | 调度事件记录 |
| 8 | `event_report` | church | 事件收集与转发 |
| 9 | `c_anomaly_monitor` | church | 异常监控（Proc 超时等） |
| 10 | `s_monitor` | church | 进程状态监控 |
| 11 | `s_timer` | church | 定时器线程 |
| 12 | `c_node_timer` | church | Node 层定时器 |
| 13 | `topic_monitor` | lpcom SDK | lpcom topic 帧超时/断流监控 |
| 14 | `thread_pool` | lpcom SDK | lpcom 数据接收线程池 |
| 15 | `event_loop` | lpcom SDK | lpcom 事件循环 |
| 16 | `sensors_watch_d` | sensors | Watchdog 看门狗 |
| 17 | `sensors_frame_r` | sensors | 帧率统计 |
| 18 | `crash_reporter` | church | 崩溃上报 |
| 19 | `compress_logfil` | MLOG | 日志压缩（可能 2 个） |

**与 sensor_ins_online 相比缺少的线程**：

- `SnrInsOnlnProc` — 因为没有独立算法层（InsOnlineManager）
- `mq_recv` — lpLocation 的 POSIX MQ 线程，USS 不使用
- `tlog_work` — 纯 C 日志线程，USS 没有纯 C 算法

---

## 二、数据路径线程详解

### 2.1 thread_pool（lpcom SDK）

**作用**：lpcom SDK 内部线程池，负责接收 lpcom 共享内存数据并调用已注册的回调函数

**创建者**：lpcom SDK 内部

**行为**：

- 收到 `/leap/uss/detector_adas` → 调用 `HandleUSSProbeMessage()`
- 收到 `/leap/uss/obstacle_adas` → 调用 `HandleUSSObstacleMessage()`
- 回调在 thread_pool 线程中**同步执行**

### 2.2 SnrUssAsembProc

**作用**：解码和组装发布线程，相当于 sensor_ins_online 中 `SnrInsAsembProc` 的角色

**创建者**：`UltrasonicHelper::Start()` at `sensors/sensors/common/ultrasonic/ultrasonic_helper.hpp:56`

```cpp
decoder_thread_ =
    std::make_unique<::deeproute::base::Thread>("SnrUssAsembProc", [&]() {
      while (is_running.load()) {
        std::unique_lock<std::mutex> lock(decoders_mtx_);
        cv_.wait(lock, [&]() { return is_available_.load(); });
        lock.unlock();
        AssembleAndPublish();
        is_available_.store(false);
      }
    });
```

**行为**：

1. 等待条件变量 `cv_` 通知
2. 遍历所有 decoder 的 SPSC 队列
3. 对每个数据调用 `DecodePacket()`
4. 如果 decode 成功（返回 true），调用 `publish_callback_()` 发布

**与 sensor_ins_online 的 SnrInsAsembProc 对比**：

| 属性 | SnrInsAsembProc (INS) | SnrUssAsembProc (USS) |
|-|-|-|
| 等待机制 | `sem_.wait()` (信号量) | `cv_.wait()` (条件变量) |
| 处理内容 | 解码 → 写入 ins_recv_queue\_ | 解码 → 直接发布 |
| 下游 | SnrInsOnlnProc (第二级处理) | **无**（直接 publish） |
| 队列层级 | 第一级 | **唯一一级** |

### 2.3 t_Ultrasonic

**作用**：church 组件的 task 线程，但 `Proc()` 为空（`return true`）

**行为**：几乎空闲。因为没有 input channel，不会有消息触发 Proc()。只执行 church 内部的定时回调（如 MessageReporter）。

---

## 三、线程交互图

```
                 io-sock / lpLocation
                        │
                        ▼ (lpcom SHM)
               ┌────────────────────┐
               │  thread_pool (14)  │
               │  lpcom 接收回调    │
               │                    │
               │ HandleUSSProbeMsg()│───┐
               │ HandleUSSObsMsg() │───┤
               └────────────────────┘   │
                                        │ push → SPSC queue
                                        │ cv_.notify_one()
                                        ▼
               ┌─────────────────────────────┐
               │  SnrUssAsembProc (4)        │
               │  cv_.wait()                 │
               │  pop(queue)                 │
               │  ├─ ProbeDecoder::Decode()  │
               │  │  └─ MergeInto(obstacle)  │
               │  └─ ObsDecoder::Decode()    │
               │     └─ CheckFaults()        │
               │     └─ ObstacleStore::Update│
               │  publish_callback_()        │
               └──────────────┬──────────────┘
                              │
                              ▼
               ┌────────────────────────┐
               │  UltrasonicComponent   │
               │  PublishMsg()          │
               │  node()->Publish()     │
               └──────────────┬─────────┘
                              │
                              ▼
               ┌────────────────────────┐
               │  iceoryx_dispatch (5)  │
               │  → 下游模块             │
               └────────────────────────┘

   同时运行的监控线程:
   ┌──────────────────┐  ┌──────────────────┐  ┌────────────────────┐
   │ topic_monitor(13)│  │ sched_monitor(7) │  │ c_anomaly_monitor(9)│
   │ 帧超时/断流检测  │  │ 调度事件记录     │  │ Proc超时检测       │
   └──────────────────┘  └──────────────────┘  └────────────────────┘
```

---

## 四、与 sensor_ins_online 的线程对比

| sensor_ins_online 线程 | 是否存在于 sensor_uss | 原因 |
|-|-|-|
| t_SensorInsOnline | t_Ultrasonic | church task 线程（但 USS 的 Proc 为空） |
| SnrInsAsembProc | SnrUssAsembProc | 同类角色（解码线程） |
| SnrInsOnlnProc | **不存在** | USS 没有独立算法层 |
| mq_recv | **不存在** | USS 不使用 POSIX MQ |
| tlog_work | **不存在** | USS 没有纯 C 算法 |
| async_logger | async_logger | 相同 |
| iceoryx_dispatch | iceoryx_dispatch | 相同 |
| iox_keepalive | iox_keepalive | 相同 |
| sched_monitor | sched_monitor | 相同 |
| event_report | event_report | 相同 |
| c_anomaly_monitor | c_anomaly_monitor | 相同 |
| s_monitor | s_monitor | 相同 |
| s_timer | s_timer | 相同 |
| c_node_timer | c_node_timer | 相同 |
| topic_monitor | topic_monitor | 相同（lpcom SDK） |
| thread_pool | thread_pool | 相同（lpcom SDK） |
| event_loop | event_loop | 相同（lpcom SDK） |
| sensors_watch_d | sensors_watch_d | 相同 |
| sensors_frame_r | sensors_frame_r | 相同 |
| crash_reporter | crash_reporter | 相同 |
| compress_logfil | compress_logfil | 相同 |

**总结**：sensor_uss 比 sensor_ins_online 少 3 个线程（SnrInsOnlnProc、mq_recv、tlog_work），其余线程完全一致。
