---
title: "sensor_uss 数据流向详解"
date: 2026-09-20
categories:
  - 撰修司
tags:
  - sensor_uss
---

# sensor_uss 数据流向详解

## 一、数据流总览

```
┌──────────┐     ┌──────────────────┐     ┌──────────────────────────┐
│ USS 硬件  │     │  ADPU / MCU      │     │       SOC                │
│ 12个探头  │────►│ USS 控制器       │────►│ sensor_uss 进程          │
│ (超声波)  │     │ (探测+感知处理)   │     │                          │
└──────────┘     └──────────────────┘     └──────────┬───────────────┘
                                                      │
                                          ┌───────────▼────────────┐
                                          │ /sensors/ultrasonic/   │
                                          │ combined_ultrasonic    │
                                          │ (Protobuf Ultrasonic)  │
                                          └───────────┬────────────┘
                                                      │
                                          ┌───────────▼────────────┐
                                          │ 下游模块                │
                                          │ - APA (自动泊车)       │
                                          │ - PDC (泊车雷达)       │
                                          │ - perception           │
                                          └────────────────────────┘
```

---

## 二、输入数据详解（LP 车型）

sensor_uss 从 lpcom 接收**两种数据**：

### 2.1 USS 探头数据（detector）

| 属性 | 值 |
|-|-|
| lpcom topic | `/leap/uss/detector_adas` |
| 传输方式 | 共享内存 (`SHM_ONLY`) |
| 数据类型 | `leap::uss_detector::UssRawData` |
| 消息大小 | 最大 175KB |
| 来源 | ADPU USS 控制器 |

**UssRawData 内容**：12 个超声波探头的原始测距结果

- `targetList[12]` — 每个探头的目标列表

  - `validTargetNum` — 有效目标数量
  - `targetDistance[n]` — 目标距离（毫米）
  - `targetWidth[n]` — 回波宽度
  - `firstTargetHeight[n]` — 回波峰值
  - `confidence[n]` — 置信度
  - `workSeq[n]` — 工作序列（标识直接/左/右回波来源）
  - `frequencyMode` — 频率模式（STD / ADVUP / ADVDOWN）
  - `tartgetTimestampNs` — 纳秒时间戳

**12 个探头编号布局**：

```
        前方
  ┌──────────────────┐
  │ F1 F2 F3 F4 F5 F6│  前排 6 个 (index 0-5, ID 1-6)
  │                  │
  │                  │
  │ R1 R2 R3 R4 R5 R6│  后排 6 个 (index 6-11, ID 12-7)
  └──────────────────┘
        后方

ID 映射:
  前排: index 0→ID1(fls), 1→ID2(flc), 2→ID3(flm), 3→ID4(frm), 4→ID5(frc), 5→ID6(frs)
  后排: index 6→ID12(rls), 7→ID11(rlc), 8→ID10(rlm), 9→ID9(rrm), 10→ID8(rrc), 11→ID7(rrs)
```

### 2.2 USS 障碍物数据（obstacle）

| 属性 | 值 |
|-|-|
| lpcom topic | `/leap/uss/obstacle_adas` |
| 传输方式 | 共享内存 (`SHM_ONLY`) |
| 数据类型 | `leap::uss_perception::UssPerceptionObstacle` |
| 消息大小 | 最大 175KB |
| 来源 | ADPU USS 感知层 |

**UssPerceptionObstacle 内容**：

- `closestObstacle[n]` — 最近障碍物列表

  - `sonicSeq` — 探头序号
  - `confidence` — 置信度
  - `position.x/y` — 局部坐标系位置
  - `obsHeightType` — 障碍物高度类型（低/高/未知）
- `leftSegment[n]` / `rightSegment[n]` — 左/右侧线段障碍物
- `positionUss.x/y` — 车辆位姿
- `eulerAngleUss.yaw` — 车辆航向角
- `ussErrorStatus[12]` — 12 个探头的故障状态
- `elmosMaster1Error/2Error`, `dsi31/32Error` — 驱动芯片故障

---

## 三、输出数据

| 属性 | 值 |
|-|-|
| church topic | `/sensors/ultrasonic/combined_ultrasonic` |
| Protobuf 类型 | `deeproute.drivers.ultrasonic.Ultrasonic` |
| 传输方式 | Iceoryx 共享内存 |

**Ultrasonic 消息内容**：

- `type` — 供应商类型（如 `LP_FORVISION`）
- `objects[]` — 12 个探头的解码结果

  - `id` — 探头 ID
  - `header.frame_id` — 探头名（如 "fls", "flc", ...）
  - `header.timestamp_sec` — 时间戳
  - `multi_echo[]` — 多回波数据（DIRECT/LEFT/RIGHT）
  
    - `distance` — 距离（米）
    - `echo_width` — 回波宽度
    - `echo_peak` — 回波峰值
    - `confidence` — 置信度
  - `frequency_mode` — 频率模式
- `obstacles[]` — USS 感知障碍物（已转换到自车坐标系）

  - `point1_x/y`, `point2_x/y` — 障碍物端点坐标
  - `confidence` — 置信度
  - `obstacle_height` — 高度类型
- `raw_data.raw_objects` — 原始 UssRawData 二进制
- `raw_data.raw_obstacles` — 原始 UssPerceptionObstacle 二进制

---

## 四、完整数据流程图（LP 车型）

```
USS 硬件 (12 探头)
    │
    ▼
ADPU / USS 控制器
    ├─ 探测处理 → UssRawData
    └─ 感知处理 → UssPerceptionObstacle
    │
    ▼ (lpcom SHM)
┌─────────────────────────────────────────────────────────┐
│                  sensor_uss 进程                         │
│                                                         │
│  ┌─── lpcom thread_pool ────────────────────────────┐   │
│  │                                                   │   │
│  │  /leap/uss/detector_adas 回调:                    │   │
│  │    HandleUSSProbeMessage()                        │   │
│  │      memcpy → UssRawData                          │   │
│  │      uss_probe_callback_()                        │   │
│  │        │                                          │   │
│  │  /leap/uss/obstacle_adas 回调:                    │   │
│  │    HandleUSSObstacleMessage()                     │   │
│  │      memcpy → UssPerceptionObstacle               │   │
│  │      uss_obstacle_callback_()                     │   │
│  │        │                                          │   │
│  └────────┼──────────────────────────────────────────┘   │
│           │ push(std::any) → SPSC 队列                   │
│           │ cv_.notify_one()                              │
│           ▼                                               │
│  ┌─── SnrUssAsembProc 线程 ─────────────────────────┐   │
│  │                                                   │   │
│  │  cv_.wait() → pop(queue)                          │   │
│  │    │                                              │   │
│  │    ├─ UssProbeDecoder::DecodePacket()             │   │
│  │    │    ├─ 解码 12 探头的多回波数据                │   │
│  │    │    ├─ 设置 frame_id, timestamp, distance     │   │
│  │    │    ├─ 追加 raw_objects 二进制                 │   │
│  │    │    └─ ObstacleDataStore::MergeInto()         │   │
│  │    │         └─ 合并最新障碍物数据到输出            │   │
│  │    │                                              │   │
│  │    ├─ UssObstacleDecoder::DecodePacket()          │   │
│  │    │    ├─ CheckAndReportFaults() → 12 探头故障检测│   │
│  │    │    ├─ SetVehiclePose() → 逆变换矩阵          │   │
│  │    │    ├─ 遍历 closestObstacle → 坐标变换        │   │
│  │    │    ├─ 遍历 leftSegment → 坐标变换            │   │
│  │    │    ├─ 遍历 rightSegment → 坐标变换           │   │
│  │    │    ├─ 追加 raw_obstacles 二进制               │   │
│  │    │    └─ ObstacleDataStore::Update()            │   │
│  │    │         └─ 缓存到单例 (不直接发布)            │   │
│  │    │                                              │   │
│  │    └─ set_type(LP_FORVISION)                      │   │
│  │       publish_callback_(output)                   │   │
│  │         │                                         │   │
│  └─────────┼─────────────────────────────────────────┘   │
│            ▼                                              │
│  UltrasonicComponent::PublishMsg()                       │
│    node()->Publish("/sensors/ultrasonic/combined_ultrasonic")│
│                                                         │
└─────────────────────────────────────────────────────────┘
    │
    ▼ (Iceoryx SHM)
下游模块（APA / PDC / perception）
```

---

## 五、Probe 与 Obstacle 的合并策略

USS 有两个独立的数据源（Probe 和 Obstacle），但只发布**一个 topic**。合并策略通过 `ObstacleDataStore` 单例实现：

```
时间线:
t1: Obstacle 数据到达 → ObstacleDecoder::DecodePacket()
      → ObstacleDataStore::Update(output)  [存储但不发布, return false]

t2: Probe 数据到达   → ProbeDecoder::DecodePacket()
      → 解码 12 探头
      → ObstacleDataStore::MergeInto(output) [合并 t1 的障碍物]
      → publish_callback_(output)  [发布合并后的完整数据]
```

**关键设计**：

- `UssObstacleDecoder::DecodePacket()` 返回 `false` — 阻止 `AssembleAndPublish` 直接发布
- 障碍物数据通过 `ObstacleDataStore` 缓存
- `UssProbeDecoder::DecodePacket()` 调用 `MergeInto()` 合并障碍物后再返回 `true` — 触发发布
- 每次 MergeInto 后设置 `is_merged_ = true`，防止重复合并

**发布频率**：取决于 Probe 数据的到达频率

---

## 六、坐标变换

`UssObstacleDecoder` 将障碍物坐标从 USS 局部坐标系转换到自车坐标系：

1. 从输入获取车辆位姿 `(x, y, yaw)`
2. 构造 `Transformation3(x, y, 0, 0, 0, yaw)` → 自车到局部的变换
3. 求逆 `.Inverse()` → 局部到自车的变换
4. 对每个障碍物点 `(global_x, global_y)` 做变换得到自车坐标

---

## 七、与 sensor_ins_online 数据流的关键区别

| 方面 | sensor_ins_online | sensor_uss |
|-|-|-|
| 数据来源 | 2 种（IMU + GNSS） | 2 种（Probe + Obstacle） |
| SPSC 队列层数 | 2 级（InsHelper → InsOnlineManager） | **1 级**（UltrasonicHelper 内部） |
| 核心算法 | MSF Kalman 滤波（localization-mcu） | **无**（纯解码 + 格式转换） |
| 数据合并 | IMU 驱动 publish，GNSS 存入 measurement map | Obstacle 缓存，Probe 驱动 publish 时合并 |
| 坐标变换 | WGS84 → GCJ02（国家保密算法） | 局部坐标系 → 自车坐标系（Transformation3） |
| 输出 topic 数 | 11 个 | **1 个** |
| publish 频率 | IMU \~20Hz, GNSS \~10Hz | 取决于 Probe 到达频率 |
| 发布位置 | Init() 注册回调（SnrInsOnlnProc 驱动） | Init() 注册回调（SnrUssAsembProc 驱动） |
