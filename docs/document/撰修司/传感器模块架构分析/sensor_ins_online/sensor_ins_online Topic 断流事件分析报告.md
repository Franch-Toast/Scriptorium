---
title: "sensor_ins_online Topic 断流事件分析报告"
date: 2026-09-20
categories:
  - 撰修司
tags:
  - sensor_ins_online
---

# sensor_ins_online Topic 断流事件分析报告

## 事件概述

| 项目 | 内容 |
|-|-|
| 时间 | 2026-04-04 14:24:31.741 \~ 14:24:32.420 |
| 影响 Topic | `/localization/pose`、`/sensors/gnss/pose` |
| 断流时长 | \~679ms |
| 恢复特征 | 扎堆高频输出约 57 帧 + 约 16 帧丢失 |
| CPU 负载 | \~40%（不高） |

## 1. 时间线重建

### 阶段 1：正常运行（\~14:24:31.689 之前）

SnrInsOnlnProc（Thread 15）正常处理 IMU/GNSS 数据，每个 IMU 包处理间隔约 5~~10ms。持续存在 `RAW_POS_PUBLISH spend too long time` 告警（6~~30ms），但属于常态。

最后一条正常 clog：

```
[14:24:31.689] lidar: measure_vehicle_forward: -0.011308
               Latency is 25.402ms, measure_timestamp: 1775283871594598
```

### 阶段 2：SnrInsOnlnProc 停顿（14:24:31.741 \~ 14:24:32.420）

Thread 15 在处理一个 **仅含 GNSS position 数据的 packet** 时，`raw_pose_callback_` 函数内部阻塞约 679ms。

关键计时数据：

| 计时项 | 耗时 | 占比 |
|-|-|-|
| `raw_pose_callback_`（RAW_POS_PUBLISH） | 679,328 us | 99.98% |
| ETH_PKT_PROCESS 完整包处理 | 679,484 us | 100% |
| 非 Publish 部分（Unpack + 其他 Parse） | 156 us | 0.02% |

sys_time 精确时间点：

| 时刻 | sys_time (us) | 说明 |
|-|-|-|
| ETH_PKT_PROCESS 开始 | 1775283871682311 | 包处理开始 |
| RAW_POS_PUBLISH 开始 | 1775283871682438 | 进入 raw_pose_callback\_（+127us） |
| RAW_POS_PUBLISH 结束 | 1775283872361766 | 阻塞 679,328us 后返回 |
| ETH_PKT_PROCESS 结束 | 1775283872361795 | 包处理结束（+29us） |

### 阶段 3：队列溢出（14:24:32.338 \~ 14:24:32.418）

Thread 15 阻塞期间，SnrInsAsembProc（Thread 19）持续解码 IMU 数据并推送到 `ins_recv_queue_`（容量 64 个槽位）。

```
[14:24:32.338] [t:19] sensor ins queue is full!
[14:24:32.348] [t:19] sensor ins queue is full!
...（共 10 次，80ms 内）
[14:24:32.418] [t:19] sensor ins queue is full!
```

- 队列在 \~14:24:32.02 前后被填满（679ms 阻塞开始约 320ms 后，64 × 5ms = 320ms）
- queue full 期间 \~16 个 IMU 包被丢弃

### 阶段 4：恢复与扎堆输出（14:24:32.420 \~ 14:24:32.440）

Thread 15 恢复后高速消费队列积压数据：

```
sys_pkt_diff 变化趋势：675589 → 666134 → 656316 → ... → 100004 us
sys_diff 极小：547 → 181 → 317 → 125 → 293 → ... us（每帧处理仅 ~150us）
```

- 积压包数量：约 (675589 - 100004) / 10000 ≈ **57 个 IMU 包**
- 恢复后 Lidar 定位误差从正常 0.03m 急升至 0.17m，需数秒收敛

## 2. 数据链路分析

### 完整数据路径

```
网络(INMU) → lpLocation(recv_imu_thread) → POSIX MQ → mq_recv(T19)
→ InsHelper → SnrInsAsembProc(T14) → SPSC queue #1
→ InsHelper decode → SPSC queue #2 (ins_recv_queue_, 64 slots)
→ SnrInsOnlnProc(T15)  ← ★ 卡在这里
→ MSF 算法 → /localization/pose、/sensors/gnss/pose
```

### 上游链路状态

| 环节 | 状态 | 依据 |
|-|-|-|
| 网络 | 正常 | lpNetworkMgr 14:24:31.688 emac0 rpps=8752 正常 |
| lpLocation | 正常 | LocationADAS count 连续（326943→327043，差 100 = 正常） |
| IMU 硬件 | 正常 | dataStatus:0, dataError:0, safetyStatus:0 |
| mq_recv / SnrInsAsembProc | 正常 | queue full 日志证明 T19 在持续推数据 |

## 3. 根因分析

### 故障点精确定位

故障发生在 `raw_pose_callback_` 内部，该回调在 `sensor_ins_online_component.cc` 中定义：

```cpp
auto pub_raw_pose_cb = [this](const RAW_POSE_MSG& msg) {
    // 1. 创建 WGS84 共享消息
    auto wgs84_msg_ptr = protobuf_user_api::CreateSharedMessage<RAW_POSE_MSG>(msg_wgs84);
    node()->Publish("/sensors/gnss/wgs84_gnss_position", wgs84_msg_ptr);    // Publish #1

    // 2. WGS84→GCJ02 坐标转换（InternalWgToChinaLB）
    InternalWgToChinaLB(lng, lat, height, gps_sow, gps_week, &china_lng, &china_lat);

    // 3. 创建 GCJ02 共享消息并发布
    auto gcj02_msg_ptr = protobuf_user_api::CreateSharedMessage<RAW_POSE_MSG>(msg_gcj02);
    node()->Publish("/sensors/gnss/gcj02_gnss_position", gcj02_msg_ptr);    // Publish #2
    node()->Publish("/sensors/gnss/raw_gnss_position", gcj02_msg_ptr);      // Publish #3
};
```

### 逐一排除

| 可能性 | 判定 | 理由 |
|-|-|-|
| 坐标转换（WgtoChinaLb） | **排除** | `dlopen`/`dlsym`/`func` 均为 `static` 缓存，运行 45 分钟后只做纯数学运算 |
| CPU 调度饥饿 | **排除** | Thread 15 priority 45 + SCHED_RR + 4 核 + CPU 仅 40% |
| iceoryx loan/publish 阻塞 | **排除** | 代码使用 `and_then/or_else` 模式，loan 失败直接返回错误，不阻塞 |
| MSF 算法耗时 | **排除** | ETH_PKT 到 RAW_POS_PUBLISH 仅 127us，说明该包无 IMU 数据 |
| Publisher::mutex\_ 争用 | **排除** | 每个 topic 独立 mutex，同一 topic 不会被多线程并发 Publish |

### 最终结论：QNX 微内核同步 IPC 延迟

**根因**：Thread 15 在执行 `raw_pose_callback_` 过程中，某个操作触发了 QNX 同步 IPC（`MsgSend()`），而系统服务端（最可能是 `procnto` 内存管理器）正忙于处理来自其他进程的请求，导致 Thread 15 在 IPC 等待中阻塞约 679ms。

**最可能的 IPC 触发点**：

1. `protobuf_user_api::CreateSharedMessage<T>()` — protobuf arena 在共享内存中分配对象，如果 arena 需要扩展，底层调用 `mmap()` 会触发向 `procnto` 的同步 IPC
2. iceoryx 共享内存页面访问 — 如果 `IceoryxWriter::WriteMsg` 中的 `loan()` 返回的 chunk 地址对应一个尚未映射的物理页面，首次访问时触发 page fault → `procnto` 同步 IPC

**为什么 procnto 此时会慢？**

从 Elog 看，14:24:31.6\~31.75 时间段系统高并发：

- lpRadar 密集 ICC 回调（20+ 条日志，每 10ms 一组 CAN 数据处理）
- 所有 camera、perception、map_engine 等进程同时运行
- 每个进程都在通过 iceoryx 做 SHM 操作（Publish/Subscribe）

所有 SHM 操作最终都通过 `procnto` 处理页面映射、内存分配等，形成请求风暴。

### Church Publish 调用链

```
node()->Publish(topic, shared_ptr<ProtoBaseMsg>)
  └─ NodeImpl::Publish → GetPublisher [shared_lock]
       └─ Publisher::Publish [per-topic mutex_]
            ├─ GenerateMessageHeader
            ├─ ByteSizeLong
            ├─ CallPublishObserver
            └─ IceoryxWriter::WriteMsg
                 ├─ [PROTOBUF_ARENA_OPTIMIZE]:
                 │   CheckIfMessageIsInSharedMemory → 已在 SHM → 跳过 CopyFrom
                 ├─ loan(msg_size) → 非阻塞（成功 or 报错）
                 ├─ SerializeWithCachedSizesToArray → protobuf 序列化
                 └─ publish(userPayload) → 非阻塞
```

iceoryx 原语 `loan()` 和 `publish()` 本身均为非阻塞设计。679ms 延迟发生在更底层 —— 共享内存访问触发的系统调用。

## 4. Topic 配置参考

### 发布者配置（sensor_ins_online）

| Topic | 发布者队列深度 |
|-|-|
| `/sensors/gnss/raw_gnss_position` | 10 |
| `/sensors/gnss/wgs84_gnss_position` | 未显式配置 |
| `/sensors/gnss/gcj02_gnss_position` | 未显式配置 |
| `/localization/pose` | 8 |

### 订阅者概况

| Topic | 订阅者模板数 | 典型 queue/cache |
|-|-|-|
| `raw_gnss_position` | \~21 | 大多 `cache_size: 1` |
| `wgs84_gnss_position` | \~6 | `cache_size: 1` 或 `queue_size: 1` |
| `gcj02_gnss_position` | \~1 | `type: 'all_new'` |
| `/localization/pose` | \~39 | `cache_size: 1` \~ `queue_size: 100` |

### QNX 线程优先级

```
SnrInsOnlnProc:  SCHED_RR, priority 45, cpuset 0-3
SnrInsAsembProc: SCHED_RR, priority 45, cpuset 0-3
iceoryx_dispatch: SCHED_RR, priority 45, cpuset 0-3
```

## 5. 影响评估

| 维度 | 影响 |
|-|-|
| 数据丢失 | \~16 个 IMU 包（queue full 期间 \~80ms） |
| 定位精度 | Lidar 定位误差从 0.03m 急升至 0.17m |
| 恢复时间 | 数据层 \~20ms（扎堆消费）；精度层需 \~3 秒收敛 |
| EKF 状态 | 57 个积压包被快速消费，但丢失 16 个导致短暂不连续 |

## 6. 改进建议

| 方案 | 描述 | 效果 | 优先级 |
|-|-|-|-|
| **GNSS Publish 异步化** | 将 `raw_pose_callback_` 中的 3 次 Publish 移到独立线程 | 彻底解耦 Publish 延迟与数据处理 | 高 |
| **增大 ins_recv_queue\_** | 从 64 增加到 256+（增加 \~960ms 缓冲） | 容忍更长的停顿而不丢帧 | 中 |
| **增加细粒度计时** | 在 `CreateSharedMessage` 和每次 `Publish` 前后分别打时间戳 | 精确定位 679ms 消耗在哪一步 | 中 |
| **mlockall(MCL_CURRENT\|MCL_FUTURE)** | 锁定进程内存页面，避免 page fault | 消除 page fault 引起的 IPC 延迟 | 中 |
| **Publish 超时保护** | 如果 Publish 超过阈值（如 50ms），跳过并记录告警 | 限制单次 Publish 的最大影响 | 低 |
| **QNX SAT/tracelogger 追踪** | 使用 QNX System Analysis Toolkit 捕获事件期间的内核调度和 IPC 行为 | 获取决定性证据（哪个系统调用阻塞了 679ms） | 高（调试用） |
