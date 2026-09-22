---
title: "sensor_lidar / sensor_radar / sensor_ins_online 架构对比"
date: 2026-09-20
description: "基准平台：LP8797-V1-SHARE"
categories:
  - 撰修司
tags:
  - sensor_lidar
  - sensor_radar
  - sensor_ins_online
---

# sensor_lidar / sensor_radar / sensor_ins_online 架构对比

> 基准平台：LP8797-V1-SHARE  
> 生成日期：2026-04-16

---

## 1. 整体定位

| 模块 | 数据类型 | 数据量 | 频率 | 核心职责 |
|-|-|-|-|-|
| **sensor_lidar** | 点云（PointCloud2） | \~8MB/帧 | 10Hz | 接收 LiDAR UDP 包 → 解码 → 帧拼装 → 发布 |
| **sensor_radar** | 雷达目标（Radar proto） | \~175KB/帧 | \~20Hz | 接收雷达数据(lpcom SHM) → 解码 → 多雷达融合 → 发布 |
| **sensor_ins_online** | IMU/GNSS/定位 | 几十\~几百字节/帧 | 100-200Hz | 接收 IMU/GNSS(lpcom+MQ) → MSF 算法 → 发布 pose |

---

## 2. 数据输入路径

```
sensor_lidar:
  LiDAR硬件 → UDP组播(224.224.224.200:10200) → QnxUdpStreamMmsg::recvmmsg()
    → DecoderATX::DecodePacket() → PointCloudXYZIRT

sensor_radar:
  雷达ECU → Leap Com SHM(TransType::SHM_ONLY) → IpcMessage回调(lpcom线程)
    → memcpy → RadarDecoder::DecodePacket() → Radar proto

sensor_ins_online:
  IMU → lpLocation(dSomeIP) → POSIX MQ(mq_send) → mq_recv线程(QNX)
    → SPSC push → SnrInsOnlnProc
```

| 维度 | sensor_lidar | sensor_radar | sensor_ins_online |
|-|-|-|-|
| 传输协议 | UDP Socket 直连 | Leap Com SHM-Only IPC | Leap Com SHM + POSIX MQ |
| 数据来源 | LiDAR 硬件（网络） | 雷达 ECU（进程间） | lpLocation 服务（进程间） |
| 中间件依赖 | **无 lpcom** | Leap Com | Leap Com + dSomeIP |
| 接收方式 | 主动 `recvmmsg()` 拉取 | lpcom 回调推送 | mq_recv 线程 + lpcom 回调 |
| 消息大小 | \~1-2KB/包 × 1000+ 包/帧 | \~175KB/帧 | 几十\~几百字节/帧 |

---

## 3. 线程模型

### 3.1 结构对比图

```
sensor_lidar (单雷达):              sensor_radar:                   sensor_ins_online:
┌────────────────────┐         ┌────────────────────┐         ┌────────────────────┐
│ t_Lidar (空Proc)   │         │ t_Radar (空Proc)   │         │ t_SnrInsOnln(空Proc)│
│                    │         │                    │         │                    │
│ sensor_lidar ◄──┐  │         │ lpcom回调线程 ×N ──┐│         │ mq_recv ──────────┐│
│  recv+decode+pub│  │         │  push SPSC        ││         │  push SPSC        ││
│  (单线程全包揽) │  │         │  cv.notify        ││         │  cv.notify        ││
│                 │  │         │                   ││         │                   ││
│ (无中间队列)    │  │         │ SnrRadAsembProc ◄─┘│         │ SnrInsOnlnProc ◄──┘│
│                 │  │         │  cv.wait           │         │  cv.wait           │
│                 │  │         │  pop → decode      │         │  pop → MSF算法     │
│                 │  │         │  AllReady → pub    │         │  pub               │
│                 │  │         │                    │         │                    │
│ sensors_watch_dog│  │         │ status_thread      │         │ lpcom thread_pool  │
│ sensors_frame_rate│ │         │  在线状态检查       │         │ lpcom event_loop   │
│ (LP8797: 空转)  │  │         │                    │         │ dSomeIP 线程       │
└─────────────────┘  │         └────────────────────┘         └────────────────────┘
                     │
     UDP Socket ─────┘
```

### 3.2 线程属性对比

| 维度 | sensor_lidar | sensor_radar | sensor_ins_online |
|-|-|-|-|
| 核心业务线程 | `sensor_lidar` (1个) | `SnrRadAsembProc` (1个) | `SnrInsOnlnProc` (1个) |
| I/O 线程 | 自管理（与核心线程合一） | lpcom callback thread | lpcom thread_pool + mq_recv |
| 中间队列 | **无**（单雷达） / SPSC cap=256（多雷达 Linux） | SPSC cap=64（每个雷达一个） | SPSC cap=64 |
| 同步机制 | 无（同一线程） / cv + SPSC（多雷达） | cv + SPSC | cv + SPSC |
| Church 任务线程 | `t_Lidar` (空 Proc) | `t_Radar` (空 Proc) | `t_SnrInsOnln` (空 Proc) |
| 总线程数 | \~16 | \~20 | \~25 |
| lpcom 线程 | **无** | 有 | 有（thread_pool, event_loop, mq_recv） |

### 3.3 LP8797 线程优先级对比

| 线程 | sensor_lidar | sensor_radar | sensor_ins_online |
|-|-|-|-|
| 核心业务线程 | 35 (sensor_lidar) | 35 (SnrRadAsembProc) | **45** (SnrInsOnlnProc) |
| Church 任务线程 | 35 (t_Lidar) | 35 (t_Radar) | **45** (t_SnrInsOnln) |
| cpuset | 6-11 | 12-17 | 0-3 |
| 默认优先级 | 20 | 20 | 20 |

> sensor_ins_online 的核心线程优先级最高（45），因为 IMU/GNSS 数据对自动驾驶的实时性要求最高。sensor_lidar 和 sensor_radar 都是 35。三者使用独立的 cpuset，互不干扰。

---

## 4. 发布机制

| 维度 | sensor_lidar | sensor_radar | sensor_ins_online |
|-|-|-|-|
| 发布 API | `PublishWithHeader` / `PublishWithSourceTimestamp` | `PublishWithSourceTimestamp` | `Publish` / `PublishWithSourceTimestamp` |
| **ShmPool 零拷贝** | **有** — 3 个独立 Pool（\~200MB SHM） | **无** | **无** |
| 消息大小 | iceoryx 仅传 \~KB 元数据，裸数据在 ShmPool | iceoryx 传整个 proto (\~175KB) | iceoryx 传整个 proto (几百字节) |
| 数据载体 | proto.data = SHM block index | proto = 完整雷达数据 | proto = 完整 pose 数据 |
| Header 设置 | source_timestamp + dataplane_timestamp + sequence_num | source_timestamp only | 取决于具体 topic |
| 输出 topic 数 | 3 | 2 | \~10 |

### 4.1 为什么只有 sensor_lidar 使用 ShmPool？

点云数据量（\~8MB/帧）远超 sensor_radar（\~175KB）和 sensor_ins_online（几百字节）。如果走标准 iceoryx mempool，需要在 RouDi 预分配 8MB × N 的 chunk，对系统共享内存消耗巨大。ShmPool 通过独立的 POSIX SHM 段规避了这个问题。

详见 shm_pool_deep_dive.md。

---

## 5. 解码/处理机制

| 维度 | sensor_lidar | sensor_radar | sensor_ins_online |
|-|-|-|-|
| 解码器工厂 | `LidarDecoderFactory`（按雷达型号） | `RadarDecoderBase`（按车型） | 无工厂（固定 MSF 算法） |
| 帧拼装 | `FrameTimer`(100ms周期) + pub_flag 同步 | `AllDecodersReady()` 屏障同步 | 无帧拼装 |
| 多设备融合 | 多 cloud 合并 + ring 过滤 | `CollectBuffers` 拼接 + 时间戳平均 | 无多设备 |
| 坐标变换 | 外参旋转（decoder 内部） | 可选 `RadarUtils::TransformProject` | MSF 算法内部 |
| 时间校验 | `LidarTimeChecker` | `TimestampAnomalyDetection` | `event_statistics` (C 语言) |

### 5.1 多设备同步策略差异

**sensor_lidar（FrameTimer + pub_flag）**：

- 以 100ms 周期划分帧边界
- 每个雷达独立接收和解码，解完一帧设置 `pub_flag_vec_[idx] = true`
- 所有雷达都完成后才发布（`CheckPubFlag()`）
- CloudCheck 线程提供超时保护（120ms 无响应则强制发布）

**sensor_radar（AllDecodersReady 屏障）**：

- 每个雷达的 callback 将数据 push 到各自 SPSC 队列
- `SnrRadAsembProc` 逐个 pop 解码，设置 `is_ready` 标志
- 所有活跃雷达都 ready 后 `CollectBuffers()` 拼接发布
- 时间戳取各雷达平均值

**sensor_ins_online（无帧拼装）**：

- IMU 数据逐帧到达即处理，无多设备等待
- MSF 算法即时更新状态并发布

---

## 6. 异常检测对比

| 检测维度 | sensor_lidar | sensor_radar | sensor_ins_online |
|-|-|-|-|
| 输入超时 | UDP EAGAIN 计数（\~150ms） | lpcom SDK + Watchdog | event_statistics |
| 时间异常 | `LidarTimeChecker` 应用层 | `TimestampAnomalyDetection` | `event_statistics` |
| 队列溢出 | 多雷达 SPSC 满检测 | SPSC 满检测 | `sensor ins queue is full!` |
| 帧率异常 | `FrameRateCheck`（LP8797 未注册） | 全项目注册 | — |
| 看门狗 | Watchdog（LP8797 未注册） | 全项目注册 | — |
| 硬件状态 | 无 | `CheckRadarStatus` | — |
| Church 监控 | ChannelSuspendAlarm + ProcTimeout | 同 | 同 |
| lpcom 层监控 | **无**（不使用 lpcom） | `topic_monitor` + `ErrorCodeCallback` | `topic_monitor` + `ErrorCodeCallback` |

> **LP8797 上 sensor_lidar 的监控覆盖缺口**：由于 LP8797 平台的 LidarManager 未注册 Watchdog 和 FrameRateCheck 回调，LiDAR 完全断流时只能依靠 Church ChannelSuspendAlarm 检测，帧率异常无法检测。建议与 sensor_radar 对齐，注册这些回调。

---

## 7. 设计哲学总结

| 特点 | sensor_lidar | sensor_radar | sensor_ins_online |
|-|-|-|-|
| **架构风格** | 自管理 I/O + 零拷贝 | 中间件驱动 + 屏障同步 | 中间件驱动 + 算法密集 |
| **核心挑战** | 大数据量传输、UDP 丢包 | 多雷达时间对齐 | 高频实时性、算法延迟 |
| **与 lpcom 关系** | **完全解耦** | 深度依赖 | 深度依赖 |
| **复杂度来源** | 多厂商解码器 + 帧拼装 | 多车型适配 + 融合策略 | MSF 算法 + 多源融合 |
| **数据安全** | seq 校验 + CAS 锁 | lpcom 保证 | lpcom + MQ 保证 |
| **可扩展性** | 新雷达 = 新 Decoder | 新车型 = 新 RadarManager | 算法升级为主 |

---

## 8. 关联文档

| 文档 | 说明 |
|-|-|
| sensor_lidar_module_guide.md | sensor_lidar 模块总览 |
| data_flow.md | sensor_lidar 数据流详解 |
| thread_list.md | sensor_lidar 线程清单 |
| anomaly_detection.md | sensor_lidar 异常检测机制 |
| shm_pool_deep_dive.md | ShmPool 零拷贝发布机制 |
