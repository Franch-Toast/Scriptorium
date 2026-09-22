---
title: "sensor_ins_online 模块完整说明书"
date: 2026-09-20
description: "适用仓库：localization-mcu + 关联仓库（sensors, driver, platform, common, mcu_common, prot"
categories:
  - 撰修司
tags:
  - sensor_ins_online
---

# sensor_ins_online 模块完整说明书

> **文档状态：** 持续更新中（通过问答迭代完善）  
> **最后更新：** 2026-04-02  
> **适用仓库：**`localization-mcu` + 关联仓库（`sensors`, `driver`, `platform`, `common`, `mcu_common`, `proto_msg`）

---

## 一、模块概述

`sensor_ins_online` 是车载实时惯性导航与多传感器融合定位模块。它接收来自 IMU（惯性测量单元）、GNSS（全球卫星导航）、轮速计和激光雷达匹配结果等多传感器数据，通过 29 维扩展卡尔曼滤波（EKF）进行多传感器融合，输出高频高精度的车辆位姿（`/localization/pose`）及相关 GNSS 定位信息。

**核心算法语言：** C（纯 C 实现，便于嵌入式/MCU 移植）  
**框架层语言：** C++（church 框架组件封装）  
**构建系统：** Bazel  
**运行平台：** QNX RTOS (aarch64) / Linux (x86_64 仅用于测试/仿真)

---

## 二、多仓库架构总览

`sensor_ins_online` 的代码分散在 **6 个 Git 仓库** 中，由 Bazel 的 `local_repository` 机制组合编译。以下是完整的仓库依赖关系：

```
                          ┌─────────────────────────────┐
                          │      bazel_configs           │
                          │  (deeproute_build_tools)     │
                          │  构建规则/工具链/平台配置       │
                          └──────────────┬──────────────┘
                                         │ toolchains, rules
              ┌──────────────────────────┼──────────────────────────┐
              │                          │                          │
              ▼                          ▼                          ▼
┌─────────────────────┐   ┌──────────────────────┐   ┌──────────────────────┐
│      sensors        │   │   localization-mcu    │   │       driver         │
│   (传感器驱动层)     │   │   (核心算法仓库)       │   │   (框架集成层)        │
│                     │   │                      │   │                      │
│ • ins_component_impl│   │ ★ 算法/融合/工具      │   │ • sensor_ins_online  │
│ • ins_helper        │   │ ★ InsOnlineManager    │   │   _component.cc      │
│ • ins_decoder_*     │   │ ★ MSF Kalman Filter   │   │ • jsonnet 配置       │
│ • ins_manager_base  │   │ ★ Extrapolator        │   │ • DEM 部署配置       │
│ • 车型 decoder 适配  │   │ ★ Proto 定义          │   │ • thread_config      │
└────────┬────────────┘   └──────────┬───────────┘   └──────────┬───────────┘
         │                           │                          │
         │  @sensors//               │                          │  @driver//
         └───────────────────────────┼──────────────────────────┘
                                     │
                    ┌────────────────┼────────────────┐
                    │                │                │
                    ▼                ▼                ▼
          ┌──────────────┐ ┌──────────────┐ ┌──────────────────┐
          │   common     │ │  mcu_common  │ │    proto_msg     │
          │ (通用库)      │ │ (MCU通用库)  │ │ (Protobuf定义)   │
          │              │ │              │ │                  │
          │ • log        │ │ • matrix     │ │ • module_event   │
          │ • time       │ │ • quaternion │ │ • gnss/ins proto │
          │ • file_util  │ │ • rotation3  │ │ • chassis proto  │
          │ • event_log  │ │ • transform3 │ │ • localization   │
          │ • thread_pool│ │ • queue      │ │   _internal      │
          │ • coordinate │ │ • interpol.  │ │                  │
          └──────────────┘ └──────────────┘ └──────────────────┘
                                     │
                                     ▼
                          ┌──────────────────────┐
                          │     platform         │
                          │   (church 框架)       │
                          │                      │
                          │ • node (消息传递)      │
                          │ • component (生命周期) │
                          │ • event_reporter     │
                          │ • message_report     │
                          └──────────────────────┘
```

### 仓库清单与 Bazel 名称

| Bazel 名称 | 本地路径 | 定义位置 | 职责 |
|-|-|-|-|
| `@localization-mcu` | (自身) | `WORKSPACE` | 核心算法：MSF 融合、卡尔曼滤波、捷联惯导、位姿外推 |
| `@sensors` | `../sensors` | `deps.bzl` | 传感器驱动层：INS 硬件数据接收、解包、SPSC 队列 |
| `@driver` | `../driver` | `deps.bzl` | 框架集成层：church 组件封装、配置、部署 |
| `@platform` | `../platform` | `deps.bzl` | church 框架：节点通信、组件生命周期、调度 |
| `@common` | `../common` | `deps.bzl` | 公共基础库：日志、时间、文件、事件、坐标变换 |
| `@mcu_common` | `../mcu_common` | `deps.bzl` | MCU 数学库：矩阵运算、四元数、旋转、插值 |
| `@proto_msg` | `../proto_msg` | `deps.bzl` | 全局 Protobuf 消息定义 |
| `@deeproute_build_tools` | `../bazel_configs` | `WORKSPACE` | Bazel 构建规则、工具链注册 |
| `@third_party` | `../third_party` | `WORKSPACE` | 第三方库（Boost、gRPC、Abseil 等） |
| `@misc_workspace` | `../third_party/submodule/misc_workspace` | `WORKSPACE` | 其他第三方子模块 |
| `@lpsdk` | (git 远程仓库) | `third_party/dr_third_party.bzl` → `lp_deps()` | 零跑 LP 通信 SDK（`liblpCom.so.2`），LP8650/LP8797 车型的 IPC 中间件 |
| `@lp_release` | `/usr/` (本地) | `misc_workspace/deps.bzl` | LP 发布包抽象层，按平台选择 `@lp8650` 或 `@lp8797` |
| `@lp8650` / `@lp8797` | (http_archive) | `misc_workspace/deps.bzl` | LP 平台预编译产物包，包含 `liblpCom.so*` 及头文件 |

---

## 三、localization-mcu 仓库内部结构

这是核心算法仓库，全部 INS 融合逻辑都在这里。

```
localization-mcu/
├── BUILD                           # 顶层：release 打包 + 工具链注册
├── WORKSPACE                       # Bazel workspace 定义
├── deps.bzl                        # 外部仓库依赖声明
│
├── sensor_ins_online/              # ★ 核心模块根目录
│   ├── BUILD                       # 仅 package(default_visibility)
│   │
│   ├── node/                       # ★ 节点层（Manager + ComponentImpl）
│   │   ├── BUILD                   # 定义所有可执行目标和核心库
│   │   ├── sensor_ins_online_manager.h/cpp     # InsOnlineManager 主类
│   │   ├── sensor_ins_online_component_impl.h/cc # SensorInsOnlineComponentImpl
│   │   ├── sensor_ins_online_node.cc           # 独立节点入口
│   │   ├── ins_online_benchmark_runner.cc      # 离线 benchmark
│   │   ├── ins_online_benchmark_runner_multi_threads.cc
│   │   └── node_utils/
│   │       ├── BUILD
│   │       └── signal_hook.h/cc                # 信号处理
│   │
│   ├── algorithm/                  # ★ 核心算法
│   │   ├── multi_sensors_fusion_odometry/      # ★★ MSF 多传感器融合
│   │   │   ├── BUILD               # 6 个 Bazel target（见下文）
│   │   │   ├── include/
│   │   │   │   └── multi_sensors_fusion.h/c    # MSF 主 API
│   │   │   ├── common/
│   │   │   │   ├── kalman_filter.h/c           # 29 维 Kalman 滤波器
│   │   │   │   ├── kalman_common_define.h/c    # 状态维度定义(29)
│   │   │   │   ├── extrapolator.h/c            # 位姿外推器
│   │   │   │   ├── ins_odometry.h/c            # INS 里程计
│   │   │   │   ├── load_configs.h/c            # 配置加载
│   │   │   │   └── state_feedback.h/c          # 状态反馈
│   │   │   ├── data_processor/
│   │   │   │   ├── imu_msg_handler.h/c         # IMU 数据处理
│   │   │   │   ├── gnss_msg_handler.h/c        # GNSS 数据处理
│   │   │   │   ├── wheelspeed_msg_handler.h/c  # 轮速数据处理
│   │   │   │   ├── lidar_msg_handler.h/c       # Lidar 匹配处理
│   │   │   │   ├── alignment.h/c               # 初始对准
│   │   │   │   └── data_processor_base.h/c     # 处理器基类
│   │   │   ├── measure_modules/
│   │   │   │   ├── nonholonomic_constraints.h/c  # NHC 非完整性约束
│   │   │   │   ├── static_constraints.h/c        # 零速约束 (ZUPT)
│   │   │   │   ├── gnss_speed.h/c                # GNSS 速度量测
│   │   │   │   ├── wheel_speed_sensor.h/c        # 轮速量测
│   │   │   │   ├── lidar.h/c                     # Lidar 量测
│   │   │   │   └── measure_module_base.h/c       # 量测基类
│   │   │   └── protocol_set/
│   │   │       └── protocol_set.h/c              # 数据协议结构
│   │   │
│   │   ├── strapdown_inertial_system/          # ★ 捷联惯导系统
│   │   │   ├── BUILD
│   │   │   ├── strapdown_inertial_system.h
│   │   │   ├── strapdown_inertial_system_odometry.h/c  # 捷联惯导主体
│   │   │   ├── geodetic_navigation.h/c         # 大地导航
│   │   │   ├── inertial_unit_model.h/c         # IMU 误差模型
│   │   │   ├── coarse_alignment_on_move.h/c    # 动态粗对准
│   │   │   ├── grs_earth_model.h/c             # 地球模型 (GRS80)
│   │   │   └── strapdown_common_types.h        # 类型定义
│   │   │
│   │   └── static_detector/                    # ★ 静止检测器
│   │       ├── BUILD
│   │       ├── forward_sensitivity_detector.h/c  # 前向灵敏度检测
│   │       ├── sliding_mean_and_variance.h/c     # 滑动均值与方差
│   │       └── low_pass_filter.h/c               # 低通滤波器
│   │
│   ├── sensor_ins/                 # 传感器数据流接口
│   │   ├── BUILD                   # proto_msg_adapter
│   │   ├── proto_msg_adapter.h     # Protobuf ↔ C 结构体适配
│   │   ├── proto/
│   │   │   ├── BUILD               # stream_proto, gnss_config_proto
│   │   │   ├── localization_stream.proto
│   │   │   └── gnss_config.proto
│   │   └── stream/
│   │       ├── BUILD               # stream (online) / stream_offline
│   │       ├── stream_base.h       # 流基类
│   │       ├── sensor_stream.h/cpp # 传感器流 (总调度)
│   │       ├── church_stream.cpp   # Church 框架流
│   │       ├── tcp_stream.cpp      # TCP 流
│   │       └── udp_stream.cpp      # UDP 流
│   │
│   ├── utility/                    # 工具函数
│   │   ├── BUILD                   # utility, protocol_interface, test_tools, os_adapter
│   │   ├── event_statistics.h/c    # ★ 事件统计与超时检测
│   │   ├── kinematics.h/c          # 运动学计算
│   │   ├── time_tools.h/c          # 时间工具
│   │   ├── proto_converter.h/c     # Proto 转换
│   │   ├── onboard_utils.h/cc      # 车载工具
│   │   ├── cJSON.h/c               # JSON 解析 (轻量级)
│   │   ├── efficient_macros.h/c    # 效率宏
│   │   ├── craii.h                 # RAII 封装
│   │   └── protocol_interface.h    # 协议接口定义
│   │
│   ├── proto/                      # Protobuf 定义
│   │   ├── BUILD                   # ins_proto / ins_cc_proto / ins_c_proto
│   │   ├── config/
│   │   │   ├── config_filter.proto           # 滤波器配置
│   │   │   ├── config_static_detector.proto  # 静止检测配置
│   │   │   ├── debug_ins_online_internal_state.proto  # 内部状态调试
│   │   │   └── stream.proto                  # 流配置
│   │   └── loc_common/
│   │       ├── geometry.proto                # 几何类型
│   │       └── matrix.proto                  # 矩阵类型
│   │
│   ├── misc/                       # 运行时配置文件
│   │   ├── DEFAULT/                # 默认配置
│   │   │   ├── filter_epson_g365.cfg         # Epson G365 IMU 滤波器参数
│   │   │   └── static_detector_epson_g365.cfg # 静止检测参数
│   │   └── HY11/                   # HY11 车型配置
│   │       ├── filter_epson_g365.cfg
│   │       └── static_detector_epson_g365.cfg
│   │
│   ├── test/                       # 集成测试
│   │   ├── BUILD                   # test_helper
│   │   └── odometry/
│   │       ├── BUILD               # odometry_test, odometry_gt
│   │       ├── odometry_test_node.cpp
│   │       ├── odometry_gt_node.cpp
│   │       ├── ros_message_publisher.h
│   │       ├── run_trip_bag_with_valgrind.py
│   │       └── test_case_1/BUILD
│   │
│   ├── unit_test/                  # 单元测试
│   │   ├── BUILD                   # 3 个 gtest 目标
│   │   ├── measure_modules_test.cpp
│   │   ├── multi_sensors_fusion_odometry_test.cpp
│   │   └── multi_sensors_fusion_odometry_robust_test.cpp
│   │
│   └── script/                     # 脚本
│
├── pipeline/                       # 发布打包
│   ├── BUILD                       # bin/lib/config 打包
│   ├── setup.bash
│   ├── DEBIAN/
│   ├── module_bench/               # 模块 benchmark
│   └── unit_test/
│
├── third_party/
│   └── protobuf/
│       └── protobuf_repo.bzl       # Protobuf 仓库配置
│
└── gitlab-ci/                      # CI 配置
    └── benchmark/
```

---

## 四、Bazel 构建目标依赖图

### 4.1 localization-mcu 内部 Bazel 目标

以下是所有 Bazel target 及其依赖关系的完整图。箭头方向表示"依赖于"。

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           编译产物（最终输出）                             │
│                                                                         │
│  libsensor_ins_online_component_impl.so  ← 部署到 QNX 的动态库          │
│  sensor_ins_online_node                  ← 独立节点可执行文件             │
│  ins_online_benchmark_runner             ← 离线 benchmark 工具          │
│  ins_online_benchmark_runner_multi_threads ← 多线程 benchmark           │
└─────────────┬───────────────────────────────────┬───────────────────────┘
              │                                   │
              ▼                                   ▼
┌──────────────────────────────┐   ┌──────────────────────────────────────┐
│ :sensor_ins_online_component │   │ :sensor_ins_offline_component        │
│ _impl_internal               │   │ _impl_internal                      │
│                              │   │                                      │
│ sensor_ins_online_component  │   │ 同左但使用 stream_offline            │
│ _impl.h/cc                   │   │ (定义 INS_OFFLINE_MODE)              │
└──────────┬───────────────────┘   └──────────┬───────────────────────────┘
           │                                  │
           ▼                                  ▼
┌──────────────────────────┐      ┌──────────────────────────┐
│ //node:sensor_ins_online │      │ //node:sensor_ins_offline │
│                          │      │                          │
│ sensor_ins_online_       │      │ 同左 + stream_offline    │
│ manager.h/cpp            │      │                          │
└──────────┬───────────────┘      └──────────┬───────────────┘
           │                                  │
     ┌─────┴──────────────┬───────────────────┘
     │                    │
     ▼                    ▼
┌─────────────┐  ┌────────────────────┐
│ //sensor_ins│  │ //sensor_ins/stream│
│ :proto_msg_ │  │ :stream            │
│  adapter    │  │ (或 :stream_offline)│
└─────┬───────┘  └────────┬───────────┘
      │                   │
      │                   │  (Online 版本, QNX only)
      │                   ├──→ @sensors//sensors/component:ins_component_impl_internal
      │                   │
      │                   └──→ //sensor_ins/proto:stream_cc_proto
      │
      └──→ //utility:utility
           //proto:ins_cc_proto  (C++ proto)
           //proto:ins_c_proto   (C proto, proto2struct)
           @proto_msg 各种 proto_cc
```

### 4.2 algorithm 子目录依赖图

```
//node:sensor_ins_online
  │
  └──→ //algorithm/multi_sensors_fusion_odometry:multi_sensors_fusion_odometry
         │
         ├──→ :data_processor_odometry
         │      ├── imu_msg_handler.c        ─→ :protocol_set_odometry
         │      ├── gnss_msg_handler.c            :measure_modules_odometry
         │      ├── wheelspeed_msg_handler.c
         │      ├── lidar_msg_handler.c
         │      ├── alignment.c
         │      └── data_processor_base.c
         │
         ├──→ :common_odometry
         │      ├── kalman_filter.c          ─→ :kalman_common_define
         │      ├── extrapolator.c               :protocol_set_odometry
         │      ├── ins_odometry.c               //static_detector
         │      ├── load_configs.c               //strapdown_inertial_system
         │      ├── state_feedback.c             //utility
         │      └──→ //utility:protocol_interface
         │
         ├──→ :protocol_set_odometry
         │      └── protocol_set.c           ─→ :kalman_common_define
         │                                       //static_detector
         │
         ├──→ :measure_modules_odometry
         │      ├── nonholonomic_constraints.c ─→ :kalman_common_define
         │      ├── static_constraints.c          :common_odometry
         │      ├── gnss_speed.c                  //strapdown_inertial_system
         │      ├── wheel_speed_sensor.c
         │      ├── lidar.c
         │      └── measure_module_base.c
         │
         ├──→ :kalman_common_define
         │      └── kalman_common_define.c   ─→ @mcu_common//matrix
         │                                       @mcu_common//Transformation
         │                                       //utility
         │
         └──→ @mcu_common//matrix, quaternion, rotation3

//algorithm/strapdown_inertial_system:strapdown_inertial_system
  ├── strapdown_inertial_system_odometry.c
  ├── geodetic_navigation.c
  ├── inertial_unit_model.c
  ├── coarse_alignment_on_move.c
  ├── grs_earth_model.c
  └──→ //utility, //proto:ins_c_proto, :kalman_common_define
       @mcu_common//interpolation, matrix

//algorithm/static_detector:static_detector
  ├── forward_sensitivity_detector.c
  ├── sliding_mean_and_variance.c
  ├── low_pass_filter.c
  └──→ //utility, @mcu_common//queue
```

### 4.3 跨仓库依赖图（完整编译链）

```
@driver//integration/components:sensor_ins_online    ← 最终 .so 产物
  │
  ├──→ @localization-mcu//sensor_ins_online/node:sensor_ins_online_component_impl_internal
  │      │
  │      ├──→ @localization-mcu//sensor_ins_online/node:sensor_ins_online
  │      │      │
  │      │      ├──→ //algorithm/multi_sensors_fusion_odometry:multi_sensors_fusion_odometry
  │      │      │      └──→ @mcu_common//matrix, quaternion, rotation3
  │      │      │
  │      │      ├──→ //sensor_ins/stream:stream
│      │      │      └──→ @sensors//sensors/component:ins_component_impl_internal (QNX)
│      │      │             └──→ @sensors//sensors/projects:register_ins
│      │      │                    └──→ //sensors/projects/<车型>/ins:sensors_ins
│      │      │                           └──→ //sensors/common/ins:ins_common_<variant>
│      │      │                                  └──→ ins_helper, ins_decoder_base
│      │      │                                       @dsomeip-sdk (Smart/GWM/Geely)
│      │      │                                       @lpsdk//:lpcom (LP8650/LP8797)
  │      │      │
  │      │      ├──→ //utility:utility
  │      │      ├──→ //proto:ins_cc_proto
  │      │      ├──→ @common//common:log, time, event_log_handle, file_util, thread_pool
  │      │      └──→ @proto_msg//proto/...:各种 proto_cc
  │      │
  │      ├──→ @common//coordinate_transform
  │      └──→ @boost_dynamic//:boost
  │
  ├──→ @platform//church/component:component_header
  ├──→ @common//base/protobuf_arena_optimize:protobuf_user_api
  └──→ //integration:mainboard_library
```

---

## 五、三层架构详解

### 5.1 第 1 层：sensors 仓库（传感器驱动层）

**职责：** 从硬件设备接收原始数据，解包为结构化消息。

> **注意：** sensors 代码**不是** IMU/GNSS 设备的固件。它运行在 **SOC 主计算平台**（如 Qualcomm SA8650）上，是一个软件驱动层。IMU/GNSS 是独立硬件模块（ADPU），通过**车载以太网**将数据发送到 SOC。不同车型使用不同的通信中间件：
> 
> - **Smart/GWM/Geely 车型**：使用 **dSomeIP**（Deeproute SOME/IP）
> - **LP (零跑) 车型**：使用 **lpcom**（`liblpCom.so.2`，零跑自研 IPC SDK，`Leap::Com` 命名空间），通过共享内存（IMU）或网络（GNSS）接收数据
> 
> sensors 层在 SOC 端订阅传感器事件、解码协议数据、传递给算法层。详细说明见 `data_flow.md` 第二节。

**关键组件：**

| 组件 | 路径 | 说明 |
|-|-|-|
| `ins_component_impl` | `sensors/component/ins/` | church 组件封装，通过 `dlopen` 加载 |
| `ins_helper` | `sensors/common/ins/ins_helper.hpp` | SPSC 队列管理，`SnrInsAsembProc` 解包线程 |
| `ins_manager_base` | `sensors/common/ins/` | INS 管理器基类 |
| `ins_decoder_base` | `sensors/common/ins/` | 解码器基类 |
| `ins_common_*` | `sensors/common/ins/decoder/` | 车型特定解码器（6 种变体） |
| `register_ins` | `sensors/projects/` | 通过 Bazel `select` 按车型注册解码器 |

**车型解码器变体：**

| 变体 | 适用车型 |
|-|-|
| `gwm_24u1` | GWM C01, M8 |
| `gwm_25u1` | C01, M8, Tank, Oriny |
| `gwm_25u2` | Tank, Thoru, Oriny |
| `geely_25u1` | Yinhe (银河) |
| `dr_x26` | Seres AT7 |
| `lp_25u1` | LP8650, LP8797 |
| (无 ins_common\_\*) | Smart HY11, HY11P (直接实现) |

**online vs offline 模式：**

`stream` target（online）在 QNX 平台上链接 `@sensors//sensors/component:ins_component_impl_internal`，通过 dSomeIP（或 LP 车型的 lpcom）实时接收硬件数据。`stream_offline` 不链接 sensors，通过 `INS_OFFLINE_MODE` 宏走离线数据路径。

### 5.2 第 2 层：localization-mcu 仓库（核心算法层）

**职责：** 多传感器融合定位算法的完整实现。

| 子模块 | Bazel 路径 | 文件数 | 语言 | 说明 |
|-|-|-|-|-|
| **InsOnlineManager** | `//node:sensor_ins_online` | 2 | C++ | 主管理器，创建处理线程，编排数据流 |
| **SensorInsOnlineComponentImpl** | `//node:sensor_ins_online_component_impl_internal` | 2 | C++ | 对接 church 框架的实现类 |
| **multi_sensors_fusion_odometry** | `//algorithm/msf_odometry:multi_sensors_fusion_odometry` | 2 | C | MSF 核心 API（SaveRawImuMsg, HandleMeasurement...） |
| **data_processor_odometry** | `//algorithm/msf_odometry:data_processor_odometry` | 12 | C | 各传感器数据处理器 |
| **common_odometry** | `//algorithm/msf_odometry:common_odometry` | 10 | C | Kalman 滤波器、外推器、INS 里程计 |
| **measure_modules_odometry** | `//algorithm/msf_odometry:measure_modules_odometry` | 12 | C | 量测模型（NHC、ZUPT、GNSS、轮速、Lidar） |
| **protocol_set_odometry** | `//algorithm/msf_odometry:protocol_set_odometry` | 2 | C | 数据协议结构定义 |
| **kalman_common_define** | `//algorithm/msf_odometry:kalman_common_define` | 2 | C | 29 维状态定义 |
| **strapdown_inertial_system** | `//algorithm/sis:strapdown_inertial_system` | 11 | C | 捷联惯导系统（导航方程、地球模型） |
| **static_detector** | `//algorithm/sd:static_detector` | 6 | C | 静止状态检测（滑动方差、低通滤波） |
| **utility** | `//utility:utility` | 14 | C/C++ | 工具函数（事件统计、运动学、时间、JSON） |
| **proto** | `//proto:ins_cc_proto` / `:ins_c_proto` | 6 proto | Proto | 配置定义（滤波器参数、流配置、几何类型） |
| **sensor_ins/proto_msg_adapter** | `//sensor_ins:proto_msg_adapter` | 1 | C++ | Protobuf ↔ C 结构体转换 |
| **sensor_ins/stream** | `//sensor_ins/stream:stream` | 4 | C++ | 数据流管理（TCP/UDP/Church/Sensor） |

### 5.3 第 3 层：driver 仓库（框架集成层）

**职责：** 将算法模块接入 church 框架，处理消息路由和配置。

**关键文件：**

| 文件 | 路径 | 说明 |
|-|-|-|
| `sensor_ins_online_component.cc/h` | `driver/integration/components/` | church Component 封装，Init() 注册 7 个回调 |
| `sensor_ins_offline_component.cc/h` | `driver/integration/components/` | 离线版本 Component |
| `sensor_ins_online.jsonnet` | `driver/config/component/` | 组件配置（输入输出 topic、触发策略） |
| DEM 配置 (8 种) | `driver/config/dem/*/` | 部署环境管理配置 |
| thread_config (7 种) | `driver/config/thread_config/*/` | 线程优先级配置 |

**church 组件配置（sensor_ins_online.jsonnet）核心内容：**

| 配置项 | 值 |
|-|-|
| trigger_policy | `ANY` |
| expected_proc_duration_ms | `100` |
| **输入 channels (trigger)** | `/canbus/wheel_speed`, `/localization/matching_status`, `/sensors/someip/rawdata` |
| **输出 channels** | `/localization/pose`, `/localization/keyframe_update_status`, `/localization/debug/internal_state`, `/sensors/gnss/raw_gnss_position`, `/sensors/gnss/wgs84_gnss_position`, `/sensors/gnss/gcj02_gnss_position`, `/sensors/gnss/raw_short_raw_imu`, `/sensors/gnss/raw_gnss_velocity`, `/sensors/gnss/raw_gga`, `/sensors/gnss/raw_ins_pva_x`, `/sensors/gnss/gcj02_ins_pva_x` |

---

## 六、数据流全景

```
硬件 IMU/GNSS 设备
  │ dSomeIP 事件 (Smart/GWM/Geely) 或 lpcom 通道 (LP 零跑)
  ▼
┌─────────────────── sensors 仓库 ───────────────────┐
│ ins_component_impl → InsManager → InsHelper        │
│   → SPSC queue(64) → SnrInsAsembProc 线程          │
│   → DecodePacket → sensors_ins_packet              │
│   → data_stream_ptr_->Init() 回调                  │
└──────────────────────┬─────────────────────────────┘
                       │ callback
                       ▼
┌──────────── localization-mcu 仓库 ─────────────────┐
│ InsOnlineManager::InitGnss() 注册回调               │
│   data → ins_recv_queue_.push + notify              │
│                                                     │
│ SnrInsOnlnProc 线程 (Thread 15):                    │
│   loop: ins_recv_queue_.pop(pkt)                    │
│     → UnpackSensorsIns                              │
│     → ParseImu → SaveRawImuMsg                      │
│       → HandleMeasurementBeforeGivenTime            │
│         → HandleRawImuMsg (29x29 Kalman)            │
│         → HandleGnss/WheelSpeed/Lidar               │
│     → GetExtrapolatedVehicleState (位姿外推)         │
│     → 触发 odometry_output_callback_                │
└──────────────────────┬─────────────────────────────┘
                       │ callback
                       ▼
┌───────────────── driver 仓库 ──────────────────────┐
│ sensor_ins_online_component.cc                      │
│   pub_odom_out_cb:                                  │
│     node()->Publish("/localization/pose", msg)      │
│   pub_raw_imu_cb:                                   │
│     node()->Publish("/sensors/gnss/raw_short_raw_   │
│                      imu", msg)                     │
│   pub_gnss_pos_cb:                                  │
│     node()->Publish("/sensors/gnss/raw_gnss_        │
│                      position", msg)                │
│   ... (共 7 个回调)                                  │
└──────────────────────┬─────────────────────────────┘
                       │ church Publish
                       ▼
        /localization/pose (20Hz)
        /sensors/gnss/raw_short_raw_imu (200Hz)
        /sensors/gnss/raw_gnss_position (1-10Hz)
        /sensors/gnss/wgs84_gnss_position (1-10Hz)
        ... 等 11 个输出 topics

同时 church Proc() 接收:
  /canbus/wheel_speed ─────→ impl_->AddWheel()
  /localization/matching_status ──→ impl_->AddLidarMatchMsg()
  (这两路数据通过 church 调度进入, 插入共享 map)
```

---

## 七、编译产物清单

### 7.1 可执行产物

| 目标名 | 类型 | 来源 BUILD | 说明 |
|-|-|-|-|
| `libsensor_ins_online_component_impl.so` | 动态库 | `//node:BUILD` | 核心算法 .so，被 driver 通过 dlopen 加载 |
| `sensor_ins_online_node` | 可执行 | `//node:BUILD` | 独立运行节点（直接链接 church node） |
| `ins_online_benchmark_runner` | 可执行 | `//node:BUILD` | 离线 benchmark（读 dpbag） |
| `ins_online_benchmark_runner_multi_threads` | 可执行 | `//node:BUILD` | 多线程 benchmark（读 ROS bag，x86 only） |
| `odometry_test` | 可执行 | `//test/odometry:BUILD` | 里程计测试 |
| `odometry_gt` | 可执行 | `//test/odometry:BUILD` | 真值比较测试 |

### 7.2 单元测试

| 目标名 | 来源 BUILD | 测试对象 |
|-|-|-|
| `geodetic_navigation_test` | `//algorithm/sis:BUILD` | 大地导航 |
| `inertial_unit_model_test` | `//algorithm/sis:BUILD` | IMU 模型 |
| `strapdown_inertial_system_odometry_test` | `//algorithm/sis:BUILD` | 捷联惯导 |
| `coarse_alignment_on_move_test` | `//algorithm/sis:BUILD` | 动态粗对准 |
| `static_detector_test` | `//algorithm/sd:BUILD` | 静止检测 |
| `measure_modules_odometry_test` | `//unit_test:BUILD` | 量测模型 |
| `multi_sensors_fusion_odometry_test` | `//unit_test:BUILD` | MSF 融合 |
| `multi_sensors_fusion_odometry_robust_test` | `//unit_test:BUILD` | MSF 鲁棒性 |

### 7.3 Release 打包 (`//pipeline:BUILD`)

最终部署包结构：

```
sensor-ins-online/
├── bin/
│   ├── libsensor_ins_online_component.so   ← @driver//integration/components:sensor_ins_online
│   ├── libsensor_ins_offline_component.so  ← @driver//integration/components:sensor_ins_offline
│   ├── ins_online_benchmark_runner         ← (x86 only)
│   ├── ins_online_benchmark_runner_multi_threads ← (x86 only)
│   ├── odometry_test / odometry_gt         ← (x86 only)
│   └── run_trip_bag_with_valgrind.py
├── lib/
│   └── libprotobuf.so                     ← @com_google_protobuf
├── config/
│   ├── sensor_ins_online.jsonnet           ← @driver//config/component
│   ├── sensor_ins_offline.jsonnet
│   └── sensor-ins-online/misc/
│       ├── filter_epson_g365.cfg           ← 按车型选择 DEFAULT 或 HY11
│       └── static_detector_epson_g365.cfg
└── setup.bash
```

---

## 八、Proto 定义索引

### 8.1 localization-mcu 内部 Proto

| Proto 文件 | Bazel target | 说明 |
|-|-|-|
| `config/config_filter.proto` | `//proto:ins_proto` | 滤波器配置（Kalman 参数、噪声） |
| `config/config_static_detector.proto` | 同上 | 静止检测器配置 |
| `config/debug_ins_online_internal_state.proto` | 同上 | 调试用内部状态 |
| `config/stream.proto` | 同上 | 数据流配置 |
| `loc_common/geometry.proto` | 同上 | 几何类型（点、四元数等） |
| `loc_common/matrix.proto` | 同上 | 矩阵类型 |
| `sensor_ins/proto/localization_stream.proto` | `//sensor_ins/proto:stream_proto` | 定位数据流 |
| `sensor_ins/proto/gnss_config.proto` | `//sensor_ins/proto:gnss_config_proto` | GNSS 配置 |

### 8.2 引用的外部 Proto (@proto_msg)

| Proto | 用途 |
|-|-|
| `proto/common:module_event_proto` | 模块事件枚举 |
| `proto/drivers/gnss:ins_proto` | INS 定位消息 |
| `proto/drivers/gnss:gnss_proto` | GNSS 位置/速度消息 |
| `proto/drivers/gnss:gnss_raw_proto` | 原始 GNSS 数据 |
| `proto/drivers/gnss:imu_proto` | IMU 数据消息 |
| `proto/drivers/inu:config_navigation_device_proto` | 导航设备配置 |
| `proto/localization:localization_internal_messages_proto` | 内部定位消息 |
| `proto/canbus:chassis_proto` | 底盘/轮速消息 |
| `proto/common/configs:vehicle_config_proto` | 车辆配置 |

---

## 九、外部依赖库

| 库 | Bazel 名称 | 用途 |
|-|-|-|
| lpcom (LP SDK) | `@lpsdk//:lpcom` (`liblpCom.so.2`) | 零跑 IPC 通信中间件（`Leap::Com`），LP8650/LP8797 车型替代 dSomeIP 的传感器数据通道 |
| lp_release | `@lp_release//:lpcom` → `@lp8650//:lpcom` | 预编译 LP 发布包中的 lpcom（与 `@lpsdk` 提供相同库，不同获取路径） |
| Boost | `@boost//:filesystem`, `@boost_dynamic//:boost` | 文件系统、序列化 |
| Abseil | `@com_google_absl//absl/status:statusor` | 状态返回值 |
| Protobuf | `@com_google_protobuf` | 消息序列化 |
| gRPC | `@com_github_grpc_grpc` | 远程通信（间接依赖） |
| gflags | `@com_github_gflags_gflags//:gflags` | 命令行参数 |
| gtest | `@gtest` | 单元测试 |
| console_bridge | `@console_bridge` | 日志桥接 |
| hedron_compile_commands | `@hedron_compile_commands` | compile_commands.json 生成 |

---

## 附录 Z：关联文档索引

| 文档 | 路径 | 内容 |
|-|-|-|
| 数据流向详解 | `data_flow.md` | 输入输出数据的完整链路、上下游组件、Protobuf 类型、坐标变换逻辑、lpcom 通信机制 |
| church 框架与线程模型 | `church_framework_and_threads.md` | church Proc 机制、触发策略、线程交互全景图 |
| 完整线程清单 | `thread_list_full.md` | 25 线程详解、SPSC 队列、mutex 竞争、事件统计、日志系统 |
| 异常检测机制全景 | `anomaly_detection_guide.md` | 5 层检测系统、帧超时/断流超时/传输延时的区别、DEM 事件上报路径 |
| **完整线程清单** | `thread_list_full.md` | 全部 25 个线程的详细说明、创建位置、交互关系图、跨进程通信架构 |
| 断流问题排查报告 | `../sensor_ins_online_investigation_report.md` | 402ms 断流问题的根因分析、MSF 算法分析、Mutex 竞争模型 |

---

## 附录 A：术语表

| 术语 | 全称 | 说明 |
|-|-|-|
| MSF | Multi-Sensor Fusion | 多传感器融合 |
| EKF | Extended Kalman Filter | 扩展卡尔曼滤波 |
| INS | Inertial Navigation System | 惯性导航系统 |
| IMU | Inertial Measurement Unit | 惯性测量单元 |
| GNSS | Global Navigation Satellite System | 全球导航卫星系统 |
| NHC | Nonholonomic Constraints | 非完整性约束 |
| ZUPT | Zero Velocity Update | 零速修正 |
| SPSC | Single-Producer Single-Consumer | 单生产者单消费者队列 |
| SIS | Strapdown Inertial System | 捷联惯导系统 |
| GRS80 | Geodetic Reference System 1980 | 大地参考系统 |
| DEM | Deployment Environment Management | 部署环境管理 |
| church | - | Deeproute 自研组件框架 |
| MCU | Micro Controller Unit | 微控制器（此处泛指嵌入式） |
| dSomeIP | - | Deeproute SomeIP 通信中间件（Smart/GWM/Geely 车型使用） |
| lpcom | Leap Communication | 零跑汽车 IPC 通信 SDK（`liblpCom.so.2`），提供 `WrappedPSChannelFactory` 发布-订阅通道，LP 车型替代 dSomeIP |
