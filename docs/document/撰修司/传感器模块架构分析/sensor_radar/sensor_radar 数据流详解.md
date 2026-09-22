---
title: "sensor_radar 数据流详解"
date: 2026-09-20
description: "基准平台：LP8650-V1-SHARE"
categories:
  - 撰修司
tags:
  - sensor_radar
---

# sensor_radar 数据流详解

> 基准平台：LP8650-V1-SHARE  
> 生成日期：2026-04-02

---

## 1. 数据流总览

```
 ┌────────────────────────────────────────────────────────────────────────────┐
 │                         硬件 / 外部进程                                     │
 │                                                                            │
 │  ┌──────────┐   ┌──────────┐   ┌──────────┐                               │
 │  │ MRR 前雷达 │   │ SRR 左后  │   │ SRR 右后  │   ← 独立雷达 ECU             │
 │  │  (radarType=5)│  (radarType=3)│  (radarType=4)│                         │
 │  └─────┬────┘   └─────┬────┘   └─────┬────┘                               │
 │        │              │              │                                      │
 │        ▼              ▼              ▼                                      │
 │  ┌───────────────────────────────────────────┐                              │
 │  │  io-sock / MCU 网关 → lpcom Publisher      │                              │
 │  │    /leap/radar/front      (SHM, 175KB)    │                              │
 │  │    /leap/radar/corner_rl  (SHM, 175KB)    │                              │
 │  │    /leap/radar/corner_rr  (SHM, 175KB)    │                              │
 │  └─────────────────┬─────────────────────────┘                              │
 └────────────────────│────────────────────────────────────────────────────────┘
                      │ lpcom 共享内存传输
                      ▼
 ┌────────────────────────────────────────────────────────────────────────────┐
 │                     sensor_radar 进程                                       │
 │                                                                            │
 │  ┌───────────────────────────────────────────────────────────────────┐     │
 │  │ RadarManager::Init()                                              │     │
 │  │                                                                   │     │
 │  │  lpcom WrappedSubscriberChannel                                   │     │
 │  │    mrr_1 → RegisterMessageCallback → HandleMrr1Message()          │     │
 │  │    srr_1 → RegisterMessageCallback → HandleSrr1Message()          │     │
 │  │    srr_2 → RegisterMessageCallback → HandleSrr2Message()          │     │
 │  │                                                                   │     │
 │  │  HandleXxxMessage(IpcMessage):                                    │     │
 │  │    1. 校验 msg.buffer != nullptr && length >= sizeof(RadarObjects)│     │
 │  │    2. memcpy → leap::radar::RadarObjects                          │     │
 │  │    3. radar_callback_map_[frame_id](radar_objects)                │     │
 │  └───────────────┬───────────────────────────────────────────────────┘     │
 │                  │ 回调闭包                                                │
 │                  ▼                                                         │
 │  ┌───────────────────────────────────────────────────────────────────┐     │
 │  │ RadarHelper::RegisterDecoder 回调                                  │     │
 │  │                                                                   │     │
 │  │  callback = [key](RadarObjects& data):                            │     │
 │  │    1. WatchdogInstance().FeedLoop(key)    ← 喂狗                   │     │
 │  │    2. decoder_info->queue->push(data)    ← SPSC 队列入队           │     │
 │  │    3. is_available_ = true               ← 原子标记                │     │
 │  │    4. cv_.notify_one()                   ← 唤醒解码线程             │     │
 │  └───────────────┬───────────────────────────────────────────────────┘     │
 │                  │ 条件变量唤醒                                            │
 │                  ▼                                                         │
 │  ┌───────────────────────────────────────────────────────────────────┐     │
 │  │ SnrRadAsembProc 线程 (RadarHelper::Start)                         │     │
 │  │                                                                   │     │
 │  │  while(is_running):                                               │     │
 │  │    cv_.wait(is_available_)                                        │     │
 │  │    CheckTimeoutTriggerIgnore()                                    │     │
 │  │    AssembleAndPublish():                                          │     │
 │  │      for each active decoder:                                     │     │
 │  │        ┌──────────────────────────────────────────────┐           │     │
 │  │        │ pop queue → std::any                         │           │     │
 │  │        │ DecodePacket(RadarObjects → Radar proto)     │           │     │
 │  │        │   ├── CheckRadarStatus() → 硬件故障检测       │           │     │
 │  │        │   └── ParseRadarObstacle():                  │           │     │
 │  │        │         for each object:                     │           │     │
 │  │        │           SetRadarObstacle():                │           │     │
 │  │        │             ├── 时间戳: ns → us              │           │     │
 │  │        │             ├── 坐标转换:                    │           │     │
 │  │        │             │   MRR: NearestFace2RearPoint   │           │     │
 │  │        │             │   SRR1: NearestCorner2RearPoint│           │     │
 │  │        │             │   SRR2: NearestCorner2RearPoint│           │     │
 │  │        │             ├── 尺寸: MRR 使用实际尺寸       │           │     │
 │  │        │             │         SRR 使用类型默认尺寸   │           │     │
 │  │        │             └── 航向角: rad → deg             │           │     │
 │  │        │                                              │           │     │
 │  │        │ TimeStampCheck(key, radar_timestamp):        │           │     │
 │  │        │   ├── DIFF_DATA_AND_PKT_ERROR → 丢弃帧       │           │     │
 │  │        │   ├── PKT_TIME_BACK_ERROR → 丢弃帧           │           │     │
 │  │        │   └── PKT_INTERVAL_ERROR → 仅告警             │           │     │
 │  │        │                                              │           │     │
 │  │        │ if is_transform_:                            │           │     │
 │  │        │   RadarUtils::TransformProject(buffer, T)    │           │     │
 │  │        │     → 使用外参四元数做坐标变换                │           │     │
 │  │        │                                              │           │     │
 │  │        │ decoder_info->buffer = buffer                │           │     │
 │  │        │ decoder_info->is_ready = true                │           │     │
 │  │        └──────────────────────────────────────────────┘           │     │
 │  │                                                                   │     │
 │  │      if AllDecodersReady():  ← 等待所有在线雷达数据就绪            │     │
 │  │        CollectBuffers():                                          │     │
 │  │          1. 合并所有 decoder 的 radar_obs[]                       │     │
 │  │          2. 合并 gm_state[], gl_state[]                           │     │
 │  │          3. 计算时间戳平均值:                                      │     │
 │  │             radar_timestamp = sum / count                         │     │
 │  │             timestamp_sec = sum / count                           │     │
 │  │          4. publish_callback_(output)                             │     │
 │  └───────────────┬───────────────────────────────────────────────────┘     │
 │                  │ 回调                                                    │
 │                  ▼                                                         │
 │  ┌───────────────────────────────────────────────────────────────────┐     │
 │  │ RadarComponent::PublishMsg(Radar msg)                              │     │
 │  │   shared_ptr<Radar> → node()->PublishWithSourceTimestamp()         │     │
 │  │   Topic: /sensors/radar/combined_objects                          │     │
 │  │   SourceTimestamp: header.radar_timestamp * 1000 (us→ns)          │     │
 │  └───────────────────────────────────────────────────────────────────┘     │
 │                                                                            │
 │                  ▼ iceoryx 传输                                            │
 └────────────────────────────────────────────────────────────────────────────┘
                    │
        ┌───────────┴──────────────────────┐
        ▼                                  ▼
  ┌──────────────┐                ┌──────────────┐
  │  perception   │                │  safety/AEB  │
  │  感知模块      │                │  安全模块     │
  └──────────────┘                └──────────────┘
```

---

## 2. 输入数据详解

### 2.1 lpcom Topic 与数据结构

| Topic | frame_id | 数据结构 | 最大目标数 | 传输 | 周期 |
|-|-|-|-|-|-|
| `/leap/radar/front` | `mrr_1` | `leap::radar::RadarObjects` | 40 | SHM_ONLY | \~60ms |
| `/leap/radar/corner_rl` | `srr_1` | 同上 | 40 | SHM_ONLY | \~60ms |
| `/leap/radar/corner_rr` | `srr_2` | 同上 | 40 | SHM_ONLY | \~60ms |

### 2.2 `leap::radar::RadarObjects` 关键字段

```c
struct RadarObjects {
    Header          header;          // seqNum + timestampNs（纳秒）
    RadarStatus     status;          // 雷达硬件状态
    uint32_t        objects_num;     // 有效目标数（最大 40）
    RadarObstacle   objects[40];     // 障碍物数组
    LatencyStatus   latency_status;  // 延迟统计
    ModuleStatus    module_status;   // 模块状态
};

struct RadarObstacle {
    uint16_t         id;             // 目标 ID
    uint16_t         life_cycle;     // 生命周期
    bool             valid_flag;     // 有效标志
    uint8_t          type;           // 类别 (0-7)
    uint8_t          ref_point;      // 参考点位置 (0后/1左/2前/3右)
    Point2D          position;       // 相对位置 (x, y) m
    Point2D          velocity;       // 绝对速度 m/s
    Point2D          accel;          // 绝对加速度 m/s²
    float            heading_angle;  // 航向角 rad
    PointSize2D      obj_size;       // 目标尺寸 (length, width)
    // ... 标准差、概率等字段
};
```

---

## 3. 数据处理详解

### 3.1 坐标转换逻辑（`lp_25u1::RadarDecoder`）

雷达输出的障碍物坐标参考点不统一（MRR 使用面心点，SRR 使用角点/偏移），解码器需要统一转换为**后保点 (rear bumper point)** 坐标：

| 雷达 | 输入参考点 | 转换函数 | 说明 |
|-|-|-|-|
| `mrr_1` | 最近面心点 | `NearestFace2RearPoint()` | 根据 `ref_point` (0后/1左/2前/3右) 转换 |
| `srr_1` | 最近角点 | `NearestCorner2RearPoint(1, ...)` | 假设检测到前右角 |
| `srr_2` | 最近角点 | `NearestCorner2RearPoint(0, ...)` | 假设检测到前左角 |

**尺寸处理**：

- MRR：使用雷达实际输出的 `obj_size` (length, width)
- SRR：根据 `type` 查表获取默认尺寸（如 CAR: 4.5×1.5m, PEDESTRIAN: 0.5×0.5m）

### 3.2 外参坐标变换（`RadarUtils::TransformProject`）

当 `enable_transform_coordinate` 为 true 时，对每个障碍物执行：

```
radar_ori_pose = Transformation3(lon, lat, 0.75, 0, 0, angle_rad)
radar_final_pose = sensor_to_radar_transform * radar_ori_pose
→ 更新 longitude_dist, lateral_dist, oritation_angle
```

外参从 `RadarConfigLoader` 加载（`radar_node.bin` + `radars.bin` 文件）。

### 3.3 多雷达同步合并（`CollectBuffers`）

`sensor_radar` 的核心设计是**等待所有在线雷达数据 Ready 后再合并发布**：

```
AllDecodersReady() 判断逻辑：
  for each decoder:
    if decoder 已离线 (LiveStatus::OFFLINE): 跳过
    if decoder 的 is_live_func() == false: 跳过
    if decoder 的 is_ready == false: 返回 false
  return true
```

**合并过程**：

1. 遍历所有 decoder 的 `buffer`，拷贝 `radar_obs[]`, `gm_state[]`, `gl_state[]`
2. 计算所有有效 decoder 的 `radar_timestamp` 和 `timestamp_sec`**平均值**作为输出 header
3. 调用 `publish_callback_` 发布合并后的 `Radar` proto

**关键特点**：

- 与 `sensor_uss` 的 Probe/Obstacle 合并不同，radar 是**等待所有雷达帧到齐**后合并
- 如果某个雷达超时离线（`LiveStatus::OFFLINE`），该雷达被跳过，其余雷达仍然合并发布
- 超时检测由 `CheckTimeoutTriggerIgnore()` 处理，阈值通过构造 `RadarHelper(timeout_ignore_threshold_us)` 设置

---

## 4. 输出数据详解

### 4.1 `/sensors/radar/combined_objects`

**消息类型**：`deeproute.drivers.radar.Radar`

```protobuf
message Radar {
    Header header = 1;              // 平均时间戳
    repeated ContiRadarObs contiobs = 2;  // Continental 雷达格式（LP 平台不使用）
    RadarState radar_state = 3;           // 雷达状态（LP 平台不使用）
    repeated HwRadarObs hwobs = 6;        // 华为雷达格式（LP 平台不使用）
    repeated RadarObs radar_obs = 8;      // ★ 统一障碍物格式（LP 平台使用）
    repeated GMState gm_state = 9;        // GM 状态（LP 为空）
    repeated GLState gl_state = 10;       // GL 状态（LP 为空）
}
```

**下游消费者**：

- `perception` — 输入通道 `/sensors/radar/combined_objects`（在 `perception.jsonnet` 中配置）
- `safety` / AEB — 输入 MRR/SRR 数据做紧急制动决策

### 4.2 `/sensors/radar/combined_point_cloud_proto`

**消息类型**：`deeproute.drivers.PointCloud2`

**说明**：仅在支持 4D 雷达点云的平台上使用（通过 `RadarHelperPointCloud` 路径），LP 平台的 `RadarManager` 仅使用 `RadarHelper`，不初始化点云路径。

---

## 5. 时间戳处理

### 5.1 时间戳转换链

```
leap::radar::RadarObjects.header.timestampNs  (纳秒, 硬件时间戳)
    │
    ▼  DecodePacket: timestampNs / 1000
RadarObs.header.radar_timestamp  (微秒)
RadarObs.header.timestamp_sec    (秒, double, timestampNs / 1e9)
    │
    ▼  CollectBuffers: 求所有 decoder 的平均值
Radar.header.radar_timestamp     (微秒, 平均值)
Radar.header.timestamp_sec       (秒, 平均值)
    │
    ▼  PublishMsg: radar_timestamp * 1000
PublishWithSourceTimestamp()      (纳秒, source timestamp)
```

### 5.2 时间戳异常检测参数

```c
kPktIntervalMax  = 100,000 us (100ms)  // 包间隔上限
kPktIntervalMin  =  30,000 us (30ms)   // 包间隔下限
kDiffAataAndPktMax = 1,000,000 us (1s) // 系统时间与包时间戳最大偏差
```

**丢弃条件**（`TimeStampCheck` 返回 true 时丢弃整帧）：

- `DIFF_DATA_AND_PKT_ERROR`：系统时间与包时间戳偏差超过 1 秒
- `PKT_TIME_BACK_ERROR`：包时间戳出现回跳

---

## 6. 与 sensor_ins_online / sensor_uss 的数据流对比

| 对比项 | sensor_ins_online | sensor_uss | sensor_radar |
|-|-|-|-|
| 输入源数量 | 2 (IMU + GNSS) | 2 (Probe + Obstacle) | 3 (MRR + SRR×2) |
| 输入格式 | C struct (`sensors_ins_packet`) | C struct (`UssRawData` / `UssPerceptionObstacle`) | C struct (`RadarObjects`) |
| SPSC 队列层数 | 2 层 | 1 层 | 1 层 |
| 解码器数量 | 2 (IMU + GNSS) | 2 (Probe + Obstacle) | 3 (mrr_1 + srr_1 + srr_2) |
| 同步策略 | IMU 驱动（无同步） | Obstacle 存储 + Probe 触发合并 | **等待所有雷达 Ready** |
| 坐标转换 | 无 | 有（局部→车体） | 有（参考点→后保点 + 外参变换） |
| 输出 topic 数 | 1 (`/localization/pose`) | 1 (`/sensors/ultrasonic/...`) | 2 (objects + point_cloud) |
| 输出频率 | \~20Hz (IMU 降频) | \~15Hz (USS 周期) | \~17Hz (所有雷达帧对齐) |
| 融合算法 | MSF EKF | 无（直接转发） | 多雷达合并（无滤波） |
