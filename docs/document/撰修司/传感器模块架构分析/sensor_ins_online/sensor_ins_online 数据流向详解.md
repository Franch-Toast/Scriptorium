---
title: "sensor_ins_online 数据流向详解"
date: 2026-09-20
description: "关联文档：sensor_ins_online_module_guide.md（模块总体说明书）"
categories:
  - 撰修司
tags:
  - sensor_ins_online
---

# sensor_ins_online 数据流向详解

> **最后更新：** 2026-04-02  
> **关联文档：**`sensor_ins_online_module_guide.md`（模块总体说明书）

---

## 一、数据流全景图

### 1.1 顶层视图

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│                                 上游数据源                                            │
├──────────────────┬────────────────────┬──────────────────────────────────────────────┤
│  ADPU/INMU 硬件   │ /canbus/           │  /localization/                              │
│  (独立芯片)       │ wheel_speed        │  matching_status                             │
│                  │ [CbwComponent]      │  [LocalizationMatchingComponent]             │
│  IMU  ~200Hz     │ [WheelSpeed] ~50Hz  │  [LidarMatchingMessage] ~10Hz               │
│  GNSS ~1-10Hz    │                    │                                              │
└────────┬─────────┴─────────┬──────────┴────────────┬─────────────────────────────────┘
         │                   │                       │
         │  dSomeIP 事件     │  iceoryx 共享内存      │  iceoryx 共享内存
         │  (Smart/GWM/Geely)│                       │
         │  或 lpcom 通道    │                       │
         │  (LP 零跑车型:    │                       │
         │   SHM_ONLY/       │                       │
         │   NET_ONLY)       │                       │
         ▼                   │                       │
┌─────────────────────┐      │                       │
│ 通信 SDK 线程 ⑭     │      │                       │
│ (dSomeIP / lpcom)   │      │                       │
│  ↓ 事件/消息回调     │      │                       │
│  InsHelper SPSC(64)  │      │                       │
│  ↓ cv.notify         │      │                       │
│  SnrInsAsembProc ⑫  │      │                       │
│  ↓ decode + publish  │      │                       │
└────────┬────────────┘      │                       │
         │ vector<uint8_t>   │                       │
         ▼                   │                       │
┌────────────────────────────┼───────────────────────┼──────────────────────────────────┐
│                sensor_ins_online 进程                                                  │
│                                                                                        │
│  ins_recv_queue_ (SPSC 64) │                       │                                  │
│  ┌──── SnrInsOnlnProc 线程 ⑬ (Thread 15) ── 核心处理 ──────────────────────────────┐  │
│  │  pop(pkt) → UnpackSensorsIns(pkt)                                                │  │
│  │     │                                                                             │  │
│  │     │  ┌─ 如果 imu_valid ──────────────────────────────────────────────────┐     │  │
│  │     ├──┤  ParseImu(raw_imu, proto)                                         │     │  │
│  │     │  │    → raw_imu_callback_() → Publish ① /sensors/gnss/raw_short_    │     │  │
│  │     │  │                               raw_imu [~200Hz]                    │     │  │
│  │     │  │    → SaveRawImuMsg(MSF, &imu)                                    │     │  │
│  │     │  │       → INSERT_OR_CREATE_PROTOCOL(ts, imu_) [mutex, ~5us]        │     │  │
│  │     │  │       → HandleMeasurementBeforeGivenTime(MSF, ts-buffer)         │     │  │
│  │     │  │          → LockMSF → drain map → UnlockMSF [~10us]              │     │  │
│  │     │  │          → for each measurement:                                 │     │  │
│  │     │  │             HandleRawImuMsg → 29x29 Kalman 滤波 [~300-500us]     │     │  │
│  │     │  │             HandleGnssPositionMsg → Kalman 量测更新               │     │  │
│  │     │  │             HandleWheelSpeedMsg → 轮速约束 + Kalman 更新          │     │  │
│  │     │  │             HandleLidarMatchMsg → Lidar 约束                      │     │  │
│  │     │  └───────────────────────────────────────────────────────────────────┘     │  │
│  │     │                                                                             │  │
│  │     │  ┌─ 如果 gnss_position_valid ────────────────────────────────────────┐     │  │
│  │     ├──┤  ParseGnssPosition(gnss_pos, proto)                               │     │  │
│  │     │  │    → raw_pose_callback_() → Publish 3 个 topic:                   │     │  │
│  │     │  │       ② /sensors/gnss/wgs84_gnss_position [WGS84]                │     │  │
│  │     │  │       ③ /sensors/gnss/gcj02_gnss_position [GCJ02, WgtoChinaLb]   │     │  │
│  │     │  │       ④ /sensors/gnss/raw_gnss_position   [=③ 同一消息]           │     │  │
│  │     │  │    → SaveGnssPositionMsg(MSF, &pos) [mutex, 插入 map]             │     │  │
│  │     │  └───────────────────────────────────────────────────────────────────┘     │  │
│  │     │                                                                             │  │
│  │     │  ┌─ 如果 gnss_velocity_valid ────────────────────────────────────────┐     │  │
│  │     ├──┤  ParseGnssVelocity(gnss_vel, proto)                               │     │  │
│  │     │  │    → raw_vel_callback_() → Publish ⑤ /sensors/gnss/raw_gnss_     │     │  │
│  │     │  │                                velocity [~1-10Hz]                 │     │  │
│  │     │  │    → SaveGnssVelocityMsg(MSF, &vel) [mutex, 插入 map]             │     │  │
│  │     │  └───────────────────────────────────────────────────────────────────┘     │  │
│  │     │                                                                             │  │
│  │     │  ┌─ 如果 ins_valid (Smart 车型) ─────────────────────────────────────┐     │  │
│  │     ├──┤  ParseIns(ins_pva, proto)                                         │     │  │
│  │     │  │    → raw_ins_callback_() → Publish                                │     │  │
│  │     │  │       ⑥ /sensors/gnss/raw_ins_pva_x [WGS84]                      │     │  │
│  │     │  │       ⑦ /sensors/gnss/gcj02_ins_pva_x [GCJ02]                    │     │  │
│  │     │  └───────────────────────────────────────────────────────────────────┘     │  │
│  │     │                                                                             │  │
│  │     │  ┌─ 如果 gga_valid ─────────────────────────────────────────────────┐     │  │
│  │     ├──┤  ParseGga(gga, proto)                                             │     │  │
│  │     │  │    → raw_gga_callback_() → Publish ⑧ /sensors/gnss/raw_gga      │     │  │
│  │     │  │                                [~1Hz]                             │     │  │
│  │     │  └───────────────────────────────────────────────────────────────────┘     │  │
│  │     │                                                                             │  │
│  │     └──→ GetPose(pose_msg) → GetExtrapolatedVehicleState() [mutex, ~1-3ms]       │  │
│  │            │                                                                      │  │
│  │            ├─ 成功 → odometry_output_callback_()                                  │  │
│  │            │         → Publish ⑨ /localization/pose [~20Hz, 经 IMU 降频]          │  │
│  │            │                                                                      │  │
│  │            ├─ 关键帧更新 → key_frame_callback_()                                   │  │
│  │            │         → Publish ⑩ /localization/keyframe_update_status [按需]       │  │
│  │            │                                                                      │  │
│  │            └─ 每 N 帧 → internal_msf_state_callback_()                            │  │
│  │                      → Publish ⑪ /localization/debug/internal_state [降频]        │  │
│  │                                                                                   │  │
│  │  TIMEEND(ETH_PKT_PROCESS) → 如果 > 10ms → 上报 DECODER_PROCESS_TIME_TOO_LONG    │  │
│  └───────────────────────────────────────────────────────────────────────────────────┘  │
│                                                    │                                    │
│  ┌──── t_SensorInsOnline 线程 ④ (Thread 12) ──── church Proc() ─────────────────────┐  │
│  │                                                 │                                 │  │
│  │  iceoryx_dispatch ② 收到消息 → Dispatch(PROC)  │                                 │  │
│  │    ↓                                            │                                 │  │
│  │  Proc(input_msgs):                              ▼                                 │  │
│  │    /canbus/wheel_speed ──→ impl_->AddWheel()  ──→ SaveWheelSpeedMsg()            │  │
│  │      [WheelSpeed, ~50Hz]     [Thread 12]          [mutex, 插入 map]               │  │
│  │                                                   ↓                               │  │
│  │    /localization/matching_status                 time_to_measurement_              │  │
│  │      ──→ impl_->AddLidarMatchMsg() ──→ SaveLidarMatchingMsg()                    │  │
│  │      [LidarMatchingMessage, ~10Hz]     [mutex, 插入 map]                          │  │
│  │                                                                                   │  │
│  │  注意: Proc() 不产生任何输出消息, output_msgs 为空                                  │  │
│  └───────────────────────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────────────────────┘
         │
         │ 11 个输出 topics (全部由 Thread 15 通过 Init() 回调发布)
         ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                 下游消费者（详见第三节各 topic）                         │
│                                                                                        │
│  /localization/pose ──→ Perception, Planning, Control, Safety, AEB, MapEngine, ...     │
│  /sensors/gnss/raw_short_raw_imu ──→ GpsLocalization, AdasCalibrator, InsOnline        │
│  /sensors/gnss/wgs84_gnss_position ──→ GpsLocalization, AdasCalibrator                │
│  /sensors/gnss/raw_gnss_velocity ──→ GpsLocalization, InsOnline                        │
│  ...                                                                                   │
│                                                                                        │
│  GpsLocalizationComponent 消费 IMU+GNSS+速度 → 发布 /sensors/gnss/pose (~10Hz)        │
│    → Perception, Planning, Safety, Localization, MapEngine, AEB, ...                  │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### 1.2 频率汇总

| 数据/Topic | 来源 | 频率 | 处理线程 | 发布线程 |
|-|-|-|-|-|
| IMU 原始数据（ADPU → sensors → MCU） | 硬件 | \~200Hz | dSomeIP SDK → SnrInsAsembProc → SnrInsOnlnProc | — |
| GNSS 位置/速度/PVA（ADPU → sensors → MCU） | 硬件 | \~1-10Hz | 同上 | — |
| `/sensors/gnss/raw_short_raw_imu` | ParseImu() | \~200Hz | Thread 15 | Thread 15 |
| `/sensors/gnss/wgs84_gnss_position` | ParseGnssPosition() | \~1-10Hz | Thread 15 | Thread 15 |
| `/sensors/gnss/gcj02_gnss_position` | 同上 + WgtoChinaLb | \~1-10Hz | Thread 15 | Thread 15 |
| `/sensors/gnss/raw_gnss_position` | 同上（=gcj02 同一消息） | \~1-10Hz | Thread 15 | Thread 15 |
| `/sensors/gnss/raw_gnss_velocity` | ParseGnssVelocity() | \~1-10Hz | Thread 15 | Thread 15 |
| `/sensors/gnss/raw_ins_pva_x` | ParseIns() | \~1-10Hz | Thread 15 | Thread 15 |
| `/sensors/gnss/gcj02_ins_pva_x` | 同上 + WgtoChinaLb | \~1-10Hz | Thread 15 | Thread 15 |
| `/sensors/gnss/raw_gga` | ParseGga() | \~1Hz | Thread 15 | Thread 15 |
| `/localization/pose` ★ | GetPose() → Extrapolator | \~20Hz（IMU 200Hz 经降频） | Thread 15 | Thread 15 |
| `/localization/keyframe_update_status` | UpdateKeyFrame() | 按需 | Thread 15 | Thread 15 |
| `/localization/debug/internal_state` | GetInternalMSFState() | 降频（每 N 帧） | Thread 15 | Thread 15 |
| `/canbus/wheel_speed`（输入） | CbwComponent | \~50Hz | Thread 12 (Proc) | — |
| `/localization/matching_status`（输入） | LocalizationMatching | \~10Hz | Thread 12 (Proc) | — |

### 1.3 为什么 /localization/pose 是 20Hz 而不是 200Hz？

IMU 数据是 200Hz，但 `/localization/pose` 只有约 20Hz。这是因为 `InsOnlineManager` 中有一个 **IMU 降频逻辑**（`imu_downscale_index_`）：并非每帧 IMU 都触发 `GetPose()` 和位姿发布，而是每收到约 10 帧 IMU 才输出一次位姿。MSF 融合仍然在每帧 IMU 上运行（保证精度），但位姿外推和回调发布是降频的（减少下游负载）。

---

## 二、输入数据详解

sensor_ins_online 有 **两条输入路径**，数据进入方式完全不同。

### 2.1 路径 A：硬件传感器数据（dSomeIP → sensors → 算法层）

#### 2.1.1 sensors 仓库是什么？它不是 IMU 固件

**sensors 仓库的代码不是烧写在 IMU/GNSS 设备中的固件。** 它是运行在 **SOC（主计算平台，如 Qualcomm SA8650）** 上的**软件驱动层**，负责通过网络协议接收来自独立硬件设备的数据。

在整车架构中，IMU/GNSS 是一个独立的硬件模块（通常称为 **ADPU — Application Data Processing Unit**，或称惯性导航模组/INMU），它有自己的处理器和固件。ADPU 和 SOC 是**不同的芯片**，通过**车载以太网**物理连接。

```
┌─────────────────────┐    车载以太网 (Ethernet)     ┌─────────────────────┐
│   ADPU / INMU 模组   │ ◄══════════════════════════► │   SOC 主计算平台      │
│  (独立硬件设备)       │    SOME/IP 协议              │  (SA8650 / Orin)     │
│                     │                              │                     │
│ • 自有处理器 + 固件  │    dSomeIP 事件通知           │ • QNX RTOS          │
│ • Epson G365 IMU    │    ─────────────────────►    │ • sensors 仓库代码    │
│ • GNSS 接收机       │    AdpuImu / AdpuGnss /      │ • localization-mcu   │
│ • 内部完成 IMU 采集  │    AdpuIns 事件数据           │ • 其他自动驾驶模块    │
│   和 GNSS 解算      │                              │                     │
│                     │                              │                     │
│ 固件完成的工作:       │                              │ sensors 驱动完成的工作:│
│ • IMU 原始采样       │                              │ • 接收 dSomeIP 事件  │
│ • GNSS 卫星信号处理  │                              │ • 解码协议数据       │
│ • PVA 初步解算       │                              │ • 数据格式转换       │
│ • 数据通过 dSomeIP   │                              │ • 传递给算法层       │
│   协议发送到 SOC     │                              │                     │
└─────────────────────┘                              └─────────────────────┘
```

#### 2.1.2 SOC 与 ADPU 之间的通信机制

**通信协议：dSomeIP（Deeproute SOME/IP）**

SOME/IP（Scalable service-Oriented MiddlewarE over IP）是汽车行业标准的面向服务的通信中间件，运行在以太网之上。Deeproute 基于标准 SOME/IP 实现了自己的变体 dSomeIP。

**通信模式：事件订阅（Event/Subscribe）**

ADPU 作为**服务端（Server/Publisher）**，周期性发布传感器数据事件；SOC 上的 sensors 代码作为**客户端（Client/Subscriber）**，订阅这些事件并接收数据。

从代码中可以看到具体的服务和事件类型（以 Smart HY11 车型为例）：

| 组件 | 说明 |
|-|-|
| **dSomeIP 服务** | `SensorAdpuDataOutputA4socService`（传感器 ADPU 数据输出到 A4 SOC 的服务） |
| **客户端类** | `SensorAdpuDataOutputA4socServiceClient`（SOC 端订阅客户端） |
| **IMU 事件** | `AdpuImu`（ADPU 发送的 IMU 数据，\~200Hz） |
| **GNSS 事件** | `AdpuGnss`（ADPU 发送的 GNSS 定位数据，\~1-10Hz） |
| **INS 事件** | `AdpuIns`（ADPU 发送的 INS PVA 数据） |
| **dSomeIP SDK 头文件** | `v1/smart/sensor_adpu_data_output_a4soc_service/...client.hpp`（由 `@dsomeip-sdk` 提供） |

不同车型使用不同的通信 SDK 变体（由 Bazel `select` 选择）：

- Smart HY11/HY11P：`@dsomeip-sdk//smart_hy11:...`（dSomeIP）
- GWM C01/M8/Tank/Oriny：`@dsomeip-sdk//gwm_v2:Sensors_Ins`（dSomeIP）
- GWM Thoru：`@dsomeip-sdk//gwm_thoru_share:Sensors_Ins`（dSomeIP）
- Geely Yinhe：`@dsomeip-sdk//yinhe:eb_sensor_ins`（dSomeIP）
- **LP8650/LP8797（零跑车型）**：`@lpsdk//:lpcom`（lpcom，见下文 2.1.5 节）

#### 2.1.5 LP 车型的 lpcom 通信机制（替代 dSomeIP）

**lpcom（`liblpCom.so.2`）** 是零跑汽车（Zhejiang Leapmotor Technology）的 IPC 通信 SDK，命名空间 `Leap::Com`。在 LP8650/LP8797 车型上，它替代 dSomeIP 作为 ADPU/SOC 之间的通信中间件。

**Bazel 依赖来源（两条等效路径）：**

| 路径 | 来源 | 说明 |
|-|-|-|
| `@lpsdk//:lpcom` | `git@code.deeproute.ai:third-party-repos/lpsdk.git` | 独立 SDK 仓库（`sensors` 仓库使用此路径） |
| `@lp_release//:lpcom` → `@lp8650//:lpcom` | HTTP 归档预编译产物 | `misc_workspace` 构建路径，按 SA8650/SA8797 平台选择 |

两者提供相同的 `liblpCom.so*` 动态库和 `oem/include/lpCom/` 头文件。

**lpcom 核心组件：**

| 组件 | 头文件 | 作用 |
|-|-|-|
| `WrappedPSChannelFactory` | `wrapped/ps/WrappedPSChannelFactory.h` | 发布-订阅通道工厂（单例），创建 Subscriber/Publisher Channel |
| `WrappedSubscriberChannel` | 同上 | 订阅端通道实例，提供 `Open()`/`Close()`/`RegisterMessageCallback()` |
| `PSChannelAttribute` | 同上 | 通道配置：topic 名、消息大小、传输类型、目标 IP |
| `TransType` | 同上 | 传输方式枚举：`SHM_ONLY`（共享内存）、`NET_ONLY`（网络） |
| `IpcMessage` | 同上 | 接收到的消息载体：`{buffer, length}` |
| `MatchedStatus` | 同上 | 发布端/订阅端配对状态通知 |
| `ErrorCodeCallback` | `deeproute::lpsdk` 命名空间 | 错误码回调（超时、不可用、通信丢失） |

**LP8650 车型的 INS 通道配置（`InsManager::Init()`）：**

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  IMU 通道                                                                    │
│  topic:         /leap/imu/imu_data_adas                                     │
│  transType:     SHM_ONLY (共享内存 — ADPU 和 SOC 在同一物理板上)              │
│  sizeOfMessages: 175 KB                                                      │
│  numOfMessages: 1                                                            │
│  频率:          ~200Hz                                                       │
│  数据类型:      leap::insdata::ImuData (加速度、角速度、温度、时间同步状态)     │
├──────────────────────────────────────────────────────────────────────────────┤
│  GNSS 通道                                                                   │
│  topic:         /leap/gnss/gnss_data                                        │
│  transType:     NET_ONLY (网络传输 — GNSS 模组通过以太网连接)                 │
│  ips:           { "172.31.3.202" } (GNSS 模组固定 IP)                       │
│  sizeOfMessages: 175 KB                                                      │
│  numOfMessages: 1                                                            │
│  频率:          ~1-10Hz                                                      │
│  数据类型:      leap::insdata::GnssData (经纬高、速度、解算状态、卫星数)       │
└──────────────────────────────────────────────────────────────────────────────┘
```

**为什么 IMU 用共享内存而 GNSS 用网络？**

- IMU 模组集成在 ADPU 板上，与 SOC 共享内存总线，延迟极低（微秒级）
- GNSS 接收机是独立模组，通过以太网与 SOC 通信（IP: `172.31.3.202`）

**lpcom 数据接收完整流程（以 IMU 为例）：**

```
ADPU 硬件 (200Hz IMU)
  │ SHM_ONLY (共享内存)
  ▼
lpcom SDK 内部线程 ← WrappedSubscriberChannel::Open() 启动
  │ RegisterMessageCallback 触发
  ▼
InsManager::HandleIMUMessage(IpcMessage& msg)  [lpcom 回调线程]
  │ memcpy(msg.buffer → leap::insdata::ImuData)
  │ imu_callback_(imu_data)    ← InsHelper::RegisterDecoder() 返回的 lambda
  ▼
InsHelper SPSC 队列 #1 (capacity=64)
  │ push(std::any(ImuData))
  │ cv_.notify_one()
  ▼
SnrInsAsembProc 线程
  │ pop → any_cast<ImuData>
  │ ImuDecoder::DecodePacket():
  │   • timestamp_ns / 1000 → measurement_time (μs)
  │   • accel_raw / 9.81e-6 → x/y/z_acce (微g)
  │   • angle_rate_raw × 1e6 → x/y/z_gyro (μdeg/s)
  │   • imu_status/time_sync_status → 状态码映射
  │ OrientationRotate() — IMU 安装方向补偿
  │ publish_callback_(sensors_ins_packet)
  ▼
InsComponentImpl 适配层
  │ reinterpret_cast<uint8_t*>(&packet) → vector<uint8_t>
  ▼
InsOnlineManager::ins_recv_queue_ (SPSC 队列 #2, capacity=64)
  │ queue_cv_.notify_one() → 唤醒 SnrInsOnlnProc
  ▼
后续 MSF 融合处理（与 dSomeIP 路径相同）
```

**lpcom 错误监控（`ErrorCodeCallback`）：**

| ErrorCode | 含义 | 上报事件 |
|-|-|-|
| `kFindTopicTimeout` | 查找 topic 超时 | `LP_INS_ONLINE_INMU_SRV_FIND_SERVICE_TIMEOUT` |
| `kTopicUnavailable` | topic 不可用 | `LP_INS_ONLINE_INMU_SRV_UNAVAILABLE` |
| `kLoseTimeout` | 通信丢失超时 | `INS_ONLINE_INMU_LOST_COMMUNICATION` |
| `kFrameTimeout` | 帧超时 | `LP_INS_ONLINE_INMU_TOPIC_FRAME_TIMEOUT` |
| `kCallbackTimeout` | 回调处理超时 | `LP_INS_ONLINE_INMU_TOPIC_CALLBACK_TIMEOUT` |

GNSS 通道有独立的错误码上报事件（topic 名 `/leap/gnss_data`）。

**lpcom 与 dSomeIP 对比：**

| 维度 | dSomeIP | lpcom |
|-|-|-|
| 标准 | 基于 AUTOSAR SOME/IP | 零跑自研 Pub-Sub IPC |
| 传输类型 | 仅网络（以太网） | 共享内存 + 网络可选 |
| 服务发现 | SOME/IP-SD 协议 | 内置 topic 发现 |
| 数据格式 | 车型特定 dSomeIP event 结构 | `IpcMessage{buffer, length}` → `leap::insdata::*` 结构 |
| 错误处理 | dSomeIP 层面 | `ErrorCodeCallback` 回调机制 |
| 适用车型 | Smart、GWM、Geely | LP8650、LP8797（零跑） |
| SDK 来源 | `@dsomeip-sdk` 仓库 | `@lpsdk` 仓库 / `@lp8650` 预编译包 |

#### 2.1.3 通信的数据内容

ADPU 通过 dSomeIP 发送的数据被 sensors 层的 **decoder** 解码为统一的 `sensors_ins_packet` 结构体（定义在 `sensors/utility/ins/sensor_ins_online_interface.h`）：

```c
typedef struct {
  raw_imu_t imu;                // IMU 数据：三轴加速度/角速度/温度
  gnss_velocity_t gnss_velocity; // GNSS 速度：水平速度/航迹角/垂直速度
  gnss_position_t gnss_position; // GNSS 位置：经纬高/精度/卫星数
  ins_pva_t ins;                // INS PVA：位置/速度/姿态/标准差
  raw_gga_t gga;                // NMEA GGA：原始 GGA 字符串
  bool imu_valid;               // IMU 数据有效标志
  bool gnss_velocity_valid;     // GNSS 速度有效标志
  bool gnss_position_valid;     // GNSS 位置有效标志
  bool ins_valid;               // INS PVA 有效标志
  bool gga_valid;               // GGA 有效标志
} sensors_ins_packet;
```

每个子结构的关键字段：

| 数据类型 | 关键字段 | 频率 | 说明 |
|-|-|-|-|
| `raw_imu_t` | `x/y/z_acce`, `x/y/z_gyro`, `temperature`, `gps_week`, `gps_seconds` | \~200Hz | 三轴加速度和角速度的原始采样值，需要根据 IMU 型号做标度因子转换 |
| `gnss_position_t` | `latitude/longitude/height`, `std_*`, `position_type`, `number_satellites`, `gnss_l1/l5_cn0[]` | \~1-10Hz | WGS84 坐标、精度指标、卫星信噪比（最多 80 颗星） |
| `gnss_velocity_t` | `horizontal_speed`, `track_over_ground`, `vertical_speed` | \~1-10Hz | GNSS 多普勒测速结果 |
| `ins_pva_t` | `latitude/longitude/height_msl`, `north/east/up_velocity`, `roll/pitch/azimuth`, `*_std` | \~1-10Hz | ADPU 内部 INS 解算的完整 PVA（位置/速度/姿态）及标准差 |
| `raw_gga_t` | `raw_gga[256]` | \~1Hz | NMEA 0183 GGA 语句原始字符串 |

#### 2.1.4 sensors 层内部处理流程

| 属性 | 说明 |
|-|-|
| **来源** | ADPU 硬件设备（通过 dSomeIP 或 lpcom 传输） |
| **传输协议** | dSomeIP（Smart/GWM/Geely）或 lpcom 共享内存+网络（LP 零跑车型） |
| **中间层** | `sensors` 仓库的 `InsComponentImpl` → `InsHelper` → SPSC 队列 |
| **进入模块方式** | `SensorStream::Init(callback)` 注册回调，`sensors` 层解码后调用 callback |
| **数据格式** | `std::vector<uint8_t>`（`sensors_ins_packet` 的内存拷贝） |
| **目标队列** | `InsOnlineManager::ins_recv_queue_`（boost SPSC queue，容量 64） |
| **处理线程** | `SnrInsOnlnProc`（Thread 15） |
| **频率** | IMU \~200Hz，GNSS \~1-10Hz |

**数据流链条（双路径 — dSomeIP 车型 vs LP 车型）：**

```
ADPU 硬件设备 (独立芯片)
  │ 车载以太网 / 共享内存
  ▼
┌─── Smart/GWM/Geely 车型 ────┐  ┌─── LP8650/LP8797 车型 ──────────────────┐
│ dSomeIP 事件到达 SOC          │  │ lpcom WrappedSubscriberChannel 收到数据  │
│  │ ServiceClient 事件回调     │  │  │ SHM_ONLY (IMU) / NET_ONLY (GNSS)   │
│  ▼                           │  │  ▼                                      │
│ InsManager 将 callback       │  │ InsManager::HandleIMUMessage(IpcMessage) │
│ 绑定到 dSomeIP event        │  │  │ memcpy → leap::insdata::ImuData      │
│  │ 触发 callback 时:         │  │  │ imu_callback_(imu_data)              │
└──┼───────────────────────────┘  └──┼──────────────────────────────────────┘
   │                                 │
   └──────────────┬──────────────────┘
                  ▼ 统一接口: InsHelper::RegisterDecoder 返回的 lambda
InsHelper SPSC 队列 #1 (capacity=64)
  │ decoder_info->queue->push(data)
  │ cv_.notify_one()
  ▼
SnrInsAsembProc 线程 [sensors 仓库]
  │ AssembleAndPublish():
  │   遍历所有 decoder 的队列
  │   decoder->DecodePacket(data, output)  ← 解码为 sensors_ins_packet
  │   InsUtils::OrientationRotate(...)     ← IMU 坐标系旋转（按安装方向）
  │   publish_callback_(output)            ← 调用 localization-mcu 注册的回调
  ▼
InsComponentImpl::Init(callback) 中的适配 lambda
  │ 将 sensors_ins_packet 序列化为 std::vector<uint8_t>
  │ callback(data)
  ▼
InsOnlineManager 中 InitGnss 注册的 lambda
  │ ins_recv_queue_.push(data)             [SPSC 队列, 容量 64]
  │ queue_cv_.notify_one()
  ▼
SnrInsOnlnProc 线程 pop 并处理 [localization-mcu]
```

> **关键设计：** 无论使用 dSomeIP 还是 lpcom，数据都在 `InsHelper::RegisterDecoder()` 处汇合为统一接口。从 `InsHelper` 往上的所有层（`InsComponentImpl` → `SensorStream` → `InsOnlineManager` → MSF 算法）完全不感知底层使用了哪种通信中间件。

**原始字节流被 `UnpackSensorsIns()` 解析为 `sensors_ins_packet` 结构，包含：**

| 字段 | 类型 | 说明 |
|-|-|-|
| `imu` | `raw_imu_t` | IMU 原始数据（加速度、角速度、温度） |
| `gnss_position` | `gnss_position_t` | GNSS 位置（经纬高、精度） |
| `gnss_velocity` | `gnss_velocity_t` | GNSS 速度（东北天分量） |
| `ins_pva` | `ins_pva_t` | INS PVA（位置速度姿态） |
| `gga` | `raw_gga_t` | NMEA GGA 语句（定位质量） |

### 2.2 路径 B：church 框架消息（Proc() 调度输入）

| 属性 | 说明 |
|-|-|
| **接入方式** | church 框架的 `Proc()` 方法，由 trigger_policy=`ANY` 触发 |
| **处理线程** | `t_SensorInsOnline` church task 线程（Thread 12） |

**输入 channel 明细：**

| Topic | Protobuf 类型 | 发布者 | 频率 | channel 类型 | 说明 |
|-|-|-|-|-|-|
| `/canbus/wheel_speed` | `deeproute.canbus.WheelSpeed` | `CbwComponent` (cbw.jsonnet) | \~50Hz | optional, cache=1 | 四轮轮速 |
| `/localization/matching_status` | `deeproute.localization.message.LidarMatchingMessage` | `LocalizationMatchingComponent` | \~10Hz | optional, cache=1 | Lidar 点云匹配结果 |
| `/sensors/someip/rawdata` | `deeproute.drivers.gnss.RawData` | SomeIP 适配器 | \~200Hz | optional, queue=50, cache=50, allow_breaking_order=true, do_not_skip_proc=true | SomeIP 原始数据（某些车型走 church 而非直接 dSomeIP） |

**进入模块后的数据路径：**

```
/canbus/wheel_speed
  → Proc() → impl_->AddWheel(WheelSpeed)
  → InsOnlineManager::AddWheelSpeed(msg_ptr)
  → SaveWheelSpeedMsg(MSF, &wheel_speed_data)   [multi_sensors_fusion.c]
  → INSERT_OR_CREATE_PROTOCOL(timestamp, wheel_speed_)  [需 MSF mutex]
  → 数据进入 time_to_measurement_ 有序 map

/localization/matching_status
  → Proc() → impl_->AddLidarMatchMsg(LidarMatchingMessage)
  → InsOnlineManager::AddLidarMatching(msg_ptr)
  → SaveLidarMatchingMsg(MSF, &lidar_data)       [multi_sensors_fusion.c]
  → INSERT_OR_CREATE_PROTOCOL(timestamp, lidar_)  [需 MSF mutex]
  → 数据进入 time_to_measurement_ 有序 map
```

### 2.3 两条输入路径的汇合点

两条路径最终都将数据送入 `MultiSensorsFusionOdometry` 的 `time_to_measurement_` 有序 map：

```
路径 A (Thread 15):
  IMU 数据 → SaveRawImuMsg → INSERT_OR_CREATE_PROTOCOL → map
  GNSS 数据 → SaveGnssPositionMsg / SaveGnssVelocityMsg → map

路径 B (Thread 12):
  WheelSpeed → SaveWheelSpeedMsg → map
  LidarMatch → SaveLidarMatchingMsg → map

                ↓ 汇合
  HandleMeasurementBeforeGivenTime() [Thread 15 调用]
  → 从 map 中取出 timestamp ≤ 当前 IMU 时间的所有数据
  → 按时间顺序逐条处理（Kalman 滤波）
```

---

## 三、输出数据详解

sensor_ins_online 的输出有 **两种发送机制**：

| 机制 | 说明 | 涉及 topics |
|-|-|-|
| **Init() 回调** | 在 `Init()` 阶段注册 lambda 回调，由算法线程 (Thread 15) 直接调用 `node()->Publish()`，**绕过 church Proc() 调度** | ①\~⑧ 全部 |
| **Proc() 输出** | 无。Proc() 只做输入处理，不输出任何消息 | 无 |

### 3.1 输出 Topic ①：`/sensors/gnss/raw_short_raw_imu`

| 属性 | 值 |
|-|-|
| **Protobuf 类型** | `deeproute.drivers.gnss.ShortRawImu` |
| **频率** | \~200Hz（与 IMU 硬件采样率一致） |
| **触发位置** | `InsOnlineManager::ReceiveAndProcess()` → `ParseImu()` → `raw_imu_callback_()` |
| **回调代码** | `sensor_ins_online_component.cc:252-256` |
| **数据内容** | 原始 IMU 数据：三轴加速度、三轴角速度、IMU 温度、时间戳 |
| **发送机制** | Thread 15 直接 Publish（不经过 Proc） |
| **数据变换** | 仅做 C 结构体 → Protobuf 序列化封装，**不做坐标变换** |

**下游消费者：**

| 消费者组件 | 配置文件 | 用途 |
|-|-|-|
| `GpsLocalizationComponent` | `gps_localization.jsonnet` | GNSS/INS 融合定位 |
| `InsOnlineComponent` | `ins_online.jsonnet` | INS 在线处理（另一套定位栈） |
| `SensorInsOfflineComponent` | `sensor_ins_offline.jsonnet` | 离线回放 |
| `AdasOnlineCalibratorComponent` | `adas_online_calibrator.jsonnet` | ADAS 在线标定 |
| `AdasCalibMonitorComponent` | `adas_calib_monitor.jsonnet` | ADAS 标定监控 |
| `AdasInsCalibratorComponent` | `adas_ins_calibrator.jsonnet` | INS 标定 |

### 3.2 输出 Topic ②③④：GNSS 位置（三个坐标系）

这三个 topic 由同一个回调 `pub_raw_pose_cb` 在一次调用中同时发布。

**② `/sensors/gnss/wgs84_gnss_position`**

| 属性 | 值 |
|-|-|
| **Protobuf 类型** | `deeproute.drivers.gnss.GnssPosition` |
| **频率** | \~1-10Hz（与 GNSS 更新率一致） |
| **坐标系** | WGS84（全球标准坐标系） |
| **数据变换** | 设 `height=0.0`, `std_height=99.0`, `reference_coordinate_system=WGS84` |

**③ `/sensors/gnss/gcj02_gnss_position`**

| 属性 | 值 |
|-|-|
| **Protobuf 类型** | `deeproute.drivers.gnss.GnssPosition` |
| **坐标系** | GCJ-02（中国火星坐标系） |
| **数据变换** | WGS84 → GCJ-02，优先使用 `liball.dlib` 的 `WgtoChinaLb` 函数（国家保密算法），失败时降级为 `WGS84ToGCJ02` 近似变换 |

**④ `/sensors/gnss/raw_gnss_position`**

| 属性 | 值 |
|-|-|
| **Protobuf 类型** | `deeproute.drivers.gnss.GnssPosition` |
| **坐标系** | GCJ-02（与 ③ 共享同一条消息） |
| **注意** | 虽然名字带 "raw"，实际发送的是 GCJ-02 坐标转换后的消息 |

**下游消费者（按 topic 分组）：**

| Topic | 主要消费者 |
|-|-|
| `/sensors/gnss/wgs84_gnss_position` | `GpsLocalization`, `AdasOnlineCalibrator`, `AdasCalibMonitor`, `AdasInsCalibrator`, `SensorInsOffline` |
| `/sensors/gnss/gcj02_gnss_position` | `SafetyComponent` (各车型) |
| `/sensors/gnss/raw_gnss_position` | `BlcComponent`, `OnboardMaps`, `MapEngine`, `SdRouting`, `AdasCalibMonitor`, `InsOnline` |

### 3.3 输出 Topic ⑤：`/sensors/gnss/raw_gnss_velocity`

| 属性 | 值 |
|-|-|
| **Protobuf 类型** | `deeproute.drivers.gnss.GnssVelocity` |
| **频率** | \~1-10Hz |
| **数据内容** | GNSS 速度：东向速度、北向速度、天向速度、速度精度 |
| **数据变换** | 仅 Protobuf 封装，不做变换 |

**下游消费者：**`GpsLocalization`, `InsOnline`, `SensorInsOffline`, `AdasOnlineCalibrator`, `AdasCalibMonitor`, `AdasInsCalibrator`

### 3.4 输出 Topic ⑥⑦：INS PVA（条件编译）

**⑥ `/sensors/gnss/raw_ins_pva_x`**

| 属性 | 值 |
|-|-|
| **Protobuf 类型** | `deeproute.drivers.gnss.InsPvaX` |
| **条件** | 仅 `#if defined(DR_VEHICLE_SMART)` 时编译（Smart 车型专用） |
| **坐标系** | WGS84 |
| **数据内容** | INS PVA：位置 + 速度 + 姿态（惯性导航解算结果） |

**⑦ `/sensors/gnss/gcj02_ins_pva_x`**

| 属性 | 值 |
|-|-|
| **Protobuf 类型** | `deeproute.drivers.gnss.InsPvaX` |
| **条件** | 同上，Smart 车型专用 |
| **坐标系** | GCJ-02（同样使用 `WgtoChinaLb` 变换） |

**下游消费者：**

- `/sensors/gnss/raw_ins_pva_x`：`SensorInsOffline`
- `/sensors/gnss/gcj02_ins_pva_x`：`DtaComponent`（HY11 车型）

### 3.5 输出 Topic ⑧：`/sensors/gnss/raw_gga`

| 属性 | 值 |
|-|-|
| **Protobuf 类型** | `deeproute.drivers.gnss.RawGga` |
| **频率** | \~1Hz |
| **数据内容** | NMEA GGA 语句：定位质量、使用卫星数、HDOP、差分校正龄期 |
| **数据变换** | 仅 Protobuf 封装 |

**下游消费者：** 仅录制系统（record 配置）订阅，无其他组件消费。

### 3.6 输出 Topic ⑨：`/localization/pose` ★ 最核心输出

| 属性 | 值 |
|-|-|
| **Protobuf 类型** | `deeproute.drivers.gnss.Ins` |
| **频率** | \~20Hz（每收到 IMU 数据后经过 MSF 融合输出） |
| **触发位置** | `ReceiveAndProcess()` → `GetPose()` → `GetExtrapolatedVehicleState()` → `odometry_output_callback_()` |
| **回调代码** | `sensor_ins_online_component.cc:267-271` |
| **数据内容** | 融合定位结果：高精度位置（经纬高）、速度（东北天）、姿态（航向/俯仰/横滚）、协方差、定位状态 |
| **发送机制** | Thread 15 直接 Publish（不经过 Proc） |
| **数据来源** | MSF 29 维 EKF 融合后的最优估计 + Extrapolator 位姿外推 |

**下游消费者（最广泛订阅的 topic）：**

| 消费者模块 | 用途 |
|-|-|
| `PerceptionComponent` | 感知模块：目标检测需要自车位姿 |
| `PlanningComponent` | 规划模块：路径规划需要当前位姿 |
| `ControlComponent` / `CbwControlComponent` | 控制模块：执行控制需要位姿反馈 |
| `SafetyComponent` | 安全监控 |
| `AebComponent` | 自动紧急制动 |
| `LocalizationMatchingComponent` | Lidar 匹配定位（用 INS 位姿作为初始猜测） |
| `MapEngineComponent` | 地图引擎 |
| `OnboardMapsComponent` | 在线地图 |
| `DtaComponent` | 数据传输代理 |
| `BlcComponent` | 行为级日志记录 |
| `DrvlaComponent` | 驾驶员辅助 |
| `AdasOnlineCalibratorComponent` | ADAS 在线标定 |
| `AdasCalibMonitorComponent` | 标定监控 |
| `SdRoutingComponent` | SD 路由 |
| `GradingOnboardComponent` | 在线评分 |

**注意：**`LocalizationComponent`（localization.jsonnet）也发布 `/localization/pose`。在某些部署配置中，两个组件可能共存，此时 church 框架会合并同名 topic 的消息。

### 3.7 输出 Topic ⑩：`/localization/keyframe_update_status`

| 属性 | 值 |
|-|-|
| **Protobuf 类型** | `deeproute.localization.message.KeyframeUpdateStatus` |
| **频率** | 按需（关键帧更新时触发） |
| **数据内容** | 关键帧更新状态（时间戳、参考时间） |

**下游消费者：**`LocalizationMatchingComponent`（用于同步点云匹配）

### 3.8 输出 Topic ⑪：`/localization/debug/internal_state`

| 属性 | 值 |
|-|-|
| **Protobuf 类型** | `deeproute.proto_ads.InternalMultiSensorFusionState` |
| **频率** | 约每 N 帧输出一次（由 `internal_state_count_` 控制） |
| **数据内容** | MSF 内部状态：29 维状态向量、协方差矩阵、各传感器量测状态、对准状态 |

**下游消费者：**`SensorInsOfflineComponent`（离线回放和调试用）

---

## 四、关键数据类型 Protobuf 对照表

| C 结构体 (localization-mcu) | Protobuf 类型 | C++ 类型别名 | 说明 |
|-|-|-|-|
| `raw_imu_t` | `deeproute.drivers.gnss.ShortRawImu` | `RAW_IMU_MSG` | IMU 原始数据 |
| `gnss_position_t` | `deeproute.drivers.gnss.GnssPosition` | `RAW_POSE_MSG` | GNSS 位置 |
| `gnss_velocity_t` | `deeproute.drivers.gnss.GnssVelocity` | `RAW_VEL_MSG` | GNSS 速度 |
| `ins_pva_t` | `deeproute.drivers.gnss.InsPvaX` | `RAW_INS_MSG` | INS PVA |
| `raw_gga_t` | `deeproute.drivers.gnss.RawGga` | `RAW_GGA_MSG` | NMEA GGA |
| — | `deeproute.canbus.WheelSpeed` | `WHEEL_SPEED` | 轮速（从 church 输入） |
| — | `deeproute.localization.message.LidarMatchingMessage` | `LIDAR_MATCHING` | Lidar 匹配（从 church 输入） |
| — | `deeproute.drivers.gnss.Ins` | `ODOMETRY_OUTPUT` | MSF 融合输出位姿 |
| — | `deeproute.localization.message.KeyframeUpdateStatus` | `KEY_FRAME_UPDATE` | 关键帧更新 |
| — | `deeproute.proto_ads.InternalMultiSensorFusionState` | `INTERNAL_MSF_STATE` | MSF 内部状态 |
| — | `deeproute.drivers.gnss.RawData` | `RAW_DATA` | SomeIP 原始数据 |

---

## 五、回调机制完整解析

### 5.1 为什么用回调而不用 Proc() 发布？

| 方面 | 走 Proc() 路径 | 走 Init() 回调路径 |
|-|-|-|
| **发布频率** | 受限于 trigger channel（\~50Hz max） | 由算法线程自主控制（跟随 IMU \~200Hz） |
| **延迟** | `iceoryx_dispatch` → task queue → Assemble → Proc → 输出（多次线程切换） | 算法线程直接 `node()->Publish()`（零额外延迟） |
| **控制权** | church 框架控制节拍 | 算法自己控制节拍 |
| **适用场景** | 低频、对延迟不敏感的数据 | 高频、实时性要求极高的数据 |

### 5.2 Init() 阶段做了什么（完整展开）

```
SensorInsOnlineComponent::Init()  [driver 层, church task 线程调用, 仅执行一次]
  │
  │ 步骤 1: 定义 8 个 lambda 回调（捕获 this, 借用 node()->Publish() 能力）
  │   pub_raw_pose_cb     → WGS84 + GCJ02 坐标变换 → Publish ②③④
  │   pub_raw_ins_cb      → WGS84 + GCJ02 变换 → Publish ⑥⑦ (Smart 车型)
  │   pub_raw_imu_cb      → 直接封装 → Publish ①
  │   pub_raw_vel_cb      → 直接封装 → Publish ⑤
  │   pub_raw_gga_cb      → 直接封装 → Publish ⑧
  │   pub_odom_out_cb     → 直接封装 → Publish ⑨ /localization/pose
  │   pub_key_frame_cb    → 直接封装 → Publish ⑩
  │   pub_internal_state_cb → 直接封装 → Publish ⑪
  │
  │ 步骤 2: InitGnss — 初始化传感器数据通路
  ├── impl_->InitGnss(pub_raw_pose_cb, pub_raw_imu_cb, pub_raw_vel_cb,
  │                    pub_raw_ins_cb, pub_raw_gga_cb)
  │   │
  │   └── SensorInsOnlineComponentImpl::InitGnss()
  │         │ 创建 InsOnlineManager(config)
  │         │
  │         │ 注册 5 个解码输出回调:
  │         │   RegMsgCallback(raw_pose_callback_)    → ②③④
  │         │   RegMsgCallback(raw_imu_callback_)     → ①
  │         │   RegMsgCallback(raw_vel_callback_)     → ⑤
  │         │   RegMsgCallback(raw_ins_callback_)     → ⑥⑦
  │         │   RegMsgCallback(raw_gga_callback_)     → ⑧
  │         │
  │         │ 创建 SensorStream（数据流管理器）
  │         │ data_stream_ptr_->Init(lambda):
  │         │   lambda = [this](vector<uint8_t>& data) {
  │         │       ins_recv_queue_.push(data);   // 推入 SPSC 队列(64)
  │         │       queue_cv_.notify_one();       // 唤醒 SnrInsOnlnProc
  │         │   }
  │         │
  │         └── SensorStream::Init(lambda)
  │               └── InsComponentImpl::Init(lambda)  [sensors 仓库]
  │                     │ 再包装: sensors_ins_packet → vector<uint8_t> → lambda
  │                     └── InsManager::Init(adapted_func) [车型特定]
  │                           │ InsHelper::Init(adapted_func)  → 存为 publish_callback_
  │                           │ RegisterDecoder<ImuDecoder>("imu", decoder)
  │                           │   → 返回 imu_callback（给 dSomeIP 用）
  │                           │ RegisterDecoder<GnssDecoder>("gnss", decoder)
  │                           │   → 返回 gnss_callback
  │                           └── 绑定到 dSomeIP 事件
  │
  │ 步骤 3: InitMsfOdometry — 初始化 MSF 融合算法
  ├── impl_->InitMsfOdometry(pub_odom_out_cb, pub_key_frame_cb,
  │                           pub_internal_state_cb)
  │   │
  │   └── SensorInsOnlineComponentImpl::InitMsfOdometry()
  │         │ 注册 3 个融合输出回调:
  │         │   RegMsgCallback(odometry_output_callback_)    → ⑨
  │         │   RegMsgCallback(key_frame_callback_)          → ⑩
  │         │   RegMsgCallback(internal_msf_state_callback_) → ⑪
  │         │
  │         │ InsOnlineManager::InitMsfOdometry(cfg_filter, cfg_navi, ...)
  │         │   → 加载滤波器配置 (cfg 文件)
  │         │   → 创建 MultiSensorsFusionOdometry 对象 (29 维 Kalman)
  │         │   → 初始化静止检测器
  │         └── → 加载历史内部状态（如果有，用于热启动）
  │
  │ 步骤 4: StartGnss — 启动数据接收
  └── impl_->StartGnss()
        │ InsOnlineManager::StartGnss()
        │   → data_stream_ptr_->Start()
        │     → InsComponentImpl::Start() [sensors 仓库]
        │       → InsHelper::Start() → 创建 SnrInsAsembProc 线程 ⑫
        │
        │   → 创建 SnrInsOnlnProc 线程 ⑬（核心处理线程，Thread 15）
        └──   run_flag_ = true; ReceiveAndProcess() 开始循环
```

### 5.3 四层回调链（从硬件到 Publish 的完整链路）

```
┌─── 第 4 层: 通信 SDK → InsHelper ──────────────────────────────────────────┐
│ 触发时机: dSomeIP 接收到数据包 / lpcom WrappedSubscriberChannel 收到消息    │
│ 执行线程: dSomeIP SDK 线程 ⑭ / lpcom 回调线程                              │
│ 回调内容:                                                                   │
│   dSomeIP 路径: InsHelper::RegisterDecoder 返回的 lambda                   │
│   lpcom 路径:   InsManager::HandleIMUMessage → memcpy → imu_callback_     │
│                 (imu_callback_ = InsHelper::RegisterDecoder 返回的 lambda) │
│   → decoder_info->queue->push(data)      [SPSC 队列 #1, 容量 64]          │
│   → cv_.notify_one()                     [唤醒 SnrInsAsembProc]            │
│ 注: 两条路径在 InsHelper 层统一，上层完全无感                                │
└────────────────────────────────────────────────────────────────┬────────────┘
                                                                 ▼
┌─── 第 3 层: InsHelper → InsComponentImpl → InsOnlineManager ───────────────┐
│ 触发时机: SnrInsAsembProc ⑫ 从队列 pop 出数据并解码后                       │
│ 执行线程: SnrInsAsembProc ⑫                                                │
│ 回调内容: InsHelper.publish_callback_(sensors_ins_packet)                   │
│   → InsComponentImpl 的适配 lambda:                                        │
│     sensors_ins_packet → memcpy → std::vector<uint8_t> [数据格式转换]       │
│   → InsOnlineManager 注册的 lambda:                                        │
│     ins_recv_queue_.push(vector<uint8_t>)  [SPSC 队列 #2, 容量 64]         │
│     queue_cv_.notify_one()                 [唤醒 SnrInsOnlnProc]           │
└────────────────────────────────────────────────────────────────┬────────────┘
                                                                 ▼
┌─── 第 2 层: InsOnlineManager 内部处理 ─────────────────────────────────────┐
│ 触发时机: SnrInsOnlnProc ⑬ 从 ins_recv_queue_ pop 出数据后                │
│ 执行线程: SnrInsOnlnProc ⑬ (Thread 15)                                    │
│ 处理内容:                                                                   │
│   UnpackSensorsIns → ParseImu/ParseGnss/... → SaveRawImuMsg → MSF 融合    │
│ 回调调用:                                                                   │
│   raw_imu_callback_(proto_msg)           [解码后立即调用]                    │
│   raw_pose_callback_(proto_msg)          [有 GNSS 数据时调用]               │
│   odometry_output_callback_(pose_msg)    [MSF 融合完成后调用, 经降频]       │
│   key_frame_callback_(kf_msg)            [关键帧更新时调用]                  │
│   internal_msf_state_callback_(state)    [每 N 帧调用]                      │
└────────────────────────────────────────────────────────────────┬────────────┘
                                                                 ▼
┌─── 第 1 层: driver 层 lambda → church Publish ─────────────────────────────┐
│ 触发时机: 上一层的回调被调用时                                               │
│ 执行线程: SnrInsOnlnProc ⑬ (Thread 15) — 注意，虽然 lambda 定义在 driver   │
│           层，但实际执行在算法线程中                                          │
│ 回调内容:                                                                   │
│   protobuf_user_api::CreateSharedMessage<T>(msg)   [创建 shared_ptr]       │
│   node()->Publish("/topic/name", msg_ptr)           [进入 iceoryx 传输]     │
│                                                                             │
│ 特殊处理:                                                                   │
│   pub_raw_pose_cb: 做 WGS84→GCJ02 坐标变换（调用 liball.dlib），一次回调    │
│                    发布 3 个 topic (wgs84 + gcj02 + raw)                    │
│   pub_raw_ins_cb:  条件编译 (#if DR_VEHICLE_SMART)，做 WGS84→GCJ02         │
│   其他 callback:   仅做 Protobuf 封装，不做数据变换                          │
└────────────────────────────────────────────────────────────────────────────┘
```

**线程切换总结：** 从 ADPU 硬件数据到达到 `/localization/pose` 发布，共经过：

- **3 次线程切换**：通信 SDK 线程 ⑭ (dSomeIP/lpcom) → SnrInsAsembProc ⑫ → SnrInsOnlnProc ⑬
- **2 个 SPSC 队列中转**：InsHelper 内部队列 → ins_recv_queue\_
- **1 次 MSF 融合计算**：29x29 Kalman 滤波 + 位姿外推

### 5.4 稳态运行时的时序图

```
时间轴 (ms)   通信SDK(dSomeIP  SnrInsAsembProc ⑫  SnrInsOnlnProc ⑬  t_SensorInsOnline ④
              或lpcom) ⑭
────────────  ──────────────  ──────────────────  ─────────────────  ────────────────────
t=0.000       IMU #1 到达
              → push queue#1
              → notify ⑫

t=0.050                       被唤醒
                              → pop(AdpuImu)
                              → ImuDecoder::Decode
                              → publish_callback_
                              → push queue#2
                              → notify ⑬

t=0.100                                           被唤醒
                                                  → pop(vector<uint8_t>)
                                                  → UnpackSensorsIns
                                                  → ParseImu → raw_imu_cb
                                                    → Publish ① (200Hz)
                                                  → SaveRawImuMsg
                                                  → HandleMeasurement
                                                    → Kalman 滤波 [~0.5ms]
                                                  → GetPose (降频，非每帧)

t=0.600                                           处理完毕，回到 wait

t=5.000       IMU #2 到达     ...同上流程...        ...同上流程...

t=10.000      IMU #3 + GNSS
              到达             解码 IMU + GNSS      → ParseImu → Publish ①
                                                   → ParseGnssPosition
                                                     → raw_pose_cb
                                                     → Publish ②③④ (1-10Hz)
                                                     → WgtoChinaLb 变换
                                                   → SaveImu + SaveGnss
                                                   → HandleMeasurement
                                                     → Kalman (IMU+GNSS)
                                                   → GetPose
                                                   → Publish ⑨ (20Hz)

t=12.000                                                                    wheel_speed 到达
                                                                            → iceoryx_dispatch
                                                                            → Dispatch(PROC)
                                                                            → Proc():
                                                                              AddWheel()
                                                                              → SaveWheelSpeedMsg
                                                                              → 数据进入 map
                                                                            (下次 HandleMeasurement
                                                                             时一并处理)
```

---

## 六、坐标变换逻辑

### 6.1 GNSS 位置坐标变换链

```
原始 GNSS Position (WGS84)
  │
  ├──→ /sensors/gnss/wgs84_gnss_position
  │    (直接发送，height=0, std_height=99)
  │
  ├──→ WgtoChinaLb(liball.dlib)  ← 国家保密偏转算法
  │    │
  │    ├─ 成功 → GCJ-02 坐标
  │    ├─ 首次调用 (SKIP_INIT) → position_type=NONE
  │    └─ 失败 → 降级: WGS84ToGCJ02 近似变换
  │              │
  │              └─ 坐标接近零 → 直接设为 0, position_type=NONE
  │
  └──→ /sensors/gnss/gcj02_gnss_position (GCJ-02)
       /sensors/gnss/raw_gnss_position   (同一条 GCJ-02 消息)
```

### 6.2 liball.dlib 加载机制

| 属性 | 值 |
|-|-|
| 库路径 | `${DEEPROUTE_PATH}/localization/lib/deflection/liball.dlib` |
| 加载方式 | `dlopen()` + `dlsym("WgtoChinaLb")`，`static` 变量确保只加载一次 |
| 失败影响 | 每 100 次打印 "open dl error!!!"，降级为 `WGS84ToGCJ02` 近似变换 |
| wg_flag | 首次调用设为 0（初始化），后续调用设为 1 |

---

## 七、`/sensors/gnss/pose` 的完整链路

`/sensors/gnss/pose`**不是** sensor_ins_online 直接发布的，而是由下游的 `GpsLocalizationComponent` 消费 sensor_ins_online 的输出后发布：

```
sensor_ins_online 发布:
  /sensors/gnss/wgs84_gnss_position ─────┐
  /sensors/gnss/raw_short_raw_imu ───────┤
  /sensors/gnss/raw_gnss_velocity ───────┤
                                         ▼
                              ┌──────────────────────┐
                              │ GpsLocalizationComponent │
                              │ (gps_localization.jsonnet)│
                              │                          │
                              │ 输入:                     │
                              │  /sensors/gnss/wgs84_    │
                              │    gnss_position          │
                              │  /sensors/gnss/raw_short_ │
                              │    raw_imu                │
                              │  /sensors/gnss/raw_gnss_  │
                              │    velocity               │
                              │  /canbus/wheel_speed      │
                              │                          │
                              │ 输出:                     │
                              │  /sensors/gnss/pose       │
                              │  (deeproute.drivers.gnss  │
                              │   .SensorsIns)            │
                              └────────────┬─────────────┘
                                           │
                                           ▼
                              被大量模块消费:
                              Perception, Planning, Safety,
                              Localization, MapEngine, AEB,
                              OnboardMaps, DTA, BLC, ...
```

---

## 八、Online vs Offline 数据流差异

| 差异点 | Online 模式 | Offline 模式 |
|-|-|-|
| 硬件数据接入 | `SensorStream` → `InsComponentImpl` (dSomeIP) | 不接入硬件（`INS_OFFLINE_MODE` 宏） |
| sensors 层依赖 | 链接 `@sensors//sensors/component:ins_component_impl_internal` | 不链接 sensors |
| IMU/GNSS 数据来源 | 硬件实时数据 | 通过 `AddImu()`, `AddGnssPosition()` 等接口外部注入 |
| 轮速/Lidar 来源 | church Proc() 接收 | 同 online 或通过 benchmark runner 注入 |
| 编译目标 | `//node:sensor_ins_online` + `stream:stream` | `//node:sensor_ins_offline` + `stream:stream_offline` |
| driver 组件 | `sensor_ins_online_component.cc` | `sensor_ins_offline_component.cc` |
| 部署产物 | `libsensor_ins_online_component.so` | `libsensor_ins_offline_component.so` |
| 使用场景 | 车载实时运行 | 数据回放、算法验证、benchmark |

---

## 九、数据传输格式总结

| 层级 | 数据格式 | 说明 |
|-|-|-|
| **硬件 → sensors** | dSomeIP 二进制帧 / lpcom IpcMessage | 车型特定编码（Smart/GWM/Geely: dSomeIP; LP: lpcom） |
| **sensors 内部** | `std::vector<uint8_t>` | 解码后的原始字节流 |
| **sensors → localization-mcu** | `std::vector<uint8_t>` | 通过 SPSC 队列传递 |
| **localization-mcu 内部** | C 结构体 (`raw_imu_t`, `gnss_position_t`, ...) | `UnpackSensorsIns` 解析 |
| **MSF 算法内部** | C 结构体 + `ProtocolSet` + 29 维浮点数组 | 纯 C 数据结构 |
| **localization-mcu → driver** | Protobuf 消息（通过回调） | `proto_msg_adapter` 做 C↔Protobuf 转换 |
| **driver → church** | Protobuf `shared_ptr` | `protobuf_user_api::CreateSharedMessage` + `node()->Publish()` |
| **church → 下游** | Protobuf `shared_ptr` | church 零拷贝传输（进程内） |
