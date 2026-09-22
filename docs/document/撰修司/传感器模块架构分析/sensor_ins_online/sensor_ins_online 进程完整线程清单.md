---
title: "sensor_ins_online 进程完整线程清单"
date: 2026-09-20
description: "关联文档：sensor_ins_online_module_guide.md、data_flow.md、church_framework_and_threads"
categories:
  - 撰修司
tags:
  - sensor_ins_online
---

# sensor_ins_online 进程完整线程清单

> **最后更新：** 2026-04-02  
> **关联文档：**`sensor_ins_online_module_guide.md`、`data_flow.md`、`church_framework_and_threads.md`  
> **适用车型：** LP8650（零跑），共 25 个线程

---

## 一、线程总览图

```
sensor_ins_online 进程 (25 个线程)
│
├─ 基础运行时 (3 个)
│  ├── [1]  main                        ─ 主线程，church 框架启动
│  ├── [2]  (unnamed, TID 2)            ─ 运行时/系统线程
│  └── [3]  async_logger                ─ 异步日志写入
│
├─ 日志子系统 (2 个)
│  ├── [4]  compress_logfil             ─ glog 日志压缩
│  └── [5]  compress_logfil             ─ spdlog 日志压缩
│
├─ church 框架 (9 个)
│  ├── [6]  c_node_timer                ─ Node 定时器
│  ├── [7]  iox_keepalive               ─ Iceoryx RouDi 保活
│  ├── [8]  iceoryx_dispatc             ─ Iceoryx 消息分发
│  ├── [9]  sched_monitor               ─ 调度监控事件发布
│  ├── [10] event_report                ─ 模块事件上报
│  ├── [11] c_anomaly_monit             ─ 异常检测监控
│  ├── [12] s_monitor                   ─ 调度器关停编排
│  ├── [13] s_timer                     ─ 调度器超时投递
│  └── [14] t_SensorInsOnli             ─ ★ church Proc() 任务线程
│
├─ lpcom SDK (4 个，闭源)
│  ├── [15] topic_monitor               ─ topic 帧超时/丢失监控
│  ├── [16] (unnamed, TID 16)           ─ lpcom 内部线程（待确认）
│  ├── [17] thread_pool                 ─ lpcom 线程池，消息分发
│  └── [18] event_loop                  ─ lpcom 事件循环
│
├─ 数据通路 (3 个)
│  ├── [19] mq_recv                     ─ POSIX MQ 接收（lpcom 层）
│  ├── [20] SnrInsAsembProc             ─ 传感器数据组装解码
│  └── [21] SnrInsOnlnProc              ─ ★★ 核心 MSF 融合处理
│
├─ 传感器监控 (2 个)
│  ├── [22] sensors_watch_d             ─ 数据看门狗
│  └── [23] sensors_frame_r             ─ 帧率检查
│
└─ 其他 (2 个)
   ├── [24] (unnamed, TID 24)           ─ 待确认
   └── [25] crash_reporter              ─ 崩溃上报
```

---

## 二、线程详细说明

### 2.1 基础运行时

#### [1] main (TID 1)

| 属性 | 值 |
|-|-|
| **全名** | (进程主线程) |
| **创建位置** | `platform/church/mainboard/church_main.cc` → `church_app.cc` |
| **作用** | church 框架启动入口：解析配置 → 注册组件 → 启动调度器 → 等待退出信号 |
| **阻塞状态** | 启动完毕后阻塞在退出信号等待（`WaitForShutdown()`） |

#### [2] (unnamed, TID 2)

| 属性 | 值 |
|-|-|
| **全名** | 未命名 |
| **创建位置** | 系统/运行时自动创建 |
| **作用** | 可能是 QNX/Linux 运行时线程（如 glibc 的 timer 线程、Qt event loop 等）。TID 由内核分配，无法从源码直接对应 |
| **确认方法** | `pidin -p <pid> threads` (QNX) 或 `cat /proc/<pid>/task/2/comm` (Linux) |

#### [3] async_logger

| 属性 | 值 |
|-|-|
| **全名** | `async_logger` |
| **创建位置** | `common/base/logger/glog/async_logger.cc:48-50` 或 `common/base/logger/spdlog/log_initializer.cpp:52-56` |
| **作用** | 异步日志写入线程。将日志消息从内存队列取出，写入文件。避免日志 I/O 阻塞业务线程 |
| **触发条件** | `FLAGS_mlog_async` 启用时创建 |

### 2.2 日志子系统

#### [4][5] compress_logfil (×2)

| 属性 | 值 |
|-|-|
| **全名** | `compress_logfiles`（Linux 15字符截断为 `compress_logfil`） |
| **创建位置** | glog 版: `common/base/logger/glog/log_file_object.cc:56-59`；spdlog 版: `common/base/logger/spdlog/file_sink.h:113-116` |
| **作用** | 日志文件压缩线程。当日志轮转后，后台压缩旧日志文件（如 zstd 压缩）。两个实例分别服务 glog 和 spdlog 日志后端 |
| **触发条件** | 日志清理 + 压缩功能启用时创建 |

### 2.3 church 框架

#### [6] c_node_timer

| 属性 | 值 |
|-|-|
| **全名** | `c_node_timer` |
| **创建位置** | `platform/church/node/node_timer.cc:144-145` |
| **作用** | church 全局 Node 定时器线程。维护超时小顶堆，按时间点 `wait`/`notify`，到期执行注册的定时回调 |

#### [7] iox_keepalive

| 属性 | 值 |
|-|-|
| **全名** | `iox_keepalive` |
| **创建位置** | `platform/church/node/iceoryx_transport_impl.cc:67-68` |
| **作用** | Iceoryx 保活线程。周期性调用 `sendKeepAliveAndHandleShutdownPreparation()`，向 RouDi 守护进程发送 keepalive 心跳，防止被判定为失联进程而被回收 |

#### [8] iceoryx_dispatc

| 属性 | 值 |
|-|-|
| **全名** | `iceoryx_dispatch`（15字符截断） |
| **创建位置** | `platform/church/node/iceoryx_dispatcher.cc:32-33` |
| **作用** | Iceoryx 消息分发线程。通过 WaitSet 接收所有订阅 topic 的消息通知，分发给对应 task 线程的消息队列。是 **church 消息路由的核心枢纽** |
| **工作模式** | poll 模式（按 `poll_hz` 轮询）或 trigger 模式（事件驱动） |

#### [9] sched_monitor

| 属性 | 值 |
|-|-|
| **全名** | `sched_monitor` |
| **创建位置** | `platform/church/component/schedule_monitor.cc:329-330` |
| **作用** | 调度监控事件发布线程。聚合队列中的 `ScheduleEvent`，周期性通过独立 Node 发布到 `kTopicScheduleEvents`，用于调度性能可观测性 |

#### [10] event_report

| 属性 | 值 |
|-|-|
| **全名** | `event_report` |
| **创建位置** | `platform/church/component/event_reporter.cc:39-40` |
| **作用** | 模块事件上报线程。从 `EventLog` 批量取事件，按间隔通过独立 Node 发布到 `kTopicModuleEvents`（模块级告警/状态变更） |

#### [11] c_anomaly_monit

| 属性 | 值 |
|-|-|
| **全名** | `c_anomaly_monitor`（15字符截断） |
| **创建位置** | `platform/church/component/anomaly_monitor.cc:48-49` |
| **作用** | 异常检测监控线程。约每 100ms 驱动多个检查单元（发布频率、处理时延、订阅异常等），发现异常时上报 |

#### [12] s_monitor

| 属性 | 值 |
|-|-|
| **全名** | `s_monitor` |
| **创建位置** | `platform/church/scheduler/scheduler_one_task_one_thread.cc:42-45` |
| **作用** | 调度器关停编排线程。收到停止信号后，先停 `s_timer`，再对所有 task 发 STOP 并 join 各任务线程，完成有序关停 |

#### [13] s_timer

| 属性 | 值 |
|-|-|
| **全名** | `s_timer` |
| **创建位置** | `platform/church/scheduler/scheduler_one_task_one_thread.cc:47-49` |
| **作用** | 调度器定时器线程。维护内部 timer，`UpdateTime` / `SendTimeoutEvents`，按下一超时时间 wait，负责把超时事件投递给各 task 线程 |

#### [14] t_SensorInsOnli ★

| 属性 | 值 |
|-|-|
| **全名** | `t_SensorInsOnline`（15字符截断） |
| **创建位置** | `platform/church/scheduler/scheduler_one_task_one_thread.cc:107-110`（通用机制，名称由 jsonnet 配置传入） |
| **作用** | **sensor_ins_online 的 church Proc() 任务线程**。处理两个 church 输入：`/canbus/wheel_speed` → `AddWheel()`、`/localization/matching_status` → `AddLidarMatchMsg()`。数据写入 `time_to_measurement_` map 后供 SnrInsOnlnProc 消费 |
| **触发条件** | `trigger_policy: ANY`，任一订阅 topic 到达即被 `iceoryx_dispatch` 唤醒 |

### 2.4 lpcom SDK（闭源，来自 `liblpCom.so.2`）

> 以下 4 个线程由零跑 lpcom SDK 内部创建，源码不在本项目仓库中。根据用户 trace 文件和运行时行为推断其作用。

#### [15] topic_monitor

| 属性 | 值 |
|-|-|
| **全名** | `topic_monitor` |
| **创建位置** | `liblpCom.so.2` 内部（闭源） |
| **配置文件** | `sensors/sensors/projects/lp8650_v1/ins/ins_topic_monitor.json` |
| **作用** | lpcom topic 健康度监控线程。根据配置文件中的阈值，周期性检测 topic 帧超时、回调处理超时、通信丢失等异常。检测结果通过 `ErrorCodeCallback` 回调给应用层 |
| **监控配置** |  |

```json
{
  "topic_monitor_config": [
    {
      "topic_name": "/leap/imu/imu_data_adas",
      "frame_timeout_threshold": 30000,       // 30ms — 单帧超时
      "callback_timeout_threshold": 20000,    // 20ms — 回调处理超时
      "lose_timeout_threshold": 100000        // 100ms — 通信丢失
    },
    {
      "topic_name": "/leap/gnss/gnss_data",
      "frame_timeout_threshold": 300000,      // 300ms
      "callback_timeout_threshold": 200000,   // 200ms
      "lose_timeout_threshold": 1000000       // 1000ms
    }
  ]
}
```

#### [16] (unnamed, TID 16)

| 属性 | 值 |
|-|-|
| **全名** | 未命名 |
| **创建位置** | `liblpCom.so.2` 内部（推测） |
| **作用** | 可能是 lpcom 内部的初始化/管理线程。从线程列表中的位置（紧挨 `topic_monitor` 之后）判断，很可能是 lpcom 在 `WrappedPSChannelFactory::GetInstance()` 初始化时创建的内部工作线程 |
| **确认方法** | `pidin -p <pid> threads`（QNX）查看 stack trace，或 `gdb attach` 后 `thread apply all bt` |

#### [17] thread_pool

| 属性 | 值 |
|-|-|
| **全名** | `thread_pool` |
| **创建位置** | `liblpCom.so.2` 内部（闭源） |
| **作用** | lpcom 消息分发线程池。接收来自 `mq_recv` 的数据，将消息分派给对应的订阅通道回调（`RegisterMessageCallback`）。在用户观测到的 trace 中，`thread_pool` 将数据传递给 `SnrInsAsembProc` 线程的回调函数 |
| **运行时调用链** | `mq_recv` → `thread_pool` → `InsManager::HandleIMUMessage()` → `imu_callback_()` → SPSC 队列 push → 唤醒 `SnrInsAsembProc` |

#### [18] event_loop

| 属性 | 值 |
|-|-|
| **全名** | `event_loop` |
| **创建位置** | `liblpCom.so.2` 内部（闭源） |
| **作用** | lpcom 事件循环线程。处理底层 I/O 事件。根据用户 trace 观察：阻塞在 `signalwaitinfo()` 等待内核信号，被唤醒后与 `io-sock` 交互（QNX 网络栈），处理网络收发事件。**不直接与其他应用线程交互** |
| **典型状态** | 大部分时间在 `signalwaitinfo()` 阻塞等待，被 I/O 完成信号唤醒后执行短暂处理后回到等待 |

### 2.5 数据通路

#### [19] mq_recv

| 属性 | 值 |
|-|-|
| **全名** | `mq_recv` |
| **创建位置** | `liblpCom.so.2` 内部（闭源） |
| **作用** | POSIX 消息队列接收线程。接收来自另一个进程（`lpLocation`）的 IMU/GNSS 数据。`lpLocation` 进程中的 `recv_imu_thread` 通过 POSIX MQ 发送数据到 `sensor_ins_online` 进程的 `mq_recv` 线程 |
| **运行时调用链（完整跨进程）** |  |

```
io-sock (QNX 网络栈)
  │ 以太网数据包到达
  ▼
lpLocation 进程
  │ recv_imu_thread 接收硬件数据
  │ 通过 POSIX MQ 发送
  ▼
sensor_ins_online 进程
  │ mq_recv 线程接收
  │ → thread_pool 分发
  │   → InsManager::HandleIMUMessage()
  │     → imu_callback_()
  │       → InsHelper SPSC 队列 push
  ▼
SnrInsAsembProc 线程
  │ 解码 + 发布
  ▼
SnrInsOnlnProc 线程
  │ MSF 融合 + Publish
```

#### [20] SnrInsAsembProc

| 属性 | 值 |
|-|-|
| **全名** | `SnrInsAsembProc` (Sensor INS Assembly Process) |
| **创建位置** | `sensors/sensors/common/ins/ins_helper.hpp:56-57` |
| **作用** | 传感器数据组装解码线程。从 InsHelper 的 SPSC 队列 pop 数据，调用 `DecodePacket()` 解码为 `sensors_ins_packet`，执行 IMU 坐标系旋转，调用 `publish_callback_()` 传递给上层 |
| **阻塞状态** | `cv_.wait()` 等待数据到达 |

#### [21] SnrInsOnlnProc ★★

| 属性 | 值 |
|-|-|
| **全名** | `SnrInsOnlnProc` (Sensor INS Online Process) |
| **创建位置** | `localization-mcu/sensor_ins_online/node/sensor_ins_online_manager.cpp:172-173` |
| **作用** | **核心 MSF 融合处理线程（整个模块最重要的线程）**。从 `ins_recv_queue_` pop 数据 → 解析各传感器数据 → 29 维 Kalman 滤波融合 → 位姿外推 → 通过回调发布 `/localization/pose` 等 11 个 topic |
| **阻塞状态** | `queue_cv_.wait()` 等待 `ins_recv_queue_` 有数据 |
| **CPU 开销** | 最高（Kalman 滤波 \~300-500μs/帧，200Hz 输入） |

### 2.6 传感器监控

#### [22] sensors_watch_d

| 属性 | 值 |
|-|-|
| **全名** | `sensors_watch_dog`（15字符截断） |
| **创建位置** | `sensors/sensors/utility/common/sensors_utils.hpp:234` |
| **作用** | 传感器数据看门狗线程。监控各数据 key（如 "IMU", "GNSS"）的 `FeedLoop()` 调用频率，如果超时未喂狗则上报 `ReportEvent` 告警 |

#### [23] sensors_frame_r

| 属性 | 值 |
|-|-|
| **全名** | `sensors_frame_rate_checker`（15字符截断） |
| **创建位置** | `sensors/sensors/utility/common/sensors_utils.hpp:99` |
| **作用** | 传感器帧率检查线程。周期性检查各数据 key 的帧计数是否在 min/max 范围内。INS 路径通过 `AddFrameCount("INMU")` 在 `ins_helper.hpp:152` 喂计数 |

### 2.7 其他

#### [24] (unnamed, TID 24)

| 属性 | 值 |
|-|-|
| **全名** | 未命名 |
| **创建位置** | 无法确定 |
| **作用** | 可能来自以下来源之一：(1) lpcom SDK 内部线程；(2) Boost.Asio 内部线程；(3) Protobuf arena 后台回收线程；(4) 其他第三方库。从位置上看（紧邻 `sensors_frame_r` 和 `crash_reporter` 之间），最可能是 lpcom 或 Boost 相关 |
| **确认方法** | 运行时 `thread apply all bt` 或 `pidin -p <pid> threads` |

#### [25] crash_reporter

| 属性 | 值 |
|-|-|
| **全名** | `crash_reporter` |
| **创建位置** | `platform/church/module/module_crash_reporter.cc:27-28` |
| **作用** | 模块崩溃上报线程。平时阻塞在信号量上，进程异常退出时被唤醒，调用 `ReportAllComponentsAbnormalExit()` 上报崩溃信息 |

---

## 三、线程分类统计

| 类别 | 数量 | 线程名 |
|-|-|-|
| **基础运行时** | 3 | main, (TID 2), async_logger |
| **日志子系统** | 2 | compress_logfil ×2 |
| **church 框架** | 9 | c_node_timer, iox_keepalive, iceoryx_dispatc, sched_monitor, event_report, c_anomaly_monit, s_monitor, s_timer, t_SensorInsOnli |
| **lpcom SDK** | 4 | topic_monitor, (TID 16), thread_pool, event_loop |
| **数据通路** | 3 | mq_recv, SnrInsAsembProc, SnrInsOnlnProc |
| **传感器监控** | 2 | sensors_watch_d, sensors_frame_r |
| **其他** | 2 | (TID 24), crash_reporter |
| **合计** | **25** |  |

---

## 四、数据通路线程交互图

```
                    ┌────────────── 跨进程 ──────────────┐
                    │                                     │
io-sock ──► lpLocation 进程                               │
            │ recv_imu_thread                             │
            │ (POSIX MQ 发送)                             │
            ▼                                             │
┌─────────── sensor_ins_online 进程 ──────────────────────┼──────────────────────┐
│                                                         │                      │
│  [19] mq_recv ◄────────────── POSIX MQ ─────────────────┘                      │
│       │                                                                         │
│       ▼                                                                         │
│  [17] thread_pool ── InsManager::HandleIMUMessage()                             │
│       │               │ memcpy → ImuData                                        │
│       │               │ imu_callback_()                                         │
│       ▼               ▼                                                         │
│  InsHelper SPSC 队列 #1 (capacity=64)                                           │
│       │ cv_.notify_one()                                                        │
│       ▼                                                                         │
│  [20] SnrInsAsembProc                                                           │
│       │ DecodePacket + OrientationRotate                                        │
│       │ publish_callback_()                                                     │
│       ▼                                                                         │
│  ins_recv_queue_ SPSC 队列 #2 (capacity=64)                                     │
│       │ queue_cv_.notify_one()                                                  │
│       ▼                                                                         │
│  [21] SnrInsOnlnProc ★★                                                        │
│       │ UnpackSensorsIns → ParseImu/ParseGnss                                   │
│       │ SaveRawImuMsg → Kalman 滤波                                             │
│       │ GetPose → odometry_output_callback_                                     │
│       │ → node()->Publish("/localization/pose")                                 │
│       │                                                                         │
│  ┌────┼─────────────────────────────────────────────────────────────────────┐   │
│  │    │  [8] iceoryx_dispatc                                                │   │
│  │    │       │ 收到 /canbus/wheel_speed                                    │   │
│  │    │       │ 收到 /localization/matching_status                          │   │
│  │    │       ▼                                                             │   │
│  │ [14] t_SensorInsOnli                                                     │   │
│  │       │ Proc() → AddWheel() → SaveWheelSpeedMsg()  ──┐                  │   │
│  │       │ Proc() → AddLidarMatchMsg() → SaveLidar... ──┤                  │   │
│  │       │                                               ▼                  │   │
│  │       │                                    time_to_measurement_ map      │   │
│  │       │                                    (由 [21] 的 HandleMeasurement │   │
│  │       │                                     BeforeGivenTime 消费)        │   │
│  └───────┴──────────────────────────────────────────────────────────────────┘   │
│                                                                                 │
│  监控线程 (后台):                                                                │
│  [15] topic_monitor  ─ 检测 lpcom topic 帧超时                                  │
│  [22] sensors_watch_d ─ 检测数据喂狗超时                                         │
│  [23] sensors_frame_r ─ 检测帧率异常                                             │
│  [18] event_loop      ─ lpcom I/O 事件循环 (signalwaitinfo ↔ io-sock)          │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## 五、lpcom 新发现：跨进程通信架构

根据用户 trace 文件观察，LP8650 车型上 `sensor_ins_online` 的数据接收并非直接通过共享内存，而是通过 **POSIX 消息队列（MQ）** 从另一个进程 `lpLocation` 接收：

```
┌──────────┐   以太网    ┌──────────────┐   POSIX MQ    ┌────────────────────┐
│  ADPU    │ ──────────► │ lpLocation   │ ────────────► │ sensor_ins_online  │
│ (硬件)   │   io-sock   │ (独立进程)   │               │ (本进程)           │
│          │             │              │               │                    │
│ IMU 200Hz│             │ recv_imu_    │               │ mq_recv           │
│ GNSS 10Hz│             │   thread     │               │ → thread_pool     │
│          │             │              │               │ → SnrInsAsembProc  │
│          │             │ event_loop   │               │ → SnrInsOnlnProc   │
└──────────┘             └──────────────┘               └────────────────────┘
```

这意味着 lpcom 的 `PSChannelAttribute.transType = SHM_ONLY` 实际上可能在底层使用 POSIX MQ 作为跨进程传输机制，而非裸共享内存。`event_loop` 线程通过 `signalwaitinfo` 与 `io-sock`（QNX 网络栈）交互，处理 GNSS 的 `NET_ONLY` 网络传输。

---

## 六、线程优先级说明

从 DEM 配置 `driver/config/dem/lp8650-v1-share/sensor_ins_online.jsonnet` 中可以看到：

```
"scheduling": {
    "cpuset": "0-3",
    "policy": "SCHED_RR",
    "priority": 20,
}
```

进程级调度策略为 `SCHED_RR`（轮转调度），优先级 20，CPU 绑定在核 0-3。各线程可能通过 `thread_config` 进一步配置独立的优先级和 CPU 亲和性。

---

## 七、两个 SPSC 队列详解

### 7.1 SPSC 队列 #1：InsHelper 内部（sensors 层）

| 属性 | 值 |
|-|-|
| **定义位置** | `sensors/sensors/common/ins/ins_helper.hpp` |
| **类型** | `boost::lockfree::spsc_queue<std::any, capacity<64>>` |
| **实例数** | 2 个独立队列（IMU decoder 一个，GNSS decoder 一个） |
| **生产者** | lpcom 回调线程（`mq_recv` → `thread_pool` → `HandleIMUMessage` → `imu_callback_`） |
| **消费者** | `SnrInsAsembProc` 线程 |
| **内容** | `std::any(leap::insdata::ImuData)` 或 `std::any(leap::insdata::GnssData)` |
| **同步** | 生产端 `push` 后 `cv_.notify_one()` 唤醒消费线程 |
| **溢出日志** | `"IMU Queue is full!"` / `"GNSS Queue is full!"` |
| **溢出含义** | `SnrInsAsembProc` 解码速度跟不上 lpcom 接收速度 |

### 7.2 SPSC 队列 #2：InsOnlineManager 内部（localization-mcu 层）

| 属性 | 值 |
|-|-|
| **定义位置** | `localization-mcu/sensor_ins_online/node/sensor_ins_online_manager.h` |
| **类型** | `boost::lockfree::spsc_queue<std::vector<uint8_t>, capacity<64>>` |
| **实例数** | 1 个 |
| **生产者** | `SnrInsAsembProc` 线程（通过 `publish_callback_` → `InsComponentImpl` 适配 → push） |
| **消费者** | `SnrInsOnlnProc` 线程 |
| **内容** | `std::vector<uint8_t>`（`sensors_ins_packet` 的二进制内存拷贝） |
| **同步** | 生产端 `push` 后 `queue_cv_.notify_one()` 唤醒消费线程 |
| **溢出日志** | `"sensor ins queue is full!"` |
| **溢出含义** | `SnrInsOnlnProc` 处理速度跟不上（Kalman 计算太慢 / 被抢占 / mutex 被锁） |
| **缓冲容量** | 64 帧 ≈ 320ms @200Hz IMU |

### 7.3 串联关系

```
lpcom 回调线程          SnrInsAsembProc         SnrInsOnlnProc
      │                      │                       │
      │  push(ImuData)       │                       │
      ├──────────────►[队列#1]──► pop → Decode        │
      │                      │  push(vector<uint8_t>) │
      │                      ├──────────────►[队列#2]──► pop → Kalman
      │                      │                       │
      │  push(GnssData)      │                       │
      ├──────────────►[队列#1]──► pop → Decode        │
      │                      │  push(vector<uint8_t>) │
      │                      ├──────────────►[队列#2]──► pop → Kalman
```

---

## 八、mutex 竞争分析

### 8.1 竞争资源

`MultiSensorsFusionOdometry` 中有一把全局 `pthread_mutex_t mutex_`，保护 `time_to_measurement_` 有序 map（按时间戳排序存储各传感器量测数据）。**两个线程竞争同一把锁**：

| 线程 | 加锁操作 | 频率 | 典型持锁时间 |
|-|-|-|-|
| SnrInsOnlnProc (Thread 15) | `SaveRawImuMsg` → INSERT_OR_CREATE_PROTOCOL | \~200Hz | \~1-5μs |
| SnrInsOnlnProc (Thread 15) | `HandleMeasurementBeforeGivenTime` → 遍历+删除 map + Kalman 滤波 | \~200Hz | \~300-500μs（正常），**\~N×300μs（积压时）** |
| SnrInsOnlnProc (Thread 15) | `SaveGnssPositionMsg` / `SaveGnssVelocityMsg` | \~1-10Hz | \~1-5μs |
| SnrInsOnlnProc (Thread 15) | `GetExtrapolatedVehicleState` | \~20Hz | \~1-3ms |
| t_SensorInsOnline (Thread 12) | `SaveWheelSpeedMsg` → INSERT_OR_CREATE_PROTOCOL | \~50Hz | \~1-5μs |
| t_SensorInsOnline (Thread 12) | `SaveLidarMatchingMsg` | \~10Hz | \~1-5μs |

### 8.2 竞争场景

```
SnrInsOnlnProc (Thread 15)                 t_SensorInsOnline (Thread 12)
        │                                           │
        │  SaveRawImuMsg()                          │
        │  ┌─ lock(mutex_) ─┐                       │
        │  │ INSERT map     │                       │
        │  └─ unlock ───────┘                       │
        │                                           │
        │  HandleMeasurementBefore()                │
        │  ┌─ lock(mutex_) ─────────────────────┐  │
        │  │ drain map entries                   │  │  wheel_speed 到达
        │  │ for each entry:                     │  │  SaveWheelSpeedMsg()
        │  │   HandleRawImuMsg [~300-500μs]      │  │  ┌─ lock(mutex_) ──── 被阻塞！
        │  │   HandleGnssMsg                     │  │  │ (等待 Thread 15
        │  │   HandleWheelSpeedMsg               │  │  │  释放 mutex_)
        │  │   HandleLidarMsg                    │  │  │
        │  │   ... [可能持续数 ms]                │  │  │
        │  └─ unlock ───────────────────────────┘  │  │
        │                                           │  └─ 获得锁，写入 ─┘
        │                                           │
```

### 8.3 恶性循环（积压放大效应）

```
初始: Thread 15 被其他原因阻塞 (CPU 抢占 / I/O / 优先级反转)
  ↓
SPSC 队列 #2 积压 N 帧 IMU 数据
  ↓
Thread 15 恢复后，一次 HandleMeasurementBeforeGivenTime 处理 N 帧
  ↓
持锁时间 = N × (300-500μs) → 可能达到数十 ms
  ↓
Thread 12 的 SaveWheelSpeedMsg/SaveLidarMatchingMsg 全被阻塞
  ↓
新的 wheel_speed 数据无法写入 map
  ↓
后续 HandleMeasurementBeforeGivenTime 缺少轮速约束，定位精度下降
  ↓
同时 Thread 15 处理完积压后，输出 topic 出现"集中爆发"
  ↓
下游看到"断流→恢复后高频"的现象
```

### 8.4 持锁时间估算

| 场景 | 积压帧数 | 持锁时间 | 影响 |
|-|-|-|-|
| 正常（无积压） | 1 帧 | \~300-500μs | 微乎其微 |
| 轻微积压 | 5 帧 | \~1.5-2.5ms | Thread 12 轻微延迟 |
| 中度积压 | 20 帧 (100ms) | \~6-10ms | Thread 12 的 Proc() 延迟可观测 |
| 严重积压 | 60+ 帧 (300ms) | \~18-30ms | 下游 topic 可能出现断流 |

---

## 九、两套日志系统

### 9.1 MLOG — C++ 层

| 属性 | 值 |
|-|-|
| **宏** | `MLOG(INFO/WARN/ERROR)`, `MLOG_EVERY(ERROR, N)` |
| **定义** | `common/base/logger/glog/log.h` 或 `spdlog/log.h` |
| **后端** | glog 或 spdlog（编译时选择） |
| **输出** | `.INFO` / `.WARNING` / `.ERROR` 标准日志文件 |
| **写入线程** | `async_logger` |
| **使用者** | sensors、driver、platform 层的 C++ 代码 |

### 9.2 MCU_MLOG — 纯 C 层

| 属性 | 值 |
|-|-|
| **宏** | `MCU_MLOG(ELOG_INFO/WARN/ERROR, "format", ...)` |
| **定义** | `mcu_common/mcu_common/log.h` → 映射到 `tlog()` |
| **后端** | **tinylog (tlog)** — 开源纯 C 日志库（`mcu_common/mcu_common/tlog.h/c`） |
| **输出** | `.clog` 日志文件 |
| **写入线程** | `tlog_work`（tlog 内部的 pthread，`tlog.c:2147`） |
| **使用者** | localization-mcu 的纯 C 算法代码（MSF、捷联惯导、静止检测、事件统计等） |

### 9.3 为什么需要两套？

MSF 核心算法是**纯 C 实现**（便于嵌入式/MCU 移植），无法使用 C++ 的 glog/spdlog。`MCU_MLOG` 虽然名字带 "MCU"，但实际运行在 **SOC 上**，"MCU" 是历史命名惯例（指代"MCU 风格的纯 C 代码"）。

---

## 十、事件统计与时间差检测机制

### 10.1 概述

`event_statistics.c`（纯 C 实现，位于 `localization-mcu/sensor_ins_online/utility/`）是 `sensor_ins_online` 的**运行时健康监控子系统**。它在 `SnrInsOnlnProc` 线程处理每帧传感器数据时被调用，通过计算多种时间差来检测异常，并通过 `event_cb_fn` 回调将事件上报给 DEM（诊断事件管理器）。

### 10.2 三个核心时间差

`msg_time_diff_check(msg_type, grab_time, timestamp_us)` 对每帧传感器数据计算三个时间差：

| 时间差 | 计算公式 | 含义 |
|-|-|-|
| **sys_pkt_diff** | `timestamp_us - grab_time` | SOC 当前系统时间 − 数据包硬件时间戳。反映**时钟同步状态**和**传输延迟** |
| **sys_diff** | `timestamp_us - last_sys` | 本次处理系统时间 − 上次处理系统时间。反映**实际处理间隔** |
| **pkt_diff** | `grab_time - last_pkt` | 本次包时间戳 − 上次包时间戳。反映**数据源发送间隔** |

其中 `timestamp_us` 来自 `get_sys_timestamp_us()`（SOC 系统时钟），`grab_time` 来自数据包 protobuf header 的 `measurement_time`。

### 10.3 IMU 时间差事件（MSG_TYPE_RAW_IMU）

IMU 正常频率为 200Hz（间隔 5ms），阈值设定如下：

| 事件名 | 检测对象 | 触发条件 | 含义 | 错误码 |
|-|-|-|-|-|
| `IMU_PKT_SYS_TIME_DIFF_TOO_LARGE` | sys_pkt_diff | `abs > 250ms` 或 `< 0` | 时钟不同步 / 传输严重延迟 | `TIME_NO_SYNC` |
| `IMU_SYS_TIME_DIFF_TOO_LARGE` | sys_diff | `abs > 15ms` | 处理间隔过长（被阻塞/抢占） | — |
| `IMU_SYS_TIME_DIFF_TOO_SMALL` | sys_diff | `abs < 5ms` | 处理间隔过短（积压后集中处理） | — |
| `IMU_PKT_TIME_DIFF_TOO_LARGE` | pkt_diff | `abs > 15ms` | 数据源发送间隔异常（丢帧/卡顿） | — |
| `IMU_PKT_TIME_DIFF_TOO_SMALL` | pkt_diff | `abs < 5ms` | 数据源发送过密 | — |
| `IMU_TIMESTAMP_ROLLBACK` | pkt_diff | `< 0` | 数据包时间戳回跳 | — |
| `IMU_SIX_AXIS_DATA_ALL_ZERO` | 六轴数据 | 全为 0 | IMU 硬件故障 | — |

此外还有 `sys_pkt_diff > 40ms` 的 warn 日志（不上报事件）。

#### IMU 综合错误判断

基于三个时间差的组合，做更高级别的错误分类：

| 错误类型 | 判断条件 | 含义 |
|-|-|-|
| `DROP_FRAME`（丢帧） | `pkt_diff ≥ 20ms` 且 `sys_diff ≥ 20ms` 且 `sys_pkt_diff < 5ms` | 数据源端就丢了帧（包间隔和处理间隔同步增大，但时钟同步正常） |
| `PKT_BLOCK`（阻塞） | `pkt_diff ≤ 15ms` 且 `sys_diff ≥ 16ms` 且 `sys_pkt_diff ≥ 16ms` | 数据正常发送但处理被阻塞（包间隔正常，但处理延迟增大） |
| `TIME_JUMP`（跳变） | `pkt_diff ∈ [900ms, 1100ms]` 且 `sys_diff ≤ 15ms` 且 `sys_pkt_diff ∈ [-1100ms, -900ms]` | 数据包时间戳突然跳了 \~1s（PTP/NTP 时间同步事件） |

### 10.4 GNSS/Wheel Speed 时间差事件

| 数据类型 | 正常频率 | sys_pkt_diff 阈值 | pkt/sys_diff 大阈值 | pkt/sys_diff 小阈值 |
|-|-|-|-|-|
| GNSS Position (raw pos) | \~1-10Hz | 4000ms (ERROR) / 500ms (WARN) | LP: 300ms, 其他: 1100ms | LP: 0, 其他: 900ms |
| GNSS Velocity (raw vel) | \~1-10Hz | 同上 | 同上 | 同上 |
| Wheel Speed | \~50Hz | 4000ms (ERROR) / 40ms (WARN) | 40ms | 10ms |

LP 车型（`DR_VEHICLE_LP8650_V1_SHARE` 等）使用不同的阈值（`kLargeTimeDiff = 300ms, kSmallTimeDiff = 0`），因为 lpcom 传输特性不同。

### 10.5 处理耗时监控

`process_interval_time_diff_check()` 函数在每个处理阶段前后打点，监控耗时：

| 阶段 | 阈值 | 含义 |
|-|-|-|
| `ETH_PKT_PROCESS` | 10ms | 单个以太网包解码耗时 |
| `RAW_IMU_HANDLE` / `RAW_POS_HANDLE` / ... | 3ms | MSF 处理单帧耗时 |
| `RAW_IMU_SAVE` / ... | 1ms | 量测数据存入 map 耗时 |
| `RAW_IMU_PUBLISH` / `RAW_LOC_POSE_PUBLISH` / ... | 5ms | 消息发布耗时 |

### 10.6 事件上报路径

```
event_statistics.c  ──event_cb_fn()──►  driver 层 DEM 回调
      │                                       │
      │  MCU_MLOG(ELOG_WARN/ERROR, ...)       ▼
      ▼                               EventReporter
  .clog 日志文件                    (church event_report 线程)
                                          │
                                          ▼
                                    HMI / 远程诊断
```

`event_cb_fn` 是在 `event_statistics_init()` 时注册的函数指针，由 driver 层提供，将事件码和描述字符串传递给 DEM 系统。DEM 系统对事件做 Debounce 处理（如 IMU 事件 `Debounce(true, 10, 0, 200)` 表示 10 次触发后上报，200s 恢复窗口）。

### 10.7 断流场景下的事件表现

| 阶段 | 触发事件 | 原因 |
|-|-|-|
| 阻塞期（\~402ms 无处理） | 无事件（线程阻塞，不执行检查） | SnrInsOnlnProc 线程被挂起 |
| 恢复后第一帧 | `IMU_SYS_TIME_DIFF_TOO_LARGE`（sys_diff ≈ 402ms） | 处理间隔远超 15ms 阈值 |
| 恢复后第一帧 | `IMU_PKT_SYS_TIME_DIFF_TOO_LARGE`（sys_pkt_diff ≈ 320ms+） | 积压帧的包时间戳已过时 |
| 恢复后第一帧 | `PKT_BLOCK` 综合判断 | pkt_diff 正常但 sys_diff 和 sys_pkt_diff 异常 |
| 恢复后连续处理帧 | `IMU_SYS_TIME_DIFF_TOO_SMALL`（sys_diff ≈ 几十μs） | 连续 pop 处理，帧间隔极小 |
| 恢复后连续处理帧 | `IMU_PKT_SYS_TIME_DIFF_TOO_LARGE` 持续触发 | 积压帧全部延迟 |
