---
title: "07 Planning 代码索引与学习指南"
date: 2026-09-20
description: "适用范围：C01（orinx C01PT，L2_driving）E2E perception mainboard 中的 PlanningComponent。代码"
categories:
  - 撰修司
tags:
  - Planning
  - E2E
---

# 07 Planning 代码索引与学习指南

> 适用范围：C01（orinx C01PT，L2_driving）E2E perception mainboard 中的 PlanningComponent。代码根目录：`/sandbox/planning/planning/`。本篇是索引：给路径、职责、关键函数与阅读顺序，所有关键结论附证据。

---

## 1. 核心文件索引表

### 1.1 根级核心文件（按规模与重要性）

| 文件 | 行数 | 职责 | 关键函数 |
|-|-|-|-|
| planning_core.cpp | 2701 | **Planning** 类主体：组件初始化 + 单帧总控 | `Init()Process()RunOnce()ProcessPlanStuff()ValidateAndPreprocessInputs()` |
| planning_trajectory_process.cpp | 2676 | 轨迹后处理与校验、异常事件映射 | `RunTrajectoryChecker()AddTrajectoryAbnormalEvent()` |
| open_space_planning_async_manager.cpp | 915 | 泊车（OSP）异步规划管理 | `ResetOspFrameForApaReplan()LoadResultForVpaSwitchApa()` |
| planning_frame_management.cpp | 533 | Frame 生命周期管理 | Frame 创建/复位/维护 |
| planning_signal_control.cpp | 520 | 信号灯处理 | 信号灯状态→停车决策 |
| planning_state_management.cpp | 393 | 规划状态机 | L2 状态迁移 |
| planning_collision_check.cpp | 246 | 碰撞检查辅助 | 静态/动态碰撞判定 |
| planning_speed_control.cpp | 205 | 速度控制辅助 | 限速/巡航速度处理 |
| preprocess.cpp | 95 | **MapStitchPreProcess**：拼接地图预处理器 | `MapStitchPreProcess::Process()` |
| planner_manager.cpp/.h | 104/55 | **PlannerManager**：规划器工厂 | 按 `PlannerType` 创建 EM/OSP/倒车规划器 |
| mission_planner.cpp | **0（空文件）** | — | **差异**：基线列出 mission_planner.cpp/.h 为根级文件，.h 存在（126 行）但 .cpp 为空壳，无实现（**差异标注**） |

### 1.2 planner/ 目录（8 文件）

| 文件 | 职责 | 关键函数 |
|-|-|-|
| planner.cpp/.h | **Planner 基类** + 降级/伪轨迹工具 | `Planner::Plan()`（纯虚）`FallBackPathSpeedSetting()`（L10\~86）`GenerateFakeTrajectory()`（L513） |
| em_planner.cpp/.h | **EmPlanner**：主线 EM 规划器 | `Plan()PlanOnReferenceLine()RunTasksStage()`（L587，fallback 判定核心） |
| open_space_planner.cpp/.h | 泊车规划器 | 调用 OpenSpacePlanningAsyncManager 异步搜索 |
| reverse_tracking_planner.cpp/.h | 倒车/循迹规划器 | 倒车场景专用 |

### 1.3 各目录入口文件

| 目录 | 入口文件 | 一句话职责 |
|-|-|-|
| calculators/（5） | planning_input_preprocess_calculator.cc | 图输入节点：装配 **PlanningFrameData**（帧数据包） |
|  | planning_stitch_map_calculator.cc | 加载配置、创建 Planning 实例、拼接地图 |
|  | planning_core_calculator.cc | 调 `planning_->Process()` + **safety/request** 处理 |
|  | planning_post_process_calculator.cc | 输出节点：发布 13 个 topic |
| frame/（29） | frame.h + frame_lifecycle.cpp | **Frame**（单帧世界模型）与生命周期拆分 |
| reference_line_info/（45） | reference_line_provider.cpp（**8265 行，全库最大**） | **ReferenceLineProvider**：路由→参考线生成/平滑 |
|  | reference_line_info.h/.cpp | **ReferenceLineInfo**（参考线上规划状态） |
| tasks/（24 子目录） | dp_path/ qp_speed/ ilqr/ 等 | 任务管线实现（见第 2 节） |
| trajectory_checker/（9） | trajectory_checker.h/.cpp | **TrajectoryChecker** 轨迹校验 |
| traffic_rules/（24） | traffic_rule.h（基类）+ crosswalk/signal_light 等 9 规则 | 交通规则决策 |
| scene_decider/（6） | road_edge/soft_follow_lane/speed_caution_scene_decider | 场景级决策（路沿/跟车/速度谨慎） |
| planning_debug/（11） | planning_debug_handle.h | **DebugHandle** 单例（WriteTrajectoryChecker/WriteBagTrajectory） |
| visualizer/（2） | rviz_visualizer.cpp | rviz 可视化（**adapter 唯一车载引用者之一**） |
| adapter/（4） | adapter_center.h/.cpp | **AdapterCenter**（遗留 ROS 式消息适配，车载未启用） |
| planning_gflags/ | planning/common/planning_gflags.cpp | 全部 DEFINE\_ gflag 默认值 |

### 1.4 图与配置文件（不在 planning 仓库内）

| 文件 | 作用 |
|-|-|
| /sandbox/driver/config/component/planning_graph.cfg | 顶层图：planning_assemble_node→PlanningSubgraph→FrameDoneCalculator |
| /sandbox/planning/planning/config/planning_sub_graph.cfg | 子图：5 calculator 连线 + FRAME_CONTEXT back_edge |
| /sandbox/driver/config/component/planning.jsonnet | 触发/输入/输出通道声明（trigger/required/outputs） |
| /sandbox/driver/config/thread_config/C01/perception.json | 线程名→调度策略映射 |

---

## 2. 核心函数索引（按数据流 8 段分类）

### 2.1 输入装配

| 函数 | 位置 | 职责 |
|-|-|-|
| `PlanningInputPreprocessCalculator::Process()` | calculators/planning_input_preprocess_calculator.cc | FindFirst/LastMessage 装配 PlanningFrameData；required 缺失→InvalidArgumentError；**BLC 限速丢帧保持**（L299\~332） |
| `Planning::ValidateAndPreprocessInputs()` | planning_core.cpp L278\~309 | NaN 检查 + **算法轨迹剥离**（trajectory_bag） |

> 算法轨迹剥离证据（trajectory_bag 的本质：正式轨迹发布前先剥离存副本）：  
> 文件路径：/sandbox/planning/planning/planning_core.cpp  
> 函数名：Planning::ValidateAndPreprocessInputs()
> 
> ```cpp
>   // Handle bag trajectory for trajectory checker validation
>   if (trajectory_pb->trajectory_point_size() > 0 &&
>       FLAGS_enable_algorithm_trajectory) {
>     trajectory_bag.CopyFrom(*trajectory_pb);
>     trajectory_pb->Clear();
>   }
> ```

### 2.2 帧管理

| 函数 | 位置 | 职责 |
|-|-|-|
| Frame 创建/复用/析构 | planning_frame_management.cpp | Frame 生命周期管理 |
| `Frame::Init（拆分四段）` | frame/frame_lifecycle.cpp L4479\~4507 | InitCoreInfrastructure→ProcessTrajectoryAndContext→CreateAndProcessReferenceLines→GenerateSpeedDataAndFinalize |
| `ReferenceLineProvider::UpdateReferenceLine()` | reference_line_info/reference_line_provider.cpp | 路由→原始参考线→平滑（plan_worker 池并行） |

### 2.3 场景决策

| 函数 | 位置 | 职责 |
|-|-|-|
| `Decider/DecisionMaking Task::Execute` | tasks/decider/ tasks/decision_making/ | 任务管线内的决策阶段 |
| `RoadEdgeSceneDecider / SoftFollowLaneSceneDecider / SpeedCautionSceneDecider` | scene_decider/\*.cpp | 路沿/软跟车/速度谨慎三类场景 |
| `TrafficRule::Execute 系列` | traffic_rules/traffic_rule.h + 9 规则 | 人行横道/信号灯/停止线/目的地等 |

### 2.4 任务管线（动态注册）

| 函数 | 位置 | 职责 |
|-|-|-|
| `EmPlanner::EmPlanner()` 组装 tasks_stage\_ | planner/em_planner.cpp L260\~339 | 按 em_planner_config 开关注册任务序列 |
| `Task::Execute`（接口） | tasks/task.h | `virtual Status Execute(Frame*, ReferenceLineInfo*)` |
| `EmPlanner::RunTasksStage()` | em_planner.cpp L587\~734 | 逐任务执行 + **fallback 三级判定** |

### 2.5 路径规划

| 函数 | 位置 | 职责 |
|-|-|-|
| `DP_path` | tasks/dp_path/dp_path_optimizer.cpp | 动态规划路径（sl_grid/path_graph/path_cost 子模块） |
| `QP_path` | tasks/qp_spline_path/ | 二次规划平滑 |
| `ILQR task` | tasks/ilqr/ | iLQR 模型轨迹优化（plan_worker 池 fan-out） |
| `ModelTrajectory` | tasks/model_trajectory/ | 模型输出轨迹解码 |

### 2.6 速度规划

| 函数 | 位置 | 职责 |
|-|-|-|
| `DP_speed` | tasks/dp_speed/dp_speed_optimizer.cpp | ST 图动态规划速度 |
| `QP_speed` | tasks/qp_speed/ | 速度 QP |
| `CombinePathSpeed` | tasks/combine_path_speed/ | 路径+速度→合成轨迹 |
| `SpeedProfileGenerator::GenerateFallbackSpeedProfile` | common/speed/speed_profile_generator.h | 刹停 profile（fallback 用） |

### 2.7 轨迹校验

| 函数 | 位置 | 职责 |
|-|-|-|
| `TrajectoryChecker::RunChecker` | trajectory_checker/trajectory_checker.cpp L39\~ | 17 类可行性校验（碰撞/出线/点数/上游状态…） |
| `Planning::RunTrajectoryChecker` | planning_trajectory_process.cpp L2529\~2580 | 校验入口；`HasInternalFault` 强制放行；写 DebugHandle |
| `Planning::AddTrajectoryAbnormalEvent` | planning_trajectory_process.cpp L1616+ | 校验失败枚举→PLANNING\_\* Event 映射 |

### 2.8 输出

| 函数 | 位置 | 职责 |
|-|-|-|
| `Planner::GenerateAdcTrajectory` | planner/planner.cpp L128\~496 | 最终 ADCTrajectory 生成（含 latency_stats） |
| `Planning::HandleTrajectoryPublishingAndExceptions` | planning_core.cpp L1490\~1518 | 失败帧清空轨迹点、保持档位 |
| `PlanningPostProcessCalculator::Process` | calculators/planning_post_process_calculator.cc | /planner/trajectory 等 13 topic 发布 |

---

## 3. 推荐学习路径

**前置知识**：C++（shared_ptr/atomic/std::list）、protobuf、church 图调度概念（calculator/stream/back_edge，见 04 文档）。

```mermaid
graph LR
    A[Step1 图框架
planning_graph.cfg + planning.jsonnet] --> B[Step2 数据结构
planning_api.h + FrameContext proto]
    B --> C[Step3 单帧主流程
planning_core.cpp RunOnce]
    C --> D[Step4 规划器骨架
planner_manager → em_planner]
    D --> E[Step5 任务管线
tasks/dp_path → dp_speed → combine]
    E --> F[Step6 参考线
reference_line_provider 按需]
    F --> G[Step7 校验与降级
trajectory_checker + planner.cpp fallback]
    G --> H[Step8 专项
open_space 泊车 + traffic_rules]
```

| 步骤 | 读什么 | 目标 |
|-|-|-|
| 1 | planning.jsonnet + planning_graph.cfg + planning_sub_graph.cfg | 弄清触发、输入输出通道、5 calculator 连线 |
| 2 | planning_api.h + frame/context.h | 记住 PlanningFrameData/Output 两个字段包 |
| 3 | planning_core.cpp `Process/RunOnce`（L1330\~1500 附近） | 单帧 9 步骨架：Validate→Plan→Checker→Event→Debug |
| 4 | planner_manager.cpp（104 行）→ em_planner.cpp `Plan/RunTasksStage` | 理解规划器选择与任务序列 |
| 5 | tasks/dp_path、dp_speed 各自 optimizer.cpp | 看懂 DP 主循环即可，不必抠 cost 全部 |
| 6 | reference_line_provider.cpp 只读 `UpdateReferenceLine/Start` | 8265 行文件**不要通读**，按函数查 |
| 7 | trajectory_checker.h 枚举 + planner.cpp `FallBackPathSpeedSetting` | 失败模式与降级产物 |
| 8 | open_space_planning_async_manager.cpp | 异步泊车（对照 04 文档第 5 节） |

---

## 4. 重点难点与常见误区

### 4.1 adapter 体系未启用（遗留代码）

**AdapterCenter** 是 ROS 式消息适配器（订阅/发布抽象），历史上 planning 独立进程用它接 ROS topic：

> 文件路径：/sandbox/planning/planning/adapter/adapter_center.h  
> 逻辑说明：adapter/ 共 4 文件（adapter.h、adapter_center.h/.cpp、factory_instance.h）。E2E 车载路径中消息由 church 图 calculator 直接传递（PlanningFrameData shared_ptr），**不经 adapter**。grep 全库仅 `visualizer/rviz_visualizer.cpp` 与仿真入口（sim_planning_interface）引用 AdapterCenter。**误区：新人从 adapter/ 入手读数据流会完全走偏**——数据流入口是 calculators/planning_input_preprocess_calculator.cc。

### 4.2 任务管线是运行时组装的，不是写死的

> 文件路径：/sandbox/planning/planning/planner/em_planner.cpp  
> 函数名：EmPlanner::EmPlanner()（L260\~339 摘录）
> 
> ```cpp
>   tasks_stage_.push_back(new DPPathOptimizer(...));       // DP_path
>   tasks_stage_.push_back(new QpSplinePathOptimizer(...)); // QP_path
>   if (em_planner_config_.enable_decision_making()) {
>     tasks_stage_.push_back(new DecisionMaking(...));
>   }
>   if (em_planner_config_.enable_model_speed()) {
>     tasks_stage_.push_back(new VpaInitSpeed(...));
>     tasks_stage_.push_back(new IntentionRecognizer(...));
>     ...
>   }
>   tasks_stage_.push_back(new DpSpeedOptimizer(...));
>   tasks_stage_.push_back(new QpSpeedOptimizer(...));
>   tasks_stage_.push_back(new CombinePathSpeed(...));
>   tasks_stage_.push_back(new TrajectorySafety(...));
> ```
> 
> 逻辑说明：**任务顺序 = 构造函数里的 push_back 顺序**，由 jsonnet 开关（enable_model_speed/enable_decision_making 等）裁剪。**误区**：以为 tasks/ 目录文件名即执行顺序，或改了 task 类却忘了在 EmPlanner 构造里注册。

### 4.3 参考线机制与并发

- **ReferenceLineProvider** 是"上游路由 → 帧内参考线"的中间层，持有 `thread_pool_`（即 plan_worker 池，见 04 文档 1.3），平滑任务 Enqueue 并行。
- Frame 持有 `em_reference_line_info_`（std::list<std::`shared_ptr<ReferenceLineInfo>`>），每条参考线独立走一遍任务管线，最后按**代价**选 `selected_reference_line_info()`。
- **误区**：ReferenceLineInfo 不是"车道线"，是"一条可行使走廊上的完整规划状态"；也**不要通读 reference_line_provider.cpp**（8265 行，全库最大），按函数索引查即可。
- vpa_ground_lines/vpa_parking_spaces 等外部更新走互斥锁（`vpa_ground_lines_mtx_`，L437\~443），与主规划线程并发——改动必须考虑锁。

### 4.4 FrameContext 回边与"上一帧记忆"

> 文件路径：/sandbox/planning/planning/config/planning_sub_graph.cfg（L24\~27 摘录）
> 
> ```text
> input_stream: "FRAME_CONTEXT:0:__back_edge__planning_core_node__FRAME_CONTEXT"
> back_edge: true
> ```
> 
> 逻辑说明：`/planner/context`（FrameContext proto）既是发布通道又是**图回边**（back_edge），下一帧输入节点从中取 `last_selected_trajectory` 等做拼接起点。**误区**：找"上一帧轨迹从哪来"时只查订阅者，漏掉同进程内的 back_edge 通道。

### 4.5 其他易错点

| 误区 | 事实 |
|-|-|
| planning 有固定 10Hz 周期 | 无定时器，IMMEDIATE 跟随 /perception/objects（04 文档 2.1） |
| "neutral 轨迹"是一种停车轨迹类型 | 本分支无此 TrajectoryType，对应实现是 SPEED_FALLBACK 刹停 profile（06 文档 2.2 差异标注） |
| expected_proc_duration_ms=500 会掐死超时帧 | 只上报 CHURCH_PROC_TIMEOUT_EVENT，不杀帧（04 文档 2.2） |
| mission_planner.cpp 有实现 | 空文件（0 字节），**差异标注** |
| trajectory_bag 是回放 bag 的输入 | 是**算法轨迹副本**：FLAGS_enable_algorithm_trajectory 开启时正式轨迹先剥离到 trajectory_bag 供校验与调试（见 2.1 证据） |

---

## 5. 调试与验证方法

### 5.1 输出通道速查（可订阅/回放）

| topic | msg_type | 用途 |
|-|-|-|
| /planner/trajectory | deeproute.planning.ADCTrajectory | 主轨迹（控制消费） |
| /planner/trajectory_bag | ADCTrajectory（optional，planning.jsonnet L94\~96） | 算法轨迹副本通道（调试/记录） |
| /planner/debug_info | deeproute.planning.debug.PlanningDebug（L159\~162） | 全量调试信息（可视化主入口） |
| /planner/context | FrameContext | 跨帧上下文（回边 + 下发） |
| /planner/event | 异常事件 | PLANNING\_\* 枚举上报 |
| /planner/stop_objects | 刹停障碍物 | 一帧标记 |
| /safety/request | 安全请求 | TCA_DISABLE/RESET（TTL 控制） |

### 5.2 /planner/debug_info 可视化

- **DebugHandle**（planning_debug/planning_debug_handle.h）是全模块调试信息汇聚单例：轨迹校验结果（`WriteTrajectoryChecker`）、bag 轨迹（`WriteBagTrajectory`）、ILQR 调试（ilqr_debug_handle）、障碍物代价（obstacle_cost_recorder）。
- PlanningDebug proto 随 `/planner/debug_info` 发布，可用 rviz（visualizer/rviz_visualizer.cpp）或平台回放工具按帧查看：参考线、ST 图、路径代价、校验失败原因。
- 证据：

> 文件路径：/sandbox/planning/planning/planning_trajectory_process.cpp  
> 函数名：Planning::RunTrajectoryChecker()（L2571\~2577）
> 
> ```cpp
>   DebugHandle::GetInstance()->WriteTrajectoryChecker(trajectory_passed_checker,
>                              traj_checker_fail_reasons, traj_checker_debug);
>   if (trajectory_bag != nullptr && FLAGS_enable_algorithm_trajectory) {
>     DebugHandle::GetInstance()->WriteBagTrajectory(
>         trajectory_bag->trajectory_point());
>   }
> ```

### 5.3 gflags 调整

- gflags 默认值集中定义于 planning_gflags/planning/common/planning_gflags.cpp；jsonnet 叠加链入口 `parse_config`（默认 "/planning/config/planning/planner_normal_operating.jsonnet"，见 planning_gflags/tests/run_gflags.cpp L52-53）。
- 与 trajectory_bag 直接相关的开关：`FLAGS_enable_algorithm_trajectory`（校验用副本与 /planner/trajectory_bag 的总开关）。
- 调参优先级：车端 jsonnet（车型风格包）> planning_internal_config.jsonnet > 代码 DEFINE\_ 默认值（见 03 文档 3.2）。

### 5.4 bag 回放验证

1. 回放含 /perception/objects、/canbus/car_state、/map/ras_map_plus、/perception/traffic_lights_status（required 四件套）的 bag，观测 /planner/trajectory 是否出帧。
2. 若无输出，按 06 文档第 1 节排查：MLOG "is required, but not found" → NaN → 无路由（PLANNING_INPUT_ROUTING_INVALID）。
3. 单帧耗时看 `/planner/trajectory` 内 `latency_stats.total_time_ms`（planner.cpp L271\~275 打点）与 "FRAME END" 日志（post_process calculator）。
4. 降级确认：TrajectoryType == PATH_FALLBACK/SPEED_FALLBACK + /planner/event 中 PLANNING_OUTPUT\_\* 枚举。
5. 卡帧排查：graph_watch_dog 日志 "There is no incoming frame"（>1s 无帧）+ CHURCH_PROC_TIMEOUT_EVENT（>500ms）。

### 5.5 最小验证闭环（推断）

改 tasks/ 内任一 Task 后：编译 → 用 tests/ 下示例或 sim_planning_interface（adapter 仿真入口）单跑 Planning → 对比 /planner/debug_info 前后差异。此路径为**推断**（基于 tests/ 目录与 sim 入口存在），未在本机执行验证。

---

> 索引篇完。配套阅读：03（数据结构/配置）、04（线程/周期）、06（异常/降级）。
