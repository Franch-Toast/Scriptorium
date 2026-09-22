---
title: "sensor_lidar 数据流详解"
date: 2026-09-20
description: "基准平台：LP8650-V1-SHARE"
categories:
  - 撰修司
tags:
  - sensor_lidar
---

# sensor_lidar 数据流详解

> 基准平台：LP8650-V1-SHARE  
> 生成日期：2026-04-16

---

## 1. 数据流总览

```
 ┌────────────────────────────────────────────────────────────────────────────┐
 │                         硬件 / 外部                                        │
 │                                                                            │
 │  ┌──────────┐   ┌──────────┐   ┌──────────┐                               │
 │  │ 主激光雷达 │   │ 补盲雷达 1 │   │ 补盲雷达 2 │   ← 独立 LiDAR 传感器     │
 │  │ (Hesai)   │   │(RoboSense)│   │ (Seyond) │                             │
 │  └─────┬────┘   └─────┬────┘   └─────┬────┘                               │
 │        │              │              │                                      │
 │        ▼              ▼              ▼                                      │
 │  ┌───────────────────────────────────────────┐                              │
 │  │  以太网 → UDP 数据包                        │                              │
 │  │  每包 ~1-2KB, 每帧 ~1000+ 包               │                              │
 │  └─────────────────┬─────────────────────────┘                              │
 └────────────────────│────────────────────────────────────────────────────────┘
                      │ UDP Socket
                      ▼
 ┌────────────────────────────────────────────────────────────────────────────┐
 │                     sensor_lidar 进程                                       │
 │                                                                            │
 │  ===================== 单雷达模式 (LidarHelperSingle) ==================== │
 │                                                                            │
 │  ┌───────────────────────────────────────────────────────────────────┐     │
 │  │ ProcessCloud 线程 (ThreadPool, 线程名: sensor_lidar)               │     │
 │  │                                                                   │     │
 │  │  while(is_running):                                               │     │
│  │    1. GetCloud():                                                 │     │
│  │       ├── data_stream_ptr_->read(buffer, kMaxLidarPacketLength)   │     │
│  │       └── decoder_ptr_->DecodePacket(pkt_msg) → cloud_ptr         │     │
│  │    1.5. LidarTimeChecker::Check(cloud_ptr->header.stamp)          │     │
 │  │                                                                   │     │
 │  │    2. 帧拼装:                                                      │     │
 │  │       ├── sFrameTimer->TimeUp(stamp)?                             │     │
 │  │       │   ├── 是: 当前帧完成, Publish current_cloud               │     │
 │  │       │   │       next_cloud 提升为 current_cloud                  │     │
 │  │       │   └── 否: *current_cloud_ptr_ += *cloud_ptr               │     │
 │  │       └── 超时/包数检查 → 强制发布                                  │     │
 │  │                                                                   │     │
 │  │    3. Publish():                                                  │     │
 │  │       ├── PCLToProto(current_cloud) → PointCloud2 proto           │     │
 │  │       ├── publish_cloud_cb_1_(proto, param)                       │     │
 │  │       └── publish_cloud_downsample_cb_(downsample_proto, param)   │     │
 │  └───────────────────────────────────────────────────────────────────┘     │
 │                                                                            │
 │  =================== 多雷达模式 (LidarHelperMulti, Linux) =============== │
 │                                                                            │
 │  ┌───────────────────────────────────────────────────────────────────┐     │
 │  │ 接收线程 ×N (每个 LiDAR 一个, 线程名: sensor_lidar)                │     │
 │  │                                                                   │     │
 │  │  ReceiveAndProcessPacket(lidar_data_handler):                     │     │
 │  │    while(run_flag):                                               │     │
 │  │      data_stream_ptr_->read(buffer)                               │     │
 │  │      DecodePacket(pkt_msg)                                        │     │
 │  │      if DATA:                                                     │     │
 │  │        ring_buffer_.push(cloud_ptr)  ← SPSC 队列 (cap=256)       │     │
 │  │        notify_callback_() → cv_.notify_one()                      │     │
 │  └─────────────────────────┬─────────────────────────────────────────┘     │
 │                            │ cv_.notify_one()                              │
 │                            ▼                                               │
 │  ┌───────────────────────────────────────────────────────────────────┐     │
 │  │ ProcessCloud 线程 (线程名: sensor_lidar)                           │     │
 │  │                                                                   │     │
 │  │  while(is_running):                                               │     │
 │  │    cv_.wait(lck)          ← 等待任一雷达产出数据                    │     │
 │  │    for each lidar:                                                │     │
 │  │      cloud_vec = GetCloudVec(handler)  ← pop SPSC 全部             │     │
 │  │      for cloud in cloud_vec:                                      │     │
 │  │        if FrameTimer.TimeUp(stamp):                               │     │
 │  │          pub_flag_vec_[idx] = true                                 │     │
 │  │          *next_cloud_ptr_ += *cloud                                │     │
 │  │        else:                                                      │     │
 │  │          *current_cloud_ptr_ += *cloud                             │     │
 │  │    if CheckPubFlag():  ← 所有雷达都标记完成                         │     │
 │  │      Publish()                                                    │     │
 │  └───────────────────────────────────────────────────────────────────┘     │
 │                                                                            │
 │  ┌───────────────────────────────────────────────────────────────────┐     │
 │  │ CloudCheck 线程                                                    │     │
 │  │   周期检查 FrameTimer 是否超时 → 设 manual_update_flag             │     │
 │  │   → cv_.notify_one() 强制发布                                      │     │
 │  └───────────────────────────────────────────────────────────────────┘     │
 │                                                                            │
 │  ========================= 发布路径 =================================== │
 │                                                                            │
 │  publish_cloud_cb_1_(proto, param)                                        │
 │    ↓                                                                       │
 │  LidarComponent::PublishCloud():                                          │
 │    1. shm_pool_->AcquireWritabledBlock(topic, data_size)                  │
 │    2. memcpy(block, proto.data())                                         │
 │    3. proto.set_data_storage(DATA_STORAGE_SHM)                            │
 │    4. proto.set_data(block.index)                                         │
 │    5. node()->GenerateMessageWithHeader(topic, proto)                     │
 │    6. node()->PublishWithHeader(topic, onboard_msg)                       │
 │                                                                            │
 └────────────────────────────────────────────────────────────────────────────┘

                      │ iceoryx 共享内存
                      ▼
 ┌────────────────────────────────────────────────────────────────────────────┐
 │                      下游消费者                                             │
 │                                                                            │
 │  perception              → /sensors/lidar/combined_point_cloud_proto        │
 │  localization            → /sensors/lidar/combined_point_cloud_proto        │
 │  localization_matching   → /sensors/lidar/combined_point_cloud_proto        │
 │  vio_system              → /sensors/lidar/combined_point_cloud_proto        │
 │  onboard_maps            → /sensors/lidar/combined_point_cloud_proto        │
 │  adas_online_calibrator  → /sensors/lidar/combined_point_cloud_proto        │
 │  adas_calib_monitor      → /sensors/lidar/combined_point_cloud_proto        │
 │  online_recorder         → 全部 3 个 topic                                  │
 └────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. 输入路径

### 2.1 数据采集层

与 sensor_radar（lpcom SHM）和 sensor_ins_online（lpcom + dSomeIP）不同，sensor_lidar **直接通过网络 socket 接收原始数据**：

| 平台 | I/O 方式 | 实现类 | 关键 API |
|-|-|-|-|
| Linux | UDP socket | `StreamBase::create_udp()` | `recvfrom(buffer, maxlen)` |
| QNX（单雷达） | `recvmmsg` 批量收包 | `StreamBase::create_qnx_udp_mmsg()` | `recvmmsg(batch=15, timeout)` → 内部 deque 缓存 → 逐包弹出 |
| QNX（多雷达） | `poll` + `recvmmsg` | `LidarHelperQnxMulti` 内部 | `poll(fds, N, 10ms)` → `recvmmsg()` → 直接合并到 cloud |
| 多端口 | UDP multi | `StreamBase::create_udp()` (multi-port) | 每端口独立 `read()` |
| 离线 | PCAP | `StreamBase::create_pcap()` | 读取 pcap 文件 |

**配置**：通过 `lidar_config.proto` 中的 `stream` 字段指定：

```protobuf
message Stream {
  oneof type_case {
    UdpStream udp = 1;
    TcpStream tcp = 2;
    SerialStream serial = 3;
    PcapStream pcap = 4;
    UdpMultiStream udp_multi = 5;
    QnxUdpStream qnx_udp = 6;
  }
}
```

### 2.2 解码层

每个数据包经过 `DecoderBase::DecodePacket()` 解码：

```
PacketMsg { packet[kMaxLidarPacketLength], packet_length }
    ↓ DecodePacket()
DecoderResult { pkt_type: DATA/DIFOP/ERROR, cloud_ptr: PointCloudXYZIRT::Ptr }
```

**解码器工厂** (`LidarDecoderFactory`) 根据 `lidar_config.type()` 枚举选择具体解码器。

### 2.3 时间校验

`LidarTimeChecker`（`sensors/utility/lidar/lidar_utils.hpp`）在 decoder 解出 cloud 后同步执行：

- **包间隔检查**（`pkt_time_interval`）：相邻 cloud 的 **LiDAR 硬件时间戳差**（`|timestamp - last_pkt_timestamp_|`），非系统时间差
- **系统时间-数据时间差检查**（`pkt_sys_time_diff`）：`|DataPlaneTime::Now() - pkt_timestamp|`，即 PTP 系统时间与包内硬件时间戳的偏差
- 阈值因雷达型号不同：默认 100ms event / 400ms drop；RoboSense RS_MX_SOLID 为 150ms event / 600ms drop

---

## 3. 帧拼装机制

### 3.1 FrameTimer

`FrameTimer`（`sensors/utility/lidar/timer.h`）管理帧周期：

- `kFrameInterval = 100,000 µs`（100ms，即 10Hz 帧率）
- `TimeUp(stamp)` 判断当前点是否属于下一帧

### 3.2 多雷达同步

在多雷达模式下，使用 `pub_flag_vec_` + `CheckPubFlag()` 机制：

- 每个雷达产出一帧数据后设置 `pub_flag_vec_[idx] = true`
- `CheckPubFlag()` 检查所有雷达是否都已标记 → 全部就绪才发布
- `CloudCheck` 线程提供超时保护，避免某雷达掉线导致永不发布

### 3.3 点云合并

```
*current_cloud_ptr_ += *cloud_ptr    // PCL operator+= 拼接
*next_cloud_ptr_ += *overflow_cloud  // 跨帧数据放入下一帧
```

**单雷达模式发布**：

```
PCLToProto(current_cloud, proto)          // PCL → PointCloud2 proto
publish_cloud_cb_1_(proto, param)         // 主点云（全部点）
publish_cloud_downsample_cb_(down, param) // 降采样
```

**多雷达模式发布**（非标定模式，`LidarHelperMulti::PublishCloud`）：

```
for point in current_cloud:
    if point.ring in [sMainLidarRingStart, sMainLidarRingEnd):
        cloud_ptr_main_lidar.add(point)       // 仅主雷达 ring 范围
publish_cloud_cb_1_(cloud_ptr_main_lidar)      // 主 topic: ring 过滤后的子集
if cloud_ptr_main_lidar.size != current_cloud.size:
    publish_cloud_cb_2_(current_cloud)          // with_64 topic: 完整合并点云
```

`sMainLidarRingStart` / `sMainLidarRingEnd` 来自固态雷达（`IsSolidState`）的外参配置 `ring_id_start` / `ring_id_end`。  
主 topic 仅包含主雷达 ring 范围内的点，with_64 topic 在有额外 ring 点时发布完整云。

**标定模式**（`calib_mode = "uncalib"`）：

- 所有外参替换为固定占位符（`kPosXVal` 等）
- `frame_id` 设为 `"lidar_uncalibrated"`
- 仅通过 `publish_cloud_cb_1_` 发布完整点云，不做 ring 过滤

---

## 4. 输出路径

### 4.1 SHM Pool 零拷贝

由于点云数据量大（单帧 \~8MB），使用 SHM Pool 避免通过 iceoryx 标准 mempool 分配：

| SHM Pool | 绑定 Topic | Block 数量 | Block 大小 |
|-|-|-|-|
| `shm_pool_` | `/sensors/lidar/combined_point_cloud_proto` | 10 | 8 MB |
| `shm_pool_with64_` | `/sensors/lidar/combined_point_cloud_with_64_proto` | 10 | 8 MB |
| `shm_pool_downsample_` | `/sensors/lidar/combined_point_cloud_downsample_proto` | 10 | 4 MB |

发布流程：

1. `AcquireWritabledBlock(topic, size)` — 从 Pool 获取可写 block
2. `memcpy(block, data)` — 将点云数据写入共享内存
3. `proto.set_data_storage(DATA_STORAGE_SHM)` — 标记数据在 SHM 中
4. `proto.set_data(block.index)` — proto 中仅保存 index
5. `node()->PublishWithHeader()` — 通过 iceoryx 发布轻量 proto（仅含元数据 + SHM 索引）

### 4.2 输出 Topic 列表

| Topic | Proto 类型 | 频率 | Header 设置 | 消费者 |
|-|-|-|-|-|
| `/sensors/lidar/combined_point_cloud_proto` | `PointCloud2` | \~10Hz | `source_timestamp` + `dataplane_timestamp` + `sequence_num` | perception, localization, INS, VIO, onboard_maps |
| `/sensors/lidar/combined_point_cloud_with_64_proto` | `PointCloud2` | \~10Hz（仅多雷达有额外 ring 时） | `source_timestamp` only（使用 `PublishWithSourceTimestamp`，无 `dataplane_timestamp` / `sequence_num`） | localization_matching |
| `/sensors/lidar/combined_point_cloud_downsample_proto` | `PointCloud2` | \~10Hz | `source_timestamp` + `dataplane_timestamp` + `sequence_num` | planning, online_recorder |

---

## 5. 与 sensor_radar / sensor_ins_online 数据流对比

| 维度 | sensor_lidar | sensor_radar | sensor_ins_online |
|-|-|-|-|
| 原始数据来源 | UDP Socket 直连 | lpcom SHM 订阅 | lpcom SHM/NET 订阅 |
| 数据包大小 | \~1-2KB × 1000+/帧 | \~175KB/帧 | 几十 - 几百字节/帧 |
| 帧合并 | FrameTimer + 多雷达同步 | AllDecodersReady() | 无帧合并 |
| 发布载体 | **SHM Pool 零拷贝** | 标准 iceoryx | 标准 iceoryx |
| 中间队列 | SPSC (cap=256, 仅多雷达) | SPSC (cap=64) | SPSC (cap=64) |
| I/O 线程 | 自管理 (ThreadPool/Thread) | lpcom thread_pool | lpcom thread_pool + mq_recv |
| 回调触发方式 | 数据到达 → 解码 → 帧完成 | lpcom 回调 → SPSC → cv | lpcom 回调 → SPSC → cv |
