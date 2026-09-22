---
title: "sensor_radar 模块总览"
date: 2026-09-20
description: "参考平台：LP8650-V1-SHARE（零跑 SA8650）"
categories:
  - 撰修司
tags:
  - sensor_radar
---

# sensor_radar 模块总览

> 生成日期：2026-04-02  
> 基准代码库：/sandbox 工作区  
> 参考平台：LP8650-V1-SHARE（零跑 SA8650）

---

## 1. 模块定位

`sensor_radar` 是 Deeproute 自动驾驶系统中的**毫米波雷达数据处理模块**。它从车辆上安装的多颗毫米波雷达（MRR/SRR）接收原始目标检测数据，经过解码、坐标转换、时间戳校验后，将融合后的雷达障碍物列表和点云数据发布到 church 总线，供感知（perception）、安全（safety/AEB）等下游模块消费。

**核心特点**：

- 支持 **8+ 种车型项目**（LP/GWM/Geely/HY11），通过工厂模式在编译期选择对应的 `RadarManager`
- LP 平台使用 **lpcom (Leap::Com)** 共享内存通信；GWM/Geely 平台使用 **dSomeIP / CAN**
- 支持两条独立的发布通道：**雷达目标列表**（`Radar` proto）和 **4D 雷达点云**（`PointCloud2` proto）
- 多雷达数据**同步等待 + 合并发布**机制

---

## 2. 仓库依赖关系

```
sensor_radar (driver_cc_binary)
├── driver/integration/components/       ← Church 组件层（RadarComponent）
│   ├── radar_component.cc / .h
│   └── BUILD (driver_cc_binary: sensor_radar)
│
├── @sensors//sensors/                   ← 核心算法与驱动层
│   ├── component/radar/                 ← RadarComponentImpl（工厂调度）
│   ├── common/radar/                    ← 公共基础设施
│   │   ├── radar_manager_base.h         ← RadarManagerBase + Factory
│   │   ├── radar_decoder_base.h         ← IDecoderBase + RadarDecoderBase<T>
│   │   ├── radar_helper.hpp             ← RadarHelper（SPSC队列 + 解码线程）
│   │   ├── radar_helper_pointcloud.hpp  ← RadarHelperPointCloud（点云路径）
│   │   ├── radar_config_singleton.h     ← RadarConfigLoader（外参加载）
│   │   └── decoder/                     ← 各平台解码器
│   │       ├── lp_25u1/                 ← LP 平台解码器
│   │       ├── geely_25u1/              ← Geely 平台解码器
│   │       ├── gwm_25u1/                ← GWM 25U1 解码器
│   │       └── gwm_25u2/                ← GWM 25U2 解码器
│   ├── utility/radar/                   ← RadarUtils（坐标变换）
│   └── projects/                        ← 各车型 RadarManager 实现
│       ├── lp8650_v1/radar/             ← LP8650 RadarManager
│       ├── lp8797_v1/radar/             ← LP8797 RadarManager
│       ├── gwm_tank/radar/              ← GWM Tank RadarManager
│       ├── gwm_thoru/radar/             ← GWM ThorU RadarManager
│       ├── gwm_oriny/radar/             ← GWM Oriny RadarManager
│       ├── gl_yinhe/radar/              ← Geely 银河 RadarManager
│       ├── smart_hy11/radar/            ← 智己 HY11 RadarManager
│       └── smart_hy11p/radar/           ← 智己 HY11P RadarManager
│
├── @proto_msg//proto/drivers/radar/     ← Protobuf 消息定义
│   ├── radar.proto                      ← Radar, RadarObs, RadarState 等
│   └── config.proto                     ← RadarConfig, RadarType
│
├── @platform//church/                   ← Church 框架
├── @common//                            ← 公共库（日志、事件上报、文件工具等）
├── @lpsdk//:lpcom                       ← LP 平台 IPC 通信 SDK
└── @dsomeip-sdk//                       ← GWM/Geely dSomeIP 通信
```

---

## 3. 概念架构图

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          sensor_radar 进程                              │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │ RadarComponent (Church Component)                                │    │
│  │  Init(): 注册 PublishMsg/PublishCloud 回调                        │    │
│  │  Proc(): 空实现（return true）                                    │    │
│  └──────────┬──────────────────────────────────────┬────────────────┘    │
│             │                                      │                     │
│             ▼                                      ▼                     │
│  ┌─────────────────────┐             ┌──────────────────────────┐       │
│  │  RadarComponentImpl  │             │   node()->Publish()       │       │
│  │  Factory: Create()   │             │   /sensors/radar/         │       │
│  └──────────┬───────────┘             │     combined_objects      │       │
│             │                         │     combined_point_cloud  │       │
│             ▼                         └──────────────────────────┘       │
│  ┌────────────────────────────────────────────────────┐                  │
│  │ RadarManager (项目特定: lp8650_v1::RadarManager)     │                  │
│  │                                                      │                  │
│  │  Init():                                             │                  │
│  │    ├── 创建 RadarHelper                               │                  │
│  │    ├── 创建 3 个 RadarDecoder (mrr_1, srr_1, srr_2)  │                  │
│  │    ├── RegisterDecoder() → 获取回调函数                │                  │
│  │    ├── RegisterTimeStampCheck() → 注册时间戳检查       │                  │
│  │    ├── 创建 lpcom SubscriberChannel                   │                  │
│  │    └── RegisterMessageCallback() → HandleXxxMessage   │                  │
│  │                                                      │                  │
│  │  Start():                                            │                  │
│  │    ├── Open() 3 个 lpcom 通道                         │                  │
│  │    └── radar_helper_->Start() → 启动解码线程           │                  │
│  └──────────┬───────────────────────────────────────────┘                  │
│             │                                                              │
│  ┌──────────▼───────────────────────────────────────────────────────┐     │
│  │ RadarHelper                                                       │     │
│  │                                                                   │     │
│  │  key_and_decoder_map_:                                            │     │
│  │    "mrr_1" → DecoderInfo { decoder, SPSC queue(64), buffer }      │     │
│  │    "srr_1" → DecoderInfo { decoder, SPSC queue(64), buffer }      │     │
│  │    "srr_2" → DecoderInfo { decoder, SPSC queue(64), buffer }      │     │
│  │                                                                   │     │
│  │  SnrRadAsembProc 线程:                                             │     │
│  │    while(running):                                                │     │
│  │      cv_.wait() → 有数据到达                                       │     │
│  │      CheckTimeoutTriggerIgnore()                                  │     │
│  │      AssembleAndPublish():                                        │     │
│  │        for each decoder:                                          │     │
│  │          pop queue → DecodePacket() → TimeStampCheck()            │     │
│  │          → TransformProject() → buffer                            │     │
│  │        if AllDecodersReady():                                     │     │
│  │          CollectBuffers() → 合并 + 求平均时间戳                    │     │
│  │          → publish_callback_() → PublishMsg()                     │     │
│  │                                                                   │     │
│  │  status_thread_: 每秒检查雷达在线状态                               │     │
│  └───────────────────────────────────────────────────────────────────┘     │
│                                                                            │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ 外部输入 (lpcom SHM)                                                 │   │
│  │  /leap/radar/front     ← MRR (前视雷达)                              │   │
│  │  /leap/radar/corner_rl ← SRR-1 (左后角雷达)                          │   │
│  │  /leap/radar/corner_rr ← SRR-2 (右后角雷达)                          │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. 关键类层次结构

### 4.1 组件层

| 类 | 文件 | 职责 |
|-|-|-|
| `RadarComponent` | `driver/.../radar_component.cc/h` | Church 组件壳，`Init()` 注册回调，`Proc()` 空实现 |
| `RadarComponentImpl` | `sensors/.../radar_component_impl.cc/h` | 通过 `RadarManagerFactory::Create(BUILD_PROJECT)` 创建项目特定管理器 |

### 4.2 管理器层

| 类 | 文件 | 职责 |
|-|-|-|
| `RadarManagerBase` | `sensors/.../radar_manager_base.h` | 抽象基类，定义 `Init/Start/Stop` 接口 |
| `RadarManagerFactory` | 同上 | 单例工厂，通过 `REGISTER_RADAR_MANAGER` 宏注册项目实现 |
| `lp8650_v1::RadarManager` | `sensors/.../lp8650_v1/radar/` | LP8650 具体实现，使用 lpcom 订阅 3 个雷达 topic |

### 4.3 帮助器层

| 类 | 文件 | 职责 |
|-|-|-|
| `RadarHelper` | `sensors/.../radar_helper.hpp` | 管理 SPSC 队列、`SnrRadAsembProc` 解码汇总线程、多雷达同步等待、坐标变换 |
| `RadarHelperPointCloud` | `sensors/.../radar_helper_pointcloud.hpp` | 4D 雷达点云路径的数据汇总，`RadarPcProc` 发布线程 |
| `RadarConfigLoader` | `sensors/.../radar_config_singleton.h` | 单例，加载 `radar_node.bin/cfg` 和 `radars.bin/cfg` 外参配置 |
| `RadarUtils` | `sensors/.../radar_utils.hpp` | 静态工具类，`TransformProject()` 坐标变换 |

### 4.4 解码器层

| 类 | 文件 | 职责 |
|-|-|-|
| `IDecoderBase` | `sensors/.../radar_decoder_base.h` | 解码器接口（`std::any` 输入） |
| `RadarDecoderBase<T>` | 同上 | 模板基类，类型安全的 `any_cast` 分发 |
| `lp_25u1::RadarDecoder` | `sensors/.../decoder/lp_25u1/` | LP 平台解码：`leap::radar::RadarObjects` → `Radar` proto |

---

## 5. 编译配置

### 5.1 Bazel BUILD target

```
driver_cc_binary(
    name = "sensor_radar",
    srcs = ["radar_component.cc", "radar_component.h"],
    deps = [
        "@proto_msg//proto/common:module_status_proto_cc",
        "@driver//integration:mainboard_library",
        "@platform//church/component:component_api",
        "@platform//church/component:component_header",
        "@sensors//sensors/component:radar_component_impl_internal",
    ],
)
```

### 5.2 项目选择机制

`@sensors//sensors/projects:register_radar` 通过 Bazel `selects.with_or()` 选择编译期链接的 RadarManager：

| Bazel Setting | 链接目标 |
|-|-|
| `LP8650-V1-SHARE` | `lp8650_v1/radar:sensors_radar` |
| `LP8797-V1-SHARE` | `lp8797_v1/radar:sensors_radar` |
| `TANK-ALL` | `gwm_tank/radar:sensors_radar` |
| `GWM-THORU-SHARE` | `gwm_thoru/radar:sensors_radar` |
| `GWM-ORINY-SHARE` | `gwm_oriny/radar:sensors_radar` |
| `YINHE-ALL` | `gl_yinhe/radar:sensors_radar` |
| `HY11-ET` | `smart_hy11/radar:sensors_radar` |
| `HY11P-ET` | `smart_hy11p/radar:sensors_radar` |

### 5.3 Church 组件配置 (`sensor_radar.jsonnet`)

```jsonnet
{
  components: [{
    class_name: 'RadarComponent',
    config: {
      name: 'Radar',
      task: {
        name: 't_Radar',
        trigger_policy: 'ANY',
        input_channels: [],       // 无 church 输入通道
        output_channels: [
          { name: '/sensors/radar/combined_objects',
            msg_type: 'deeproute.drivers.radar.Radar' },
          { name: '/sensors/radar/combined_point_cloud_proto',
            msg_type: 'deeproute.drivers.PointCloud2' },
        ],
      },
    },
  }],
}
```

**关键配置说明**：

- `input_channels` 为空 — 与 `sensor_ins_online` 和 `sensor_uss` 相同，数据通过 lpcom 直接接收，绕过 church 输入队列
- `trigger_policy: 'ANY'` — 但因无输入通道，`Proc()` 不会被触发（空实现）
- 两个输出通道均启用 `need_topic_supervision`

---

## 6. LP8650 平台详细实现

### 6.1 雷达配置

LP8650 平台配备 **3 颗毫米波雷达**：

| frame_id | 类型 | lpcom Topic | 传输方式 | 消息大小 |
|-|-|-|-|-|
| `mrr_1` | 前视中程雷达 (MRR) | `/leap/radar/front` | SHM_ONLY | 175 KB |
| `srr_1` | 左后角短程雷达 (SRR) | `/leap/radar/corner_rl` | SHM_ONLY | 175 KB |
| `srr_2` | 右后角短程雷达 (SRR) | `/leap/radar/corner_rr` | SHM_ONLY | 175 KB |

### 6.2 输入数据格式

`leap::radar::RadarObjects` (C struct, `#pragma pack(8)`)：

| 字段 | 类型 | 说明 |
|-|-|-|
| `header` | `Header` | 帧序号 + 纳秒时间戳 |
| `status` | `RadarStatus` | 雷达硬件状态（工作模式、故障标志等） |
| `objects_num` | `uint32_t` | 有效目标数（最大 40） |
| `objects[40]` | `RadarObstacle` | 障碍物数组（ID、类型、位置、速度、加速度等） |
| `latency_status` | `LatencyStatus` | 延迟统计 |
| `module_status` | `ModuleStatus` | 模块状态 |

### 6.3 输出数据格式

**Topic: `/sensors/radar/combined_objects`** → `deeproute.drivers.radar.Radar` proto：

- `header`: 所有雷达时间戳的平均值
- `radar_obs[]`: 合并后的 `RadarObs` 列表（包含所有雷达检测到的目标）
- `gm_state[]`, `gl_state[]`: GM/Geely 状态（LP 平台为空）

**Topic: `/sensors/radar/combined_point_cloud_proto`** → `deeproute.drivers.PointCloud2` proto：

- 仅 4D 雷达平台使用（`RadarHelperPointCloud` 路径）

---

## 7. 与其他 sensor 模块的架构对比

| 特性 | sensor_ins_online | sensor_uss | sensor_radar |
|-|-|-|-|
| 输入数据源 | IMU/GNSS (lpcom) | USS Probe/Obstacle (lpcom) | 3 颗雷达 (lpcom) |
| Proc() 使用 | 仅存数据 | 空实现 | 空实现 |
| 解码线程名称 | `SnrInsAsembProc` | `SnrUssAsembProc` | `SnrRadAsembProc` |
| SPSC 队列数量 | 每个解码器 1 个 (64) | 每个解码器 1 个 (64) | 每个解码器 1 个 (64) |
| 多源同步 | 无（IMU 驱动） | Probe/Obstacle 合并 | **等待所有雷达 Ready 后合并** |
| 坐标变换 | 无 | 有（局部→车体） | 有（雷达→车体，可配置） |
| 点云路径 | 无 | 无 | 有（RadarHelperPointCloud） |
| 硬件状态检查 | 有（C 层 event_statistics） | 有（12 探头故障检测） | 有（CheckRadarStatus） |
| 额外监控线程 | 无 | 无 | status_thread\_（雷达在线状态） |

---

## 8. 关联文档索引

<table id="doxcnBC7B1hMT09ZA3kMNHwwPCh"><colgroup><col/><col/><col/></colgroup><thead><tr><th vertical-align="top">文档</th><th vertical-align="top">路径</th><th vertical-align="top">内容</th></tr></thead><tbody><tr><td vertical-align="top">数据流文档</td><td vertical-align="top"><cite doc-id="SoHrdBJyyoAFYbx8RSecrNgmnVe" file-type="docx" title="sensor_radar 数据流详解" type="doc"></cite></td><td vertical-align="top">输入/输出/处理流程/频率</td></tr><tr><td vertical-align="top">线程清单</td><td vertical-align="top">thread_list.`md</td>`<td vertical-align="top">所有线程、角色、交互</td></tr><tr><td vertical-align="top">异常检测机制</td><td vertical-align="top"><cite doc-id="WbtFdwW4NojuAhxY6oxcz7n3nYe" file-type="docx" title="sensor_radar 异常检测机制" type="doc"></cite></td><td vertical-align="top">各层异常检测方式</td></tr><tr><td vertical-align="top">sensor_ins_online 文档</td><td vertical-align="top">../sensor_ins_online_docs/</td><td vertical-align="top">INS 模块参考</td></tr><tr><td vertical-align="top">sensor_uss 文档</td><td vertical-align="top">../sensor_uss_docs/</td><td vertical-align="top">USS 模块参考</td></tr></tbody></table>
