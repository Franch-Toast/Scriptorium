---
title: "sensor_uss 模块详细说明书"
date: 2026-09-20
description: "sensor_uss 是 Deeproute 自动驾驶系统中的超声波传感器数据处理模块。负责接收来自 USS（Ultrasonic Sensor System）"
categories:
  - 撰修司
tags:
  - sensor_uss
---

# sensor_uss 模块详细说明书

## 一、模块概述

`sensor_uss` 是 Deeproute 自动驾驶系统中的**超声波传感器数据处理模块**。负责接收来自 USS（Ultrasonic Sensor System）硬件的探测数据和感知障碍物数据，经过解码和组装后，以统一的 Protobuf 格式发布给下游模块（如泊车辅助 APA、倒车雷达 PDC 等）。

**与 sensor_ins_online 的关键区别**：

- sensor_ins_online 有独立的算法仓库 `localization-mcu`，sensor_uss **没有**独立算法仓库
- sensor_ins_online 内部有 MSF Kalman 滤波器等复杂算法，sensor_uss 主要做**数据解码和格式转换**
- sensor_ins_online 使用纯 C 算法（MCU_MLOG），sensor_uss 全部使用 C++ （MLOG）

---

## 二、仓库清单与 Bazel 名称

| 仓库 | Bazel 外部名 | 用途 |
|-|-|-|
| `driver` | `@driver` | church 组件壳（`UltrasonicComponent`）、配置、二进制入口 |
| `sensors` | `@sensors` | 核心实现：manager、decoder、helper、lpcom/dSomeIP 对接 |
| `platform` | `@platform` | church 框架 |
| `common` | `@common` | 基础库（日志、时间、坐标变换等） |
| `proto_msg` | `@proto_msg` | Protobuf 消息定义 |
| `dsomeip-sdk` | `@dsomeip-sdk` | dSomeIP 客户端（GWM/Geely 车型） |
| `lpsdk` | `@lpsdk` | lpcom 通信 SDK（LP 零跑车型） |

**注意**：不像 `sensor_ins_online` 有 `localization-mcu` 和 `mcu_common`，USS 的所有逻辑都在 `sensors` 仓库内完成。

---

## 三、跨仓库依赖图

```
┌──────────────────────────────────────────────────────────────────┐
│                         sensor_uss 二进制                         │
│              driver/integration/components/BUILD                  │
│              name = "sensor_uss"                                  │
└─────────────┬──────────────────────────────────┬─────────────────┘
              │                                  │
              ▼                                  ▼
┌─────────────────────────┐       ┌──────────────────────────────┐
│  @driver//integration:  │       │  @sensors//sensors/component:│
│  mainboard_library      │       │  ultrasonic_component_impl_  │
│  (church 启动框架)       │       │  internal                    │
└─────────────────────────┘       └──────────────┬───────────────┘
                                                  │
                                                  ▼
                                  ┌──────────────────────────────┐
                                  │  @sensors//sensors/projects: │
                                  │  register_ultrasonic         │
                                  │  (按 BUILD_PROJECT 选择)     │
                                  └──────────────┬───────────────┘
                                                  │
              ┌───────────────────┬───────────────┼───────────────┐
              ▼                   ▼               ▼               ▼
     ┌──────────────┐   ┌──────────────┐  ┌─────────────┐  ┌──────────┐
     │ smart_hy11/  │   │ gwm_tank/    │  │ lp8650_v1/  │  │ gl_yinhe/│
     │ ultrasonic/  │   │ ultrasonic/  │  │ ultrasonic/ │  │ ultra... │
     │ UltrManager  │   │ UltrManager  │  │ UltrManager │  │          │
     └──────┬───────┘   └──────┬───────┘  └──────┬──────┘  └──────────┘
            │                  │                  │
            ▼                  ▼                  ▼
  ┌───────────────┐  ┌───────────────┐  ┌───────────────────┐
  │ ultrasonic_   │  │ ultrasonic_   │  │ ultrasonic_       │
  │ common_hy11   │  │ common_gwm_  │  │ common_lp_25u1   │
  │ (dSomeIP)     │  │ 25u1(dSomeIP)│  │ (@lpsdk//:lpcom) │
  └───────┬───────┘  └───────┬───────┘  └─────────┬────────┘
          │                  │                     │
          ▼                  ▼                     ▼
   @dsomeip-sdk       @dsomeip-sdk         @lpsdk//:lpcom
```

---

## 四、项目文件结构

### 4.1 driver 层

| 文件 | 作用 |
|-|-|
| `driver/integration/components/ultrasonic_component.cc/h` | church 组件壳（默认车型） |
| `driver/integration/components/hy11-et/ultrasonic_component.cc/h` | HY11-ET 特化版 |
| `driver/config/component/sensor_uss.jsonnet` | church 组件配置 |
| `driver/config/dem/lp8650-v1-share/sensor_uss.jsonnet` | DEM 运行配置（LP 车型） |

### 4.2 sensors 层

| 文件/目录 | 作用 |
|-|-|
| `sensors/component/ultrasonic/ultrasonic_component_impl.cc/h` | 工厂模式创建车型 Manager |
| `sensors/common/ultrasonic/ultrasonic_manager_base.h` | Manager 基类 + 工厂 |
| `sensors/common/ultrasonic/ultrasonic_helper.hpp` | 通用 Helper：SPSC 队列、解码线程、组装发布 |
| `sensors/common/ultrasonic/ultrasonic_decoder_base.h` | Decoder 基类模板 |
| `sensors/common/ultrasonic/ultrasonic_config_singleton.h` | 配置单例 |
| `sensors/common/ultrasonic/decoder/lp_25u1/` | LP 车型 Decoder |
| `sensors/common/ultrasonic/decoder/gwm_25u1/` | GWM 车型 Decoder |
| `sensors/common/ultrasonic/decoder/geely_25u1/` | Geely/吉利 车型 Decoder |
| `sensors/projects/lp8650_v1/ultrasonic/` | LP8650 UltrasonicManager |
| `sensors/projects/smart_hy11/ultrasonic/` | Smart HY11 UltrasonicManager |
| `sensors/projects/gwm_tank/ultrasonic/` | GWM Tank UltrasonicManager |

### 4.3 proto 定义

| 文件 | 作用 |
|-|-|
| `proto_msg/proto/drivers/ultrasonic/ultrasonic.proto` | `Ultrasonic` 消息（探针数据 + 障碍物） |
| `proto_msg/proto/drivers/ultrasonic/config.proto` | 标定配置 |
| `proto_msg/proto/common/module_event.proto` | USS 相关事件码（6500-6999 范围） |

---

## 五、church 组件配置

```jsonnet
// driver/config/component/sensor_uss.jsonnet
{
  components: [{
    class_name: 'UltrasonicComponent',
    config: {
      name: 'Ultrasonic',
      task: {
        name: 't_Ultrasonic',
        trigger_policy: 'ANY',
        input_channels: [],        // 无输入 channel！
        output_channels: [{
          name: '/sensors/ultrasonic/combined_ultrasonic',
          msg_type: 'deeproute.drivers.ultrasonic.Ultrasonic',
          need_topic_supervision: true,
        }],
      },
    },
  }],
}
```

**关键特点**：

- **无 input_channels** — 和 `sensor_ins_online` 一样，数据不通过 church 订阅进入，而是通过 lpcom/dSomeIP 直接接收
- **Proc() 为空**（`return true`）— 业务逻辑完全在 Init() 注册的回调中执行
- **trigger_policy: 'ANY'** — 但因为没有 input channel，Proc() 几乎不会被触发
- `need_topic_supervision: true` — 开启 topic 监控

---

## 六、代码架构与层次

### 6.1 与 sensor_ins_online 的架构对比

| 层次 | sensor_ins_online | sensor_uss |
|-|-|-|
| driver 层 | `SensorInsOnlineComponent` | `UltrasonicComponent` |
| 中间层 | `SensorInsOnlineComponentImpl` | `UltrasonicComponentImpl` |
| 核心算法 | `InsOnlineManager` (localization-mcu) | **无** — 直接在 sensors 层完成 |
| sensors 管理器 | `InsManager` | `UltrasonicManager` |
| sensors 辅助器 | `InsHelper` (ins_helper.hpp) | `UltrasonicHelper` (ultrasonic_helper.hpp) |
| Decoder | `ImuDecoder` / `GnssDecoder` | `UssProbeDecoder` / `UssObstacleDecoder` |
| 通信层 | lpcom / dSomeIP | lpcom / dSomeIP（完全一致） |

**关键差异**：sensor_uss 没有 `localization-mcu` 对应的独立算法层。数据从 lpcom 进入后，在 sensors 层解码完就直接通过回调发布出去，不经过 Kalman 滤波等复杂处理。

### 6.2 数据处理链（LP 车型）

```
lpcom 回调线程
    │ HandleUSSProbeMessage() / HandleUSSObstacleMessage()
    │ memcpy → UssRawData / UssPerceptionObstacle
    │ uss_probe_callback_() / uss_obstacle_callback_()
    ▼
UltrasonicHelper (SPSC 队列 #1)
    │ push(data) → cv_.notify_one()
    ▼
SnrUssAsembProc 线程
    │ pop() → DecodePacket()
    │ set_type(vendor_type)
    │ publish_callback_(output)
    ▼
UltrasonicComponent::PublishMsg()
    │ node()->Publish("/sensors/ultrasonic/combined_ultrasonic")
    ▼
church Iceoryx 共享内存 → 下游模块
```

---

## 七、LP 车型通信配置

### 7.1 lpcom 订阅通道

| 通道 | topic | transType | 数据类型 | sizeOfMessages |
|-|-|-|-|-|
| USS Probe | `/leap/uss/detector_adas` | `SHM_ONLY` | `leap::uss_detector::UssRawData` | 175KB |
| USS Obstacle | `/leap/uss/obstacle_adas` | `SHM_ONLY` | `leap::uss_perception::UssPerceptionObstacle` | 175KB |

两个通道都使用**共享内存**传输（`SHM_ONLY`），与 INS 的 IMU 相同。

### 7.2 topic_monitor 配置

```json
// sensors/projects/lp8650_v1/ultrasonic/ultrasonic_topic_monitor.json
{
  "topic_monitor_config": [
    {
      "topic_name": "/leap/uss/detector_adas",
      "frame_timeout_threshold": 30000,
      "callback_timeout_threshold": 20000,
      "lose_timeout_threshold": 100000
    },
    {
      "topic_name": "/leap/uss/obstacle_adas",
      "frame_timeout_threshold": 60000,
      "callback_timeout_threshold": 40000,
      "lose_timeout_threshold": 200000
    }
  ]
}
```

| 参数 | detector_adas | obstacle_adas |
|-|-|-|
| 帧超时 | 30ms | 60ms |
| 回调超时 | 20ms | 40ms |
| 断流超时 | 100ms | 200ms |

### 7.3 ErrorCodeCallback 事件码

| topic | 异常类型 | 事件码 |
|-|-|-|
| detector | kFrameTimeout | `LP_USS_OBJECT_TOPIC_FRAME_TIMEOUT` |
| detector | kCallbackTimeout | `LP_USS_OBJECT_TOPIC_CALLBACK_TIMEOUT` |
| detector | kLoseTimeout | `LP_USS_OBJECT_TOPIC_LOSE_TIMEOUT` |
| detector | kFindTopicTimeout | `LP_USS_OBJECT_SRV_FIND_SERVICE_TIMEOUT` |
| detector | kTopicUnavailable | `LP_USS_OBJECT_SRV_UNAVAILABLE` |
| obstacle | kFrameTimeout | `LP_USS_OBSTACLE_TOPIC_FRAME_TIMEOUT` |
| obstacle | kCallbackTimeout | `LP_USS_OBSTACLE_TOPIC_CALLBACK_TIMEOUT` |
| obstacle | kLoseTimeout | `LP_USS_OBSTACLE_TOPIC_LOSE_TIMEOUT` |
| obstacle | kFindTopicTimeout | `LP_USS_OBSTACLE_SRV_FIND_SERVICE_TIMEOUT` |
| obstacle | kTopicUnavailable | `LP_USS_OBSTACLE_SRV_UNAVAILABLE` |

**注意**：代码中 `ReportEvent` 的 module 参数误用了 `dr::common::SENSOR_INS`，应为 `SENSOR_USS`，疑似复制粘贴错误。

---

## 八、SPSC 队列

### 8.1 队列定义

位于 `sensors/sensors/common/ultrasonic/ultrasonic_helper.hpp`：

```cpp
constexpr int kQueueCapacity = 64;
using SafeQueueType =
    boost::lockfree::spsc_queue<std::any,
                                boost::lockfree::capacity<kQueueCapacity>,
                                boost::lockfree::fixed_sized<true>>;
```

### 8.2 队列实例

| 队列 | 生产者 | 消费者 | 内容 | 容量 |
|-|-|-|-|-|
| USS_PROBE queue | lpcom `thread_pool` → `uss_probe_callback_` | `SnrUssAsembProc` | `std::any(UssRawData)` | 64 |
| USS_OBSTACLE queue | lpcom `thread_pool` → `uss_obstacle_callback_` | `SnrUssAsembProc` | `std::any(UssPerceptionObstacle)` | 64 |

**与 sensor_ins_online 的区别**：sensor_ins_online 有两级 SPSC 队列（InsHelper → InsOnlineManager），sensor_uss 只有**一级**（UltrasonicHelper 内部），因为不需要经过独立的算法处理层。

---

## 九、Decoder 设计

### 9.1 LP 车型 Decoder

| Decoder | 输入类型 | 输出类型 |
|-|-|-|
| `UssProbeDecoder` | `leap::uss_detector::UssRawData` | `deeproute::drivers::ultrasonic::Ultrasonic` |
| `UssObstacleDecoder` | `leap::uss_perception::UssPerceptionObstacle` | `deeproute::drivers::ultrasonic::Ultrasonic` |

`UssProbeDecoder` 解码 12 个超声波探头的原始距离数据；`UssObstacleDecoder` 解码 USS 感知层输出的障碍物信息。

### 9.2 ObstacleDataStore 单例

`UssObstacleDecoder` 使用 `ObstacleDataStore` 单例来缓存最新的障碍物数据，通过 `MergeInto()` 方法将障碍物数据合并到 Probe 输出中。这允许探头数据和障碍物数据异步到达但合并发布。

---

## 十、支持的车型

| 车型 | BUILD_PROJECT | 通信方式 |
|-|-|-|
| Smart HY11 | `BUILD_SMART_HY11` | dSomeIP（Bosch USS） |
| Smart HY11P | `BUILD_SMART_HY11P` | dSomeIP |
| GWM Tank | `BUILD_GWM_TANK` | dSomeIP（GWM USS CAN 帧解码） |
| GWM Thoru | `BUILD_GWM_THORU` | dSomeIP |
| GWM Oriny | `BUILD_GWM_ORINY` | dSomeIP |
| Geely 银河 | `BUILD_GL_YINHE` | dSomeIP（Geely EB USS） |
| LP8650 | `BUILD_LP8650_V1` | lpcom (`SHM_ONLY`) |
| LP8797 | `BUILD_LP8797_V1` | lpcom (`SHM_ONLY`) |

---

## 十一、外部依赖库

| 库 | Bazel 名 | 用途 |
|-|-|-|
| `dsomeip-sdk` | `@dsomeip-sdk` | dSomeIP 通信（GWM/Geely/Smart） |
| `lpsdk` | `@lpsdk` | lpcom 通信（LP 零跑） |
| `proto_msg` | `@proto_msg` | Protobuf 消息定义 |
| `church` | `@platform//church` | 组件框架 |
| `common` | `@common` | 基础工具库 |
| `transform` | `@common//transform` | 坐标变换（USS 障碍物坐标转换） |

---

## 十二、术语表

| 术语 | 全称 | 说明 |
|-|-|-|
| USS | Ultrasonic Sensor System | 超声波传感器系统 |
| PDC | Park Distance Control | 泊车距离控制 |
| APA | Auto Parking Assist | 自动泊车辅助 |
| Probe | — | USS 探头原始测距数据 |
| Obstacle | — | USS 感知层输出的障碍物（位置、大小） |
| UssRawData | — | LP 车型 USS 探头原始数据结构 |
| UssPerceptionObstacle | — | LP 车型 USS 感知障碍物结构 |
| SHM_ONLY | Shared Memory Only | lpcom 共享内存传输模式 |

---

## 附录 Z：关联文档索引

| 文档 | 路径 | 内容 |
|-|-|-|
| 数据流向详解 | `data_flow.md` | 输入输出数据的完整链路、回调机制、数据格式 |
| 线程清单 | `thread_list.md` | 进程内所有线程的作用和交互 |
| 异常检测机制 | `anomaly_detection.md` | 帧超时/断流超时/topic 监控 |
