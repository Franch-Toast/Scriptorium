---
title: "sensor_lidar 模块总览"
date: 2026-09-20
description: "参考平台：LP8650-V1-SHARE"
categories:
  - 撰修司
tags:
  - sensor_lidar
---

# sensor_lidar 模块总览

> 生成日期：2026-04-16  
> 基准代码库：/sandbox 工作区  
> 参考平台：LP8650-V1-SHARE

---

## 1. 模块定位

`sensor_lidar` 是 Deeproute 自动驾驶系统中的**激光雷达点云数据处理模块**。它通过 UDP/TCP 等网络协议从车辆上安装的激光雷达（Hesai、RoboSense、Seyond 等）接收原始数据包，经过解码、帧拼装、坐标变换后，将合并后的点云数据发布到 Church 总线，供感知（perception）、定位（localization/INS）、规划（planning）等下游模块消费。

**核心特点**：

- 支持 **11+ 种车型项目**（LP/GWM/Geely/Smart/Seres），通过 `LidarManagerFactory` 在编译期选择对应的 `LidarManager`
- 数据采集使用 **UDP/TCP 网络 Socket**（非 lpcom），支持 Linux 常规 socket 和 QNX 优化的 `recvmmsg` + `poll`
- 支持 **单雷达模式**（`LidarHelperSingle`）和 **多雷达模式**（`LidarHelperMulti` / `LidarHelperQnxMulti`）
- 点云数据通过 **SHM Pool** 零拷贝传输（8MB/block），显著降低大数据量的序列化和拷贝开销
- 支持三条独立发布通道：**主点云**、**含 64 线点云**、**降采样点云**

---

## 2. 仓库依赖关系

```
sensor_lidar (driver_cc_binary)
├── driver/integration/components/       ← Church 组件层（LidarComponent）
│   ├── lidar_component.cc / .h
│   └── BUILD (driver_cc_binary: sensor_lidar)
│
├── @sensors//sensors/                   ← 核心算法与驱动层
│   ├── component/lidar/                 ← LidarComponentImpl（工厂调度）
│   ├── common/lidar/                    ← 公共基础设施
│   │   ├── lidar_manager_base.h         ← LidarManagerBase + Factory
│   │   ├── lidar_helper_base.h          ← LidarHelperBase（回调持有者）
│   │   ├── lidar_decoder_base.h         ← DecoderBase + LidarDecoderFactory
│   │   ├── lidar_config_singleton.h     ← LidarConfigLoader（配置加载）
│   │   ├── single/                      ← LidarHelperSingle（单雷达模式）
│   │   ├── multi/                       ← LidarHelperMulti + LidarHelperQnxMulti
│   │   └── decoder/                     ← 各厂商解码器
│   │       ├── hesai/                   ← 禾赛激光雷达解码器
│   │       ├── robosense/               ← 速腾聚创解码器
│   │       └── seyond/                  ← Seyond 解码器
│   ├── utility/lidar/                   ← LidarTimeChecker, FrameTimer 等工具
│   └── projects/                        ← 各车型 LidarManager 实现
│       ├── lp8650_v1/lidar/             ← LP8650 LidarManager
│       ├── lp8797_v1/lidar/             ← LP8797 LidarManager
│       ├── gwm_c01/lidar/              ← GWM C01 LidarManager
│       ├── gwm_m8/lidar/              ← GWM M8 LidarManager
│       ├── gwm_tank/lidar/             ← GWM Tank LidarManager
│       ├── gwm_thoru/lidar/            ← GWM ThorU LidarManager
│       ├── gwm_oriny/lidar/            ← GWM Oriny LidarManager
│       ├── gl_yinhe/lidar/             ← Geely 银河 LidarManager
│       ├── smart_hy11/lidar/           ← 智己 HY11 LidarManager
│       ├── smart_hy11p/lidar/          ← 智己 HY11P LidarManager
│       └── seres_at7/lidar/            ← 赛力斯 AT7 LidarManager
│
├── @proto_msg//proto/drivers/           ← Protobuf 消息定义
│   ├── pointcloud2.pb.h                ← PointCloud2（点云消息）
│   └── lidar/config.proto              ← LidarConfig, LidarType 等
│
├── @platform//church/                   ← Church 框架
│   └── node/shm/shm_pool.h            ← ShmPool（共享内存池）
├── @common//                            ← 公共库（日志、事件上报、线程池等）
└── (无 lpcom 依赖)                      ← 直接 UDP/TCP，不经 lpcom
```

---

## 3. 概念架构图

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          sensor_lidar 进程                              │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │ LidarComponent (Church Component)                                │    │
│  │  Init(): 创建 ShmPool, 注册 PublishCloud 回调, 初始化 impl       │    │
│  │  Proc(): 空实现（return true）                                    │    │
│  └──────────┬──────────────────────────────────────┬────────────────┘    │
│             │                                      │                     │
│             ▼                                      ▼                     │
│  ┌─────────────────────┐             ┌──────────────────────────┐       │
│  │  LidarComponentImpl  │             │   node()->Publish()       │       │
│  │  Factory: Create()   │             │   (via ShmPool 零拷贝)    │       │
│  └──────────┬──────────┘             └──────────────────────────┘       │
│             │                              ▲                            │
│             ▼                              │ 回调                       │
│  ┌─────────────────────────────────────────┴──────────────────┐        │
│  │  LidarManager (per-vehicle)                                  │        │
│  │  ┌─────────────────────────────────────────────────────┐    │        │
│  │  │  LidarHelper (Single / Multi / QnxMulti)             │    │        │
│  │  │                                                       │    │        │
│  │  │  ┌───────────────────────────────────────────┐       │    │        │
│  │  │  │ StreamBase (UDP/TCP/PCAP)                  │       │    │        │
│  │  │  │   read() / recvmmsg()                      │       │    │        │
│  │  │  └────────────────┬──────────────────────────┘       │    │        │
│  │  │                   ▼                                   │    │        │
│  │  │  ┌───────────────────────────────────────────┐       │    │        │
│  │  │  │ DecoderBase (Hesai/RoboSense/Seyond)      │       │    │        │
│  │  │  │   DecodePacket() → PointCloudXYZIRT        │       │    │        │
│  │  │  └────────────────┬──────────────────────────┘       │    │        │
│  │  │                   ▼                                   │    │        │
│  │  │  ┌───────────────────────────────────────────┐       │    │        │
│  │  │  │ 帧拼装 (FrameTimer + 多雷达同步)           │       │    │        │
│  │  │  │   PCLToProto → PointCloud2                 │       │    │        │
│  │  │  └────────────────┬──────────────────────────┘       │    │        │
│  │  │                   │                                   │    │        │
│  │  │                   ▼ publish_cloud_cb_*()              │    │        │
│  │  └───────────────────────────────────────────────────────┘    │        │
│  └───────────────────────────────────────────────────────────────┘        │
│                                                                           │
└───────────────────────────────────────────────────────────────────────────┘
```

---

## 4. 类层次结构

### 4.1 Church 组件层（driver/）

| 类名 | 基类 | 文件 | 职责 |
|-|-|-|-|
| `LidarComponent` | `church::Component` | `driver/integration/components/lidar_component.h/.cc` | Church 壳层，ShmPool 管理，publish 回调 |

### 4.2 Impl 层（sensors/component/）

| 类名 | 文件 | 职责 |
|-|-|-|
| `LidarComponentImpl` | `sensors/component/lidar/lidar_component_impl.h/.cc` | 工厂调度，Manager 生命周期管理 |

### 4.3 Manager 层（sensors/common + projects/）

| 类名 | 文件 | 职责 |
|-|-|-|
| `LidarManagerBase` | `sensors/common/lidar/lidar_manager_base.h` | 纯虚接口，工厂注册 |
| `LidarManager` (per-vehicle) | `sensors/projects/*/lidar/lidar_manager.h/.cpp` | 配置加载，Helper 选择，启停管理 |

### 4.4 Helper 层（sensors/common/lidar/）

| 类名 | 文件 | 适用场景 |
|-|-|-|
| `LidarHelperBase` | `sensors/common/lidar/lidar_helper_base.h` | 虚基类，持有 3 个 publish 回调 |
| `LidarHelperSingle` | `sensors/common/lidar/single/lidar_helper_single.h/.cpp` | 单雷达 |
| `LidarHelperMulti` | `sensors/common/lidar/multi/lidar_helper_multi.h/.cpp` | Linux 多雷达（SPSC 队列） |
| `LidarHelperQnxMulti` | `sensors/common/lidar/multi/lidar_helper_qnx_multi.h/.cpp` | QNX 多雷达（poll + recvmmsg） |

### 4.5 Decoder 层

| 类名 | 文件 | 职责 |
|-|-|-|
| `DecoderBase` | `sensors/common/lidar/lidar_decoder_base.h` | 虚接口 + 工厂 |
| `HesaiDecoder` | `sensors/common/lidar/decoder/hesai/` | 禾赛系列解码 |
| `RoboSenseDecoder` | `sensors/common/lidar/decoder/robosense/` | 速腾系列解码 |
| `SeyondDecoder` | `sensors/common/lidar/decoder/seyond/` | Seyond 系列解码 |

---

## 5. 编译配置

### 5.1 Church 组件配置

来自 `driver/config/component/sensor_lidar.jsonnet`：

```jsonnet
{
  components: [{
    class_name: 'LidarComponent',
    config: {
      name: 'Lidar',
      task: {
        name: 't_Lidar',
        trigger_policy: 'ANY',
        output_channels: [
          { name: '/sensors/lidar/combined_point_cloud_proto',
            msg_type: 'deeproute.drivers.PointCloud2', queue_size: 8,
            need_topic_supervision: true },
          { name: '/sensors/lidar/combined_point_cloud_downsample_proto',
            msg_type: 'deeproute.drivers.PointCloud2', queue_size: 8 },
          { name: '/sensors/lidar/combined_point_cloud_with_64_proto',
            msg_type: 'deeproute.drivers.PointCloud2', queue_size: 8 },
        ],
      },
    },
  }],
}
```

**要点**：

- `trigger_policy: 'ANY'`：虽然配置为 ANY，但由于无 `input_channels` 和 `trigger_channels`，实际不会由 Church 调度器触发 `Proc()`，数据处理完全由 Helper 内部线程驱动
- `input_channels` 和 `trigger_channels` 为空：数据通过 UDP/TCP 直接进入，非 Church 消息通道
- `output_channels` 声明 3 个点云 topic，主 topic 启用 `need_topic_supervision`
- `need_topic_supervision: true`：Church 通过 `ModuleReadinessReporter` 将该 topic 注册到 `/dsm/start_topic_supervison`，启用 DSM 启动阶段 topic 监控
- `queue_size: 8`：每个 topic 的 iceoryx 发布队列深度

### 5.2 DEM 进程配置（LP8650-V1-SHARE）

- 进程名：`dr_sensor_lidar`
- 启动依赖：`sensor_camera` 进入 `kRunning` 后才启动
- 调度：`SCHED_RR`，优先级 35，cpuset `4-7`
- 恢复策略：`RECOVERY_RESET`
- 标定状态（`kEolCalibration`）：`/task/calib_mode` 设为 `"uncalib"`，优先级降至 20
- 注意：LP8650 DEM 未配置 cgroup 内存限制；`default` DEM 配置了 cgroup（memory limit 1024MB / soft 350MB）

### 5.2 各车型 Helper 选择矩阵

| 车型 | 雷达配置 | Helper 类型 | 特殊配置 |
|-|-|-|-|
| LP8650-V1 | 单/多 | `LidarHelperSingle` / `LidarHelperQnxMulti` | QNX 优化路径 |
| LP8797-V1 | 单/多 | `LidarHelperSingle` / `LidarHelperQnxMulti` | QNX 优化路径 |
| GWM C01 | 单/多 | `LidarHelperSingle` / `LidarHelperMulti` | 额外排除区域配置 |
| GWM M8 | 单/多 | `LidarHelperSingle` / `LidarHelperMulti` | — |
| GWM Tank | 单/多 | `LidarHelperSingle` / `LidarHelperMulti` | — |
| Smart HY11 | 单/多 | `LidarHelperSingle` / `LidarHelperMulti` | 看门狗 + 帧率检查 |
| Geely 银河 | 单/多 | `LidarHelperSingle` / `LidarHelperMulti` | — |

> 选择逻辑：`config_size() == 1` → Single，否则 → Multi/QnxMulti（取决于平台）

---

## 6. 与 sensor_ins_online / sensor_radar 对比

| 维度 | sensor_lidar | sensor_radar | sensor_ins_online |
|-|-|-|-|
| 数据来源 | **UDP/TCP Socket** | lpcom SHM | lpcom SHM + dSomeIP |
| 数据量 | 大（点云 8MB/帧） | 小（\~175KB/帧） | 中（IMU/GNSS） |
| SHM Pool | ✅ 3 个独立 Pool | ❌ 无 | ❌ 无 |
| Proc() | 空 | 空 | 空（旁路设计） |
| trigger_policy | IMMEDIATE | ANY | PERIODIC |
| 核心线程 | `sensor_lidar` / `ProcessCloud` | `SnrRadAsembProc` | `SnrInsOnlnProc` |
| 多设备同步 | FrameTimer + pub_flag_vec | AllDecodersReady() | — |
| 厂商解码器 | Hesai/RoboSense/Seyond | LP/GWM/Geely | — |
| lpcom 依赖 | ❌ 无 | ✅ 核心 | ✅ 核心 |
| 输出 topic 数 | 3 | 2 | \~10 |

---

## 7. 关联文档

<table id="doxcnmrHvzYIRS4nZdbK45QPjzd"><colgroup><col/><col/></colgroup><thead><tr><th vertical-align="top">文档</th><th vertical-align="top">说明</th></tr></thead><tbody><tr><td vertical-align="top"><cite doc-id="Kr67dls4hoNe6YxiEG2cjg6Dnnf" file-type="docx" title="sensor_lidar 数据流详解" type="doc"></cite></td><td vertical-align="top">数据流详解</td></tr><tr><td vertical-align="top">thread_list.`md</td>`<td vertical-align="top">线程清单</td></tr><tr><td vertical-align="top"><cite doc-id="FDU3dZN4soBr6mxHc4HcnHkwnhd" file-type="docx" title="sensor_lidar 异常检测机制" type="doc"></cite></td><td vertical-align="top">异常检测机制</td></tr><tr><td vertical-align="top">shm_pool_deep_dive.`md</td>`<td vertical-align="top">ShmPool 零拷贝发布机制深度解析</td></tr><tr><td vertical-align="top">cross_module_comparison.`md</td>`<td vertical-align="top">sensor_lidar / sensor_radar / sensor_ins_online 架构对比</td></tr><tr><td vertical-align="top">../sensor_radar_docs/</td><td vertical-align="top">sensor_radar 同类文档（对照参考）</td></tr><tr><td vertical-align="top">../sensor_ins_online_docs/</td><td vertical-align="top">sensor_ins_online 同类文档（对照参考）</td></tr></tbody></table>
