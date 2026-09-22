---
title: "00 架构总览与学习指南（C01 / orinx）"
date: 2026-09-20
description: "仓库基准：perception / planning / driver 检出于 Stable_Master_4.0_new；/sandbox/platform/"
categories:
  - 撰修司
tags:
  - E2E
---

# 00 架构总览与学习指南（C01 / orinx）

> **读者对象**：具备 C/C++ 基础、了解自动驾驶基本概念、不熟悉本仓库的开发者。  
> **仓库基准**：perception / planning / driver 检出于 `Stable_Master_4.0_new`；`/sandbox/platform/church` 无该分支，**框架代码基于其 dev_master**（差异已经项目组确认）。所有路径为工作区绝对路径。  
> **本文定位**：全套文档的入口。先读本文建立全局图景，再按 §4 学习路径进入各分册。

---

## 1. 项目背景与架构定位

本仓库是某自动驾驶公司车端（**orinx 平台**＝QNX + NVIDIA Drive Orin）的量产软件工作区。本文档集分析的目标车型为 **C01PT（C01）**，运行 **L2AVP** 方案（**L2** 行车辅助 + **AVP** 自动泊车，DEM 注入 `/task/task_type=L2_driving`）。

**核心架构形态：单进程端到端（E2E）**。与"感知、规划各自独立进程、经总线通信"的分布式架构不同，C01 把感知（Perception）与规划（Planning）两个业务组件装进**同一个 mainboard 进程**（`/sandbox/driver/config/dem/c01-pt/perception.jsonnet` 的 `module_conf` 同时装载两模块配置），同进程内组件经 church channel 直通通信（跨进程才走 iceoryx 共享内存）。

| 维度 | 单进程 E2E（本仓库 C01） | 典型分布式架构 |
|-|-|-|
| 模块边界 | 进程内组件 + graph 子图（边界清晰但共享进程资源） | 独立进程，故障域隔离 |
| 通信延迟 | 进程内 channel 直通，无序列化开销 | 跨进程/跨节点，有 IPC 开销 |
| 数据一致性 | 同进程共享线程池/时钟，帧同步简单 | 需跨节点时间对齐 |
| 部署耦合 | 感知崩溃会连带规划重启（RECOVERY_RESET） | 可单独重启 |

适用场景：算力集中在一块 Orin 平台、强调感知→规划低延迟闭环的 L2+/AVP 量产方案。

## 2. 整体架构图

要点：① 感知输出 5 路 Topic，`/perception/objects`**最后发布**作为规划触发（时序契约）；② 规划输出 `/planner/trajectory`（`deeproute.planning.ADCTrajectory`）给控制，并回灌感知做预测；③ 车辆状态 `/canbus/car_state` 回流闭环。

## 3. 核心目录结构

```
/sandbox/                          多 git 仓库工作区
├── driver/                        启动与集成（分支 Stable_Master_4.0_new）
│   ├── integration/mainboard.cc   主进程入口 → church_main
│   ├── integration/components/    全部组件封装（perception/planning/cbw_control/cam/aeb…）
│   └── config/                    全部车端配置
│       ├── dem/c01-pt/            进程启动配置（jsonnet：二进制/参数/恢复策略）
│       ├── component/             组件通道配置（jsonnet）+ graph 定义（*.cfg）
│       ├── thread_config/C01/     线程调度策略（cpuset/优先级）
│       └── stream_config/C01/     church 流优先级
├── platform/church/               中间件框架（分支 dev_master，无 Stable_Master_4.0_new）
│   ├── mainboard/                 church_main / ChurchApp / 配置装配
│   ├── component/                 Component 基类 / 注册宏 / 触发器
│   ├── graph/                     GraphScheduler / FrameSync / FrameDone / WatchDog
│   ├── node/                      Node 与 iceoryx/intra 传输
│   └── scheduler/ task/ module/   DDL 调度 / 任务 / 上报
├── perception/                    感知仓库
│   ├── perception/                感知顶层：calculators/ triggers/ frame_context/ pipeline/ sensor/ church_component/
│   └── submodules/                算法子模块：camera/ lidar/ tracker/ farseer/ aeb/ avp/ perception_routing/ base/
├── planning/                      规划仓库（planning/ 下为全部业务代码）
│   ├── calculators/ adapter/ frame/  输入输出装配 / 历史adapter(onboard未启用) / 帧管理
│   ├── planner/ tasks/            规划器与任务管线（决策/路径/速度/iLQR）
│   ├── scene_decider/ scene_sets/ traffic_rules/ traffic_light_decider/  场景与规则
│   ├── reference_line_info/ continuous_object_prediction/ trajectory_checker/  参考线/预测/校验
│   └── planning_gflags/ config/ visualizer/ planning_debug/
├── proto_msg/                     全部 proto 消息定义
└── common/                        公共库（线程管理 ThreadManager、日志 spdlog/glog 等）
```

## 4. 学习路径（推荐阅读顺序）

**阶段0 前置知识**：C++（shared_ptr/lambda/模板）、**protobuf**、**bazel**、**jsonnet** 配置语言、mediapipe 图执行概念（Calculator/InputStream）。

| 阶段 | 阅读顺序 | 目标 |
|-|-|-|
| 1 框架 | 01_进程启动与 Church 框架初始化链路 → 02_模块配置与 Topic 数据流拓扑 | 搞清"进程怎么起来、数据怎么流动" |
| 2 感知 | Perception/00 总览 → 01 输入 → 子模块1 camera → 子模块2 lidar → 子模块3 tracker → 子模块4 farseer → 子模块5 aeb → 子模块6 avp → 子模块7 routing → 03/04 数据结构与线程 → 05 输出 → 06 异常 | 掌握感知全链路与算法子模块边界 |
| 3 规划 | Planning/00 总览 → 01 输入 → 子模块1 planner_tasks → 子模块2 scene → 子模块3 traffic_rules → 子模块5 参考线 → 子模块6 预测 → 子模块7 泊车 → 子模块4 轨迹校验 → 03/04 数据结构与周期 → 05 输出 → 06 降级 | 掌握规划主流程与降级体系 |
| 4 闭环 | 05_端到端全链路时序与异常机制 | 把两模块串成一条时间轴 |
| 随查 | 06_代码索引与问题清单、各册 07 索引 | 代码阅读时定位文件/函数 |

**重点模块**（面试/排查高频）：FrameSyncCalculator 帧同步与背压（感知入口）、uni_model 统一检测（camera/lidar 主体）、EmPlanner 任务链与 iLQR（规划核心）、TrajectoryChecker 与 PATH/SPEED_FALLBACK（安全降级）。  
**常见误区**：① farseer 是**轨迹预测**不是占用网络；② planning 的 `adapter/FactoryCenter` 是 sim/debug 遗产，onboard 不走；③ `mission_planner.cpp` 为 0 字节死代码；④ `control_component.cc` 为空文件，控制走 CbwControlComponent；⑤ t_perception/t_Planning 组件线程在 graphpipe 模式下不直接处理帧（帧处理在图执行线程池）。

## 5. 关键名词速查表

| 名词 | 解释 |
|-|-|
| **Church** | 车端中间件框架：组件化 + 图调度 + channel 消息传输 |
| **Component / Node** | church 组件基类（生命周期 Init→Startup→Proc→Shutdown）/ 组件的消息收发上下文 |
| **graphpipe / CalculatorGraph** | mediapipe 风格有向图执行引擎；**Calculator** 为图中节点 |
| **FrameSyncCalculator** | 帧同步节点：按 100ms 基准对齐 12 路图像+点云 |
| **FrameDoneCalculator** | 帧完成节点：按配置顺序发布输出流（感知 OUTPUT:0~~4 / 规划 OUTPUT:0~~12） |
| **Trigger** | 触发策略：IMMEDIATE（到达即触发）/ FRAMESYNC / PERIODIC |
| **DEM / DrDEM / dem_launch** | QNX 侧进程守护启动器及其配置驱动 |
| **mainboard** | 车端主进程二进制（`driver/integration/mainboard.cc`） |
| **jsonnet** | JSON 超集配置语言；DEM 配置=进程定义，component 配置=通道声明 |
| **Topic / Channel** | 以字符串命名的消息通道，如 `/perception/objects` |
| **OnboardMessage / shm pool** | church 消息封装 / 共享内存池（点云等大块数据零拷贝） |
| **iceoryx** | 跨进程共享内存传输中间件 |
| **GraphManager** | 感知图管理器（graph_api.cc），两种进程形态共用 |
| **uni_model** | 多模态统一 NN 模型（camera+lidar 共用主干） |
| **RASMap / ras_map_plus** | 感知实时语义地图 proto / map_engine 增强版 |
| **tracker / farseer** | 多目标跟踪（匈牙利关联）/ 他车轨迹预测（模型优先规则兜底） |
| **AVP / AEB / BLC / CBW** | 自动泊车 / 自动紧急制动 / 业务逻辑控制 / 线控底盘域 |
| **HPI / VPA** | 人机规划接口 / 车位状态特征（泊车触发） |
| **EmPlanner / Task** | 规划主规划器（参考线级迭代）/ 任务基类（决策/路径/速度/iLQR） |
| **DP / QP / iLQR** | 动态规划 / 二次规划 / 迭代线性二次调节器（轨迹优化三类求解器） |
| **ST 图 / SL 栅格** | 时间-路程图（速度规划）/ 路程-横向图（路径规划） |
| **ReferenceLineInfo** | 参考线及其上的路径/速度/决策聚合体 |
| **ADCTrajectory** | 规划输出轨迹 proto（`deeproute.planning.ADCTrajectory`） |
| **TrajectoryChecker / Fallback** | 轨迹可行性门卫（21 项枚举）/ 校验失败降级（PATH_FALLBACK/SPEED_FALLBACK） |
| **WatchDog / RECOVERY_RESET** | 图无帧看门狗（1s 告警）/ DrDEM 崩溃重启策略 |
| **EM 状态机 / task_type** | 整车功能状态（kDriving/kParking 等）/ 任务类型（L2_driving） |
| **cpuset / SCHED_RR** | CPU 亲和集 / 轮转实时调度策略（线程表按线程名匹配） |

## 6. 分析说明（分支、车型、配置与假设差异）

**分析范围**：分支 `Stable_Master_4.0_new`（perception/planning/driver 均已确认）；车型 C01PT（orinx，`/task/task_type=L2_driving`，感知模式 l2avp）；配置以 `driver/config/` 下 c01-pt/C01/C01-PT 目录为准，优先级高于通用配置。

**先验假设验证结论**：

1. "单进程 E2E，perception 与 planning 同进程"——**成立**（dem/c01-pt/perception.jsonnet 同一二进制装载两模块配置；thread_config 同一进程表定义 t_perception/t_Planning；详见 01 篇 §3.4）。
2. "church 中间件组织"——**成立**（mainboard + Component + GraphScheduler）。
3. "启动配置位于 /sandbox/driver"——**成立**（进程级在 config/dem/c01-pt，模块级在 config/component）。
4. perception/planning 根目录——**成立**。

**与先验/直觉不符的已证实差异**（详见 06 问题清单）：church 仓库无 Stable_Master_4.0_new 分支（用 dev_master）；tracker/farseer/base 三个 perception 子仓检出于 Stable_Master_3.2（repo 子仓管理差异）；`mission_planner.cpp`、`control_component.cc` 为 0 字节空文件；farseer 实为轨迹预测模块；`/planner/signals_request` 为无发布者死通道。

**标注约定**：全文"**推断"＝由配置/代码间接推出；"未验证"＝仓库内无直接证据；"差异**"＝与先验假设或阶段基线不符并附证据。
