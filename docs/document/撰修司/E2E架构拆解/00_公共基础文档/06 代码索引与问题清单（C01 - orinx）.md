---
title: "06 代码索引与问题清单（C01 / orinx）"
date: 2026-09-20
description: "仓库基准：perception / planning / driver 检出于 Stable_Master_4.0_new；/sandbox/platform/"
categories:
  - 撰修司
tags:
  - E2E
---

# 06 代码索引与问题清单（C01 / orinx）

> **读者对象**：具备 C/C++ 基础、了解自动驾驶基本概念、不熟悉本仓库的开发者。  
> **仓库基准**：perception / planning / driver 检出于 `Stable_Master_4.0_new`；`/sandbox/platform/church` 无该分支，**框架条目基于其 dev_master**（差异已经项目组确认）。所有路径为工作区绝对路径。  
> **本文定位**：全套文档的**随查索引与问题总账**。§1/§2 用于代码阅读定位；§3 汇总全部 34 篇文档标注的未验证项、差异与死代码，按风险分级，是后续排查/开发前必读；§4 记录本套文档的质量校验过程（反幻觉结论）；§5 给出延伸学习建议。

---

## 1. 核心文件索引

### 1.1 框架与启动（00 公共 01 篇）

| 文件 | 职责 | 关键符号 |
|-|-|-|
| /sandbox/driver/integration/mainboard.cc | 主进程入口（仅一行） | `main → church_main` |
| /sandbox/platform/church/mainboard/church_main.cc | 11 步初始化序列 | `church_main()` |
| /sandbox/platform/church/mainboard/church_app.cc | 组件加载与调度启动 | `ChurchApp::Initialize / Run` |
| /sandbox/platform/church/common/arg_parser.cc | 命令行解析（-a/-m/-p/-c/-T） | `ParseSystemArguments` |
| /sandbox/platform/church/component/component.h | 组件基类与静态注册 | `Component / CHURCH_REGISTER_COMPONENT / ComponentRegistry` |
| /sandbox/platform/church/graph/ | 图执行引擎 | `GraphScheduler / FrameSyncCalculator / FrameDoneCalculator / WatchDog` |
| /sandbox/driver/config/dem/c01-pt/perception.jsonnet | E2E 主进程定义（单进程关键证据） | `module_conf`（4 个 jsonnet）/ `RECOVERY_RESET` |
| /sandbox/driver/config/thread_config/C01/perception.json | 线程调度表（t_perception/t_Planning） | `SCHED_RR / cpuset` |

### 1.2 Topic 配置与图定义（00 公共 02 篇）

| 文件 | 职责 |
|-|-|
| /sandbox/driver/config/component/perception_orin.jsonnet | 感知组件通道声明（orin 生效） |
| /sandbox/driver/config/component/planning.jsonnet | 规划组件通道声明（L16 `/planner/context` 在 `context_config`） |
| /sandbox/driver/config/component/perception_graph_l2avp_orin.cfg | 感知主图（FrameSync → 算法子图 → FrameDone OUTPUT:0\~4） |
| /sandbox/driver/config/component/planning_graph.cfg / planning_sub_graph.cfg | 规划主图（`max_queue_size: 15`，L36）/ 子图（5） |
| /sandbox/perception/perception/cfg/perception_orin_l2avp.cfg | C01 感知算法配置总入口（l2avp 模式） |

### 1.3 感知（Perception/ 目录各篇）

| 文件 | 职责 | 关键符号 / 行号 |
|-|-|-|
| /sandbox/perception/perception/church_component/perception_component.cc | 感知组件封装 | `GetPerceptionMode()`（cloud>task_type>默认） |
| /sandbox/perception/perception/graph_api.cc | 图管理器 | `CreateGraphManager / CompleteRegisterAndStart` |
| /sandbox/perception/perception/calculators/perception_input_transform_calculator.cc | 输入装配 | `kInShmpoolTopics`（12 路）/ `FindFirstMessage` |
| /sandbox/perception/perception/sensor/ros_wrapper.cpp | ROS 独立模式订阅（C01 车端不走） | `InitPcdSub` 等 → `AddInput` |
| /sandbox/perception/submodules/camera/ | 相机检测（uni_model 预处理+任务头） | 见子模块1 |
| /sandbox/perception/submodules/lidar/ | 激光雷达检测（heatmap 峰值解码） | 见子模块2 |
| /sandbox/perception/submodules/tracker/ | 多目标跟踪 | 匈牙利关联（见子模块3） |
| /sandbox/perception/submodules/farseer/ | 他车轨迹预测（模型优先、规则兜底） | 见子模块4 |
| /sandbox/perception/submodules/aeb/ | AEB 过滤链 | 见子模块5 |
| /sandbox/perception/submodules/avp/ | 泊车（BEV mighty → MightyFusion） | 见子模块6 |
| /sandbox/perception/submodules/perception_routing/ | 感知路由 | 见子模块7 |

### 1.4 规划（Planning/ 目录各篇）

| 文件 | 职责 | 关键符号 / 行号 |
|-|-|-|
| /sandbox/planning/planning/calculators/planning_input_preprocess_calculator.cc | 输入装配与校验 | `FindLastMessage("/perception/objects")`**L561**；`/planner/context` L163；ras_map L576 |
| /sandbox/planning/planning/planner/planner.cpp | 规划主流程 | `ProcessFrameInitStuff`；耗时打点 L271-275 |
| /sandbox/planning/planning/planner_manager.cpp | EmPlanner 任务链装配（内联工厂） | `CreateXxxTask` |
| /sandbox/planning/planning/frame/ | 帧管理与参考线初始化 | `Frame::Init`（QpSpline OSQP 平滑 ≤3 条） |
| /sandbox/planning/planning/tasks/ | 决策/路径/速度求解任务 | DpPath → DpSpeed → QpSpeed → iLQR（见子模块1） |
| /sandbox/planning/planning/scene_decider/ + scene_sets/ | 场景决策（14 检测器） | 见子模块2 |
| /sandbox/planning/planning/traffic_rules/ + traffic_light_decider/ | 交通规则与红绿灯 | 见子模块3 |
| /sandbox/planning/planning/trajectory_checker/ | 轨迹校验（21 项枚举，仅 EM_PLANNER） | 见子模块4 |
| /sandbox/planning/planning/reference_line_info/ | 参考线信息聚合 | 见子模块5 |
| /sandbox/planning/planning/continuous_object_prediction/ | 预测接入与交互（IBR） | 见子模块6 |
| /sandbox/planning/planning/calculators/planning_post_process_calculator.cc | 输出发布 | FrameDone OUTPUT:0\~12 |

### 1.5 控制与底盘（00 公共 05 篇）

| 文件 | 职责 | 关键符号 / 行号 |
|-|-|-|
| /sandbox/driver/integration/components/cbw_control_component.cc | 控制组件（C01 实际控制域） | 订阅 `/planner/trajectory` L49；发布 `/control/control_command` L71-72 |
| /sandbox/driver/config/component/cbw_control.jsonnet | 控制通道声明 | `expected_proc_duration_ms: 20` |
| /sandbox/driver/integration/components/cbw_canbus_component.cc | 底盘总线组件 | 下发 control_command / 上报 car_state |

## 2. 核心函数索引（按调用时序）

1. `church_main()` → `ChurchApp::Initialize`（LoadModule×4）→ `Run`（GRAPH 调度器 + `WaitForSignal`）——01 篇 §2.2。
2. `FrameSyncCalculator::Process`（100ms 基准对齐 12 路，`kMaxFramesInFlight=2` 背压）——Perception/04。
3. `PerceptionInputTransformCalculator::Process`（FindFirstMessage 装配 `PerceptionProcessInput`）——Perception/01。
4. uni_model 检测 → tracker（匈牙利关联）→ farseer（预测）→ aeb 过滤——Perception 子模块 1\~5。
5. `FrameDoneCalculator`：感知 OUTPUT:0~~4，~~**~~`/perception/objects` 最后发布~~**~~（触发契约）；规划 OUTPUT:0~~12——02 篇 §3。
6. `PlanningInputPreprocessCalculator::Process`（required 四件套缺失硬报错；`/perception/objects` 用 FindLastMessage 取最新帧）——Planning/01。
7. `Planning::ProcessFrameInitStuff`（规则+红绿灯→虚拟墙）→ `Frame::Init`（参考线）→ `EmPlanner` 任务链 → `TrajectoryChecker` → `FallBackPathSpeedSetting`（PATH/SPEED_FALLBACK）→ `PlanningPostProcessCalculator`——Planning/00 §2。
8. `CbwControlComponent::Proc`（pose 触发 20ms 预算）→ `/control/control_command`——05 篇 §2。
