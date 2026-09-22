---
title: "sensor_ins_online 中的 church 框架与线程模型"
date: 2026-09-20
description: "关联文档：sensor_ins_online_module_guide.md、data_flow.md"
categories:
  - 撰修司
tags:
  - Church
  - sensor_ins_online
---

# sensor_ins_online 中的 church 框架与线程模型

> **最后更新：** 2026-04-02  
> **关联文档：**`sensor_ins_online_module_guide.md`、`data_flow.md`

---

## 一、church 框架概述

church 是 Deeproute 自研的组件化框架，负责自动驾驶系统中各模块的消息路由、线程调度和生命周期管理。它的核心思想是：开发者只需编写 Component（定义 Init/Proc/Clear），框架自动完成消息订阅、调度触发和资源管理。

### 1.1 组件生命周期

```cpp
class Component {
protected:
  virtual bool Init() = 0;        // 初始化（注册回调、分配资源）
  virtual bool Proc(inputs, outputs) = 0;  // 处理一帧数据（由框架触发）
  virtual void Clear() {}          // 清理资源
};
```

框架的调用顺序：

```
Initialize(config)
  │ 解析 jsonnet 配置
  │ 创建 ChannelCache（每个 input channel 一个缓存）
  │ 初始化 Trigger 对象
  ▼
Startup()
  │ RegisterAllPublishers()   ← 注册所有 output channel 到 Node
  │ → Init()                  ← 调用用户的 Init()
  │ RegisterAllSubscribers()  ← 注册所有 input channel 到 Node
  ▼
[运行阶段: 消息到达 → 触发判定 → Assemble → Proc() → Dispatch 输出]
  ▼
Shutdown()
  │ CloseTrigger()
  │ UnregisterAllSubscribers()
  │ → Clear()                 ← 调用用户的 Clear()
  │ UnregisterAllPublishers()
```

### 1.2 Proc() 触发机制

**Proc() 不是开发者主动调用的，而是 church 框架在满足触发条件时自动调用。**

触发流程（以 `trigger_policy: 'ANY'` 为例）：

```
上游组件 Publish 一条消息 (如 /canbus/wheel_speed)
  │ Iceoryx 共享内存传输（零拷贝）
  ▼
iceoryx_dispatch 线程收到消息
  │ 调用 subscriber callback
  │ → Node::CallReceiveObserver()
  │ → Scheduler::Dispatch(task_id, PROC, message)
  ▼
消息进入 task 线程的 MessageQueue
  │ task 线程被唤醒
  ▼
InputOnboardMessage()
  │ 消息存入 ChannelCache
  │ 如果是 trigger channel → cached_trigger_number_++
  ▼
FinishInputOnboardMessages() — 一批消息结束时
  │ 检查 cached_trigger_number_
  │ > 0 → Assemble() 从各 cache 取数据
  │ = 0 → 跳过本轮，不调用 Proc()
  ▼
Component::Process()
  │ 排序输入消息
  │ 通知 ProcessObserver（监控 Proc 耗时）
  │ → Proc(input_msgs, output_msgs)  ← 调用用户代码
  │ GenerateHeaderForEveryMessage()
  │ Dispatch(output_msgs)             ← 发布输出消息
```

### 1.3 trigger_policy 类型

| 策略 | 含义 |
|-|-|
| `ANY` | **任一** trigger channel 收到新消息即触发 Proc() |
| `CUSTOM` | 自定义触发逻辑，支持 `ALL_NEW` 等高级模式 |
| `PERIODIC` | 定时触发（使用 `ConditionalScheduler`，非 LEGACY 路径） |
| `IMMEDIATE` | 立即触发 |

**注意：没有 `ALL` 策略。** 如需"所有 channel 都到齐才触发"，需用 `CUSTOM` + `ALL_NEW`。

### 1.4 queue_size vs cache_size

| 参数 | 作用域 | 说明 |
|-|-|-|
| `queue_size` | 传输层（Iceoryx/ZMQ） | subscriber/publisher 的传输队列深度，满时丢弃旧消息 |
| `cache_size` | 组件内部 ChannelCache | Proc() 从这里取数据。scheduler 内部也用此值限制 per-topic 消息队列 |

### 1.5 sensor_ins_online 的 church 配置

```jsonnet
task: {
  name: 't_SensorInsOnline',
  expected_proc_duration_ms: 100,     // 监控阈值：Proc 超过 100ms 告警
  trigger_policy: 'ANY',              // 任一 trigger 到达即触发
  trigger_channels: [
    '/canbus/wheel_speed',
    '/localization/matching_status',
    '/sensors/someip/rawdata',
  ],
  input_channels: [
    { name: '/canbus/wheel_speed',        type: 'optional', cache_size: 1 },
    { name: '/localization/matching_status', type: 'optional', cache_size: 1 },
    { name: '/sensors/someip/rawdata',    type: 'optional', queue_size: 50,
      cache_size: 50, allow_breaking_order: true, do_not_skip_proc: true },
  ],
  output_channels: [
    { name: '/localization/pose' },
    { name: '/localization/keyframe_update_status' },
    { name: '/localization/debug/internal_state' },
    { name: '/sensors/gnss/raw_gnss_position' },
    { name: '/sensors/gnss/wgs84_gnss_position' },
    { name: '/sensors/gnss/gcj02_gnss_position' },
    { name: '/sensors/gnss/raw_short_raw_imu' },
    { name: '/sensors/gnss/raw_gnss_velocity' },
    { name: '/sensors/gnss/raw_gga' },
    { name: '/sensors/gnss/raw_ins_pva_x' },
    { name: '/sensors/gnss/gcj02_ins_pva_x' },
  ],
}
```

### 1.6 sensor_ins_online 的非典型设计

`sensor_ins_online` 是一个**非典型的 church 组件**：

| 方面 | 典型 church 组件 | sensor_ins_online |
|-|-|-|
| 核心数据输入 | 全部通过 church input_channels | IMU/GNSS 通过 dSomeIP 回调链（绕过 church） |
| 数据输出 | Proc() 的 output_msgs 参数 | 全部通过 Init() 回调直接 Publish（绕过 Proc） |
| Proc() 职责 | 输入 → 处理 → 输出 | 仅接收轮速和 Lidar 匹配数据（无输出） |
| 核心处理线程 | church task 线程 | 自建 SnrInsOnlnProc 线程（Thread 15） |

```
典型 church 组件:          sensor_ins_online 的实际情况:
  输入 → Proc() → 输出       输入路径 A: dSomeIP → 回调 → Thread 15 → Publish
                              输入路径 B: church → Proc() → 喂数据给算法 (无输出)
```

这种设计的原因是：IMU 数据频率高（200Hz），需要在收到后立即处理并输出位姿，不能受 church 调度延迟的影响。

---

## 二、sensor_ins_online 进程完整线程清单

### 2.1 线程总览

sensor_ins_online 进程中运行约 **14 个长期线程**，分属四类：

| 类别 | 线程数 | 说明 |
|-|-|-|
| church 框架线程 | \~11 | 框架基础设施 |
| sensors 层线程 | 1 | 传感器数据解码 |
| localization-mcu 线程 | 1 | 核心 MSF 处理 |
| dSomeIP SDK 线程 | 1+ | 网络数据接收 |

### 2.2 church 框架线程详解

| # | 线程名 | 创建位置 | 职责 |
|-|-|-|-|
| ① | `main` | `church_main.cc` | 启动所有子系统后阻塞等待退出信号（`WaitForSignal()`） |
| ② | `iceoryx_dispatch` | `church/transport/iceoryx_dispatcher.cc` | **消息接收核心**：轮询 Iceoryx waitset，收到消息后调用 subscriber callback → 投递到 task queue |
| ③ | `iox_keepalive` | `church/transport/iceoryx_transport_impl.cc` | 向 Iceoryx RouDi 守护进程发送心跳，维持共享内存连接 |
| ④ | `t_SensorInsOnline` | `church/scheduler/scheduler_one_task_one_thread.cc` | **组件 task 线程**：唯一调用 `Proc()` 的线程。从 MessageQueue 取消息，触发判定，调用 Proc() |
| ⑤ | `s_monitor` | 同上 | 调度器监控：收到关闭请求时按序停止所有 task 线程 |
| ⑥ | `s_timer` | 同上 | 调度器定时器：驱动定时器堆，处理 TIMEOUT 事件。`message_report`（topic 无数据告警）通过此定时器实现，不是独立线程 |
| ⑦ | `event_report` | `church/component/event_reporter.cc` | 每 300ms 从 EventLog 缓冲区取事件，发布到 `/module/events` |
| ⑧ | `sched_monitor` | `church/mainboard/schedule_monitor.cc` | 收集调度事件（Proc 耗时、调度延迟），批量发布 ScheduleEvents |
| ⑨ | `c_anomaly_monitor` | `church/component/anomaly_monitor.cc` | 每 \~100ms 检查发布频率、Proc 耗时、订阅异常 |
| ⑩ | `c_node_timer` | `church/node/node_timer.cc` | 全局 Node 定时器堆，处理 node 层超时回调 |
| ⑪ | `crash_reporter` | `church/mainboard/module_crash_reporter.cc` | 阻塞等待崩溃信号，触发时上报异常退出状态 |

### 2.3 sensors 层线程

| # | 线程名 | 创建位置 | 职责 |
|-|-|-|-|
| ⑫ | `SnrInsAsembProc` | `sensors/common/ins/ins_helper.hpp:56` | 从 InsHelper 的 SPSC 队列取 dSomeIP 原始数据 → 调用 decoder 解码为 `sensors_ins_packet` → 调用 publish_callback 传递给 localization-mcu |

### 2.4 localization-mcu 线程

| # | 线程名 | 创建位置 | 职责 |
|-|-|-|-|
| ⑬ | `SnrInsOnlnProc` | `sensor_ins_online_manager.cpp:176` | **核心处理线程**：从 `ins_recv_queue_` 取数据 → 解包 → MSF 融合（29x29 Kalman 滤波）→ 位姿外推 → 触发 Publish 回调 |

### 2.5 dSomeIP SDK 线程

| # | 线程名 | 创建位置 | 职责 |
|-|-|-|-|
| ⑭ | (由 SDK 内部命名) | dSomeIP SDK 内部 | 监听车载以太网端口，接收 SOME/IP 帧，解析后调用注册的事件回调 |

### 2.6 线程交互全景图

```
                    ┌────── church 框架线程 ──────────────────────────────────┐
                    │                                                        │
dSomeIP SDK ⑭     │  iceoryx_dispatch ②          s_timer ⑥               │
(以太网接收)       │  (church 消息接收)            (定时器/msg_report)       │
  │                │    │                           │                       │
  │ 事件回调       │    │ Dispatch(PROC)            │ TIMEOUT               │
  ▼                │    ▼                           ▼                       │
SnrInsAsembProc ⑫│  t_SensorInsOnline ④ ─── Thread 12                   │
(sensors 解码)     │  (Proc 执行线程)                                       │
  │ decode         │    │ Proc():                                          │
  │ publish_cb     │    │   AddWheel() ─────┐                             │
  ▼                │    │   AddLidarMatch() ─┤                             │
ins_recv_queue_    │    │                    ▼                             │
  │ push + notify  │    │            time_to_measurement_ map              │
  ▼                │    │            (共享, pthread_mutex_t)               │
SnrInsOnlnProc ⑬│    │                    │                             │
Thread 15         │    │                    │                             │
  │ pop → Unpack   │    │                    │                             │
  │ SaveRawImuMsg ─┼────┼──→ mutex lock ←───┘                             │
  │ HandleMeasure  │    │                                                  │
  │ GetPose        │    │  c_anomaly_monitor ⑨: 每100ms检查Proc耗时      │
  │                │    │  event_report ⑦: 每300ms上报事件                │
  ▼                │    │  sched_monitor ⑧: 收集调度统计                  │
node()->Publish()  │    │  s_monitor ⑤: 全局关闭监控                      │
  │                │    │  c_node_timer ⑩: 全局定时器                     │
  ▼                │    │  iox_keepalive ③: Iceoryx 心跳                  │
/localization/pose │    │  crash_reporter ⑪: 崩溃上报                     │
(通过 iceoryx 发送) │    │  main ①: 阻塞等待退出信号                       │
                    └────┴──────────────────────────────────────────────────┘
```

### 2.7 关键线程间的数据交互

| 数据路径 | 发送线程 | 接收线程 | 同步机制 |
|-|-|-|-|
| dSomeIP 原始数据 | dSomeIP SDK ⑭ | SnrInsAsembProc ⑫ | SPSC queue + condition_variable |
| sensors_ins_packet 字节流 | SnrInsAsembProc ⑫ | SnrInsOnlnProc ⑬ | SPSC queue (ins_recv_queue\_, 容量 64) + condition_variable |
| WheelSpeed / LidarMatch → map | t_SensorInsOnline ④ | SnrInsOnlnProc ⑬ (读取) | pthread_mutex_t (MSF mutex) |
| church 消息 | iceoryx_dispatch ② | t_SensorInsOnline ④ | MessageQueue + condition_variable |
| Publish 的消息 | SnrInsOnlnProc ⑬ | iceoryx_dispatch ② (送出) | Iceoryx 共享内存 |
