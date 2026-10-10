---
title: "00 Planning 模块架构总览"
date: 2026-09-20
description: "规划模块架构总览：从 /perception/objects 触发到轨迹输出的主流程与子模块地图。"
categories:
  - 撰修司
tags:
  - Planning
  - E2E
---

> **30 秒导读**：规划模块的地图：从收到 /perception/objects 触发到吐出轨迹的完整主流程。
> **本篇回答**：规划一个周期做哪些事？内部怎么分班？从哪个函数进入？
> **先修阅读**：《00 入门》§3 步骤 8~10；《Perception 05 输出》。

> **本篇概念速成块**（30 秒，读完再进正文不卡壳）：
> - **Frame（规划帧）**：本帧的工作台——参考线、障碍物、红绿灯这些"料"装配好，等任务上台。
> - **Task 管线**：干活大军——300 多个任务按配置排成流水线，一道工序接一道（粗算路径→精修速度→…）。
> - **参考线**：先选路线再谈开车——从地图生成的候选路线（最多 3 条），规划的全部文章都沿它做。
> - **EmPlanner**：行车主考官——路径与速度两道大题交替迭代求解。
> - **轨迹校验**：成品质检——21 项检查不过关就拦下进降级，绝不硬开。


> 分析对象：C01 车型（orinx 平台 C01PT，`/task/task_type=L2_driving`）E2E 主链路中的规划模块。  
> 分支说明：perception / planning / driver 仓库均在 `Stable_Master_4.0_new`（当前检出即目标分支）；platform / church 在 `dev_master`，涉及差异处已标注。  
> 本篇为 Planning 系列文档的总览篇，输入细节见《01_输入数据接入与有效性校验》，输出细节见《05_输出发布与控制指令生成》。

---

## 1. 模块定位与职责

**一句话结论**：规划是 E2E 链路的"大脑"：被感知的最后一路输出唤醒，在 500ms 预算内把"我看到的世界"翻译成"未来轨迹"交给控制。

**为什么规划值得单独拆解**：感知与控制之间隔着一层「决策」——同样看到前方 30 米有车，跟车缓刹、变道绕行还是停车，是不同决策；这层「怎么开」的智能全部在规划里。它也是 E2E 全链路里最复杂的一环：500ms 内要跑 300 多个任务、算三种候选路线、对每个障碍物做决策——本系列文档就是把这台机器逐层拆开给你看。

**Planning（规划）** 模块是 E2E 行车链路的"大脑"：接收感知、定位、地图、底盘等上游数据，在每个感知帧上完成参考线生成、场景决策、路径/速度规划与轨迹校验，输出车辆未来轨迹 `/planner/trajectory`（**ADCTrajectory**，即规划给控制的轨迹消息），由控制模块（CbwControl）闭环执行。

**规划在大循环中的位置**：回忆《00 入门》§3 的 0.1 秒循环——感知"看"、规划"想"、控制"动"。规划站在中间：感知 FrameDone **最后发布** `/perception/objects` 时（发令枪），规划被 IMMEDIATE 策略立刻唤醒，在 500ms 预算内完成"选路线→定决策→算轨迹→过安检"，把轨迹交给控制。本文 §3 的流程图就是这 500ms 里发生的事。

它不是独立进程，而是**挂在 perception mainboard 主进程内的一个组件**：

> 文件路径：/sandbox/driver/config/component/planning.jsonnet  
> 核心逻辑：
> 
> ```jsonnet
> {
>     "components": [
>         {
>             "class_name": "PlanningComponent",
>             "config": {
>                 "name": "Planning",
>                 "task": {
>                     "name": "t_Planning",
>                     "expected_proc_duration_ms": 500,
>                     "graph_config_path": "planning/config/planning_graph.cfg",
>                     "trigger_channels": [ "/perception/objects" ],
>                     "trigger_policy": "IMMEDIATE",
>                     ...
> ```
> 
> 逻辑说明：`PlanningComponent` 以图配置 `planning_graph.cfg` 挂载进 GRAPH（graphpipe/mediapipe 风格）调度器，触发源为 `/perception/objects`，触发策略 IMMEDIATE（**立即触发**：消息到达立即进入装配，不做周期对齐）。

组件壳本身极薄，业务全部在图中的 Calculator 内：

> 文件路径：/sandbox/driver/integration/components/planning_component.cc  
> 函数名：PlanningComponent::Proc()  
> 核心逻辑：
> 
> ```cpp
> bool PlanningComponent::Proc(const OnboardMessageConstPtrVector&,
>                              OnboardMessagePtrVector*) {
>   return true;   // 组件 Proc 为空实现
> }
> ```
> 
> 逻辑说明：`Init()` 只注入 side packet（`city`、`task_type`、`publish_handle` 发布回调，L56-78），`Proc()` 为空——数据流与规划逻辑完全由 `planning_graph.cfg` 声明的 Calculator 图承担（见第 3 节）。

线程归属（与调度配置一致）：

> 文件路径：/sandbox/driver/config/thread_config/C01/perception.json  
> 核心逻辑：
> 
> ```json
> { "name": "t_Planning",        "policy": "SCHED_RR", "priority": 5, "cpuset": "1-5" },
> { "name": "plan_main",         "policy": "SCHED_RR", "priority": 5, "cpuset": "1-5" },
> { "name": "plan_worker",       "policy": "SCHED_RR", "priority": 5, "cpuset": "1-5" },
> { "name": "plan_stitch",       "policy": "SCHED_RR", "priority": 5, "cpuset": "1-5" },
> { "name": "planning_executor", "policy": "SCHED_RR", "priority": 5, "cpuset": "1-5" },
> { "name": "open_space_worker", "policy": "SCHED_RR", "priority": 5, "cpuset": "1-5" }
> ```
> 
> 逻辑说明：规划组件任务线程 `t_Planning` 与图执行器线程 `planning_executor`（`planning_graph.cfg` 中 `executor` 声明，3 线程）等均绑定 CPU 1-5，实时策略 **SCHED_RR（轮转实时调度）**/优先级 5。

---

## 2. 子模块划分

**一句话结论**：规划模块 ＝ 一个薄组件壳 ＋ 五级图流水 ＋「Frame 装配 → 参考线 → 场景决策 → 任务管线 → 轨迹校验」的业务主线；327 个文件的大头在 tasks/。

**目录表里的 AI 名词**：tasks 表里的 dp_path/dp_speed 是**动态规划**（DP，把大问题拆成阶段递推求最优，见 [**AI 字典·动态规划 DP**](../../../正典阁/技术栈/AI/动态规划%20DP.md)）；qp_path/qp_speed 与参考线平滑是**二次规划**（QP，带约束的连续优化，见 [**AI 字典·二次规划 QP**](../../../正典阁/技术栈/AI/二次规划%20QP.md)）；ilqr 是 **iLQR**（基于模型的轨迹优化，见 [**AI 字典·iLQR 与 LQR**](../../../正典阁/技术栈/AI/iLQR%20与%20LQR.md)）——三种优化算法在 §2 表中首次同台，§4 概念卡还会遇到 EM。

以下按 `/sandbox/planning/planning/` 实际目录逐项给出职责（文件数为当前检出实测，职责列为白话版）：

| 目录 | 文件数 | 人话职责 |
|-|-|-|
| `calculators/` | 5 | 五级流水线的五个大工位：收货（输入预处理）→拼地图→干核心规划活→处理请求→打包发货（后处理） |
| `frame/` | 29 | **Frame（规划帧）**：本帧开工前的工作台——把参考线、障碍物、交通灯这些"料"一样样摆好 |
| `tasks/` | 327 | **Task（规划任务）管线**：干活大军——先粗算路径（dp_path）再精修（qp/ilqr）、算速度（dp_speed/qp_speed）、换道决策、轨迹安全，一道工序接一道 |
| `planner/` | 8 | 三位"主考官"：行车找 EMPlanner、泊车找 OpenSpacePlanner、倒车找 ReverseTrackingPlanner |
| `reference_line_info/` | 45 | **ReferenceLineInfo（参考线信息）**：每条候选路线一本"投标书"，这条线上的路径/速度/决策全夹在里面 |
| `scene_decider/` | 6 | 分诊台：先判断现在是什么局面（跟车？cut-in？泊车？）再分科处理 |
| `scene_sets/` | 41 | 各科室：每个场景一套专门解法（跟车、cut-in、泊车等） |
| `traffic_rules/` | 24 | **TrafficDecider（交通规则决策）**：考场纪律员——红灯停、限速压、人行道让行，规矩先过一遍 |
| `traffic_light_decider/` | 2 | 红绿灯专职岗 |
| `trajectory_checker/` | 9 | **TrajectoryChecker（轨迹校验器）**：成品质检——21 项检查不过关就拦下 |
| `continuous_object_prediction/` | 14 | 预判他车下一步怎么走 |
| `planning_debug/` | 11 | 行车记录仪：把规划内部每步结果记下来发出去，方便回放排查 |
| `adapter/` | 4 | 老代码遗存（FactoryCenter），车端未启用（读代码可跳过，见《01》篇第 6 节） |
| `visualizer/` | 2 | 画板：把结果画成 RViz 可视化标记 |
| `common/`、`config/`、`planning_gflags/`、`proto/` 等 | — | 后勤仓库：公共工具、配置、gflags、proto 定义 |
| `post_process_intervention_reporter/` | 5 | 接管上报器：人工接管事件的后处理上报 |
| `human_planning_interface/`、`sim_planning_interface/`、`accessory_process/`、`tests/` 等 | — | 人机接口、仿真接口、辅助进程、测试 |

> **📘 概念｜Frame（规划帧）**
> **是什么**：规划一个周期的工作现场：本帧拿到的所有原料——参考线、障碍物、交通灯、自车状态、VPA 状态——全部装配进这一个 Frame 对象；后面的决策、规划全部对着它干。
> **类比**：开工前的工作台——把图纸（参考线）、料件（障碍物）、通知单（红绿灯）一样样摆好，工人（Task）只管上台干活。
> **🎯 为什么这样设计**：把"一次规划需要的全部输入"收进一个对象，任务的函数签名就固定成 `Execute(Frame*, ReferenceLineInfo*)`（§4 Task 证据块）——新增输入不必改动几百个 Task 的接口。
> **🗂 代码在哪里**：`planning/frame/`（29 个文件）；装配入口 `InitFrame`（14 步主流程第 8 步"准备 RunOnce"内，§3）。

> **📘 概念｜Task 与任务管线**
> **是什么**：Task 是规划的最小算子单元——"对某条参考线做一道工序"，如 dp_path（粗算路径）、qp_speed（精修速度）、lane_change_decider（换道决策）。300 多个 Task 按配置排成管线，依次执行，前一道工序的产出就是下一道的原料。
> **类比**：作业流水线：冲压→焊接→喷涂→质检，每道工序独立、顺序固定、逐件加工。
> **🎯 为什么这样设计**：把"先算什么后算什么"写成配置而不是硬编码——增删一个算法步骤＝管线配置改一行；每道工序单独可测、可临时禁用（调试时跳过某个 Task 是常规操作）。
> **🗂 代码在哪里**：`tasks/task.h`（Execute 接口，§4 证据块）；管线全貌见《子模块1：planner 与 tasks 决策规划任务管线》。

> **📘 概念｜ReferenceLineInfo（参考线信息）**
> **是什么**：一条候选参考线 ＋ 挂在这条线上的全部工作产物：路径方案、速度方案、对每个障碍物的决策、各种代价分。规划对每条候选线各建一个 ReferenceLineInfo，各自完整走一遍任务管线，最后按代价择优一条作为最终输出。
> **类比**：每条候选路线一本"投标书"：路线怎么走、开多快、对每辆车怎么处理、综合得分多少——评委（规划器）挑得分最高的那份。
> **🎯 为什么这样设计**：多条候选并行评估再择优，比"一开始就赌一条线"鲁棒——某条线因施工堵死时，另两条还是完好的备选。
> **🗂 代码在哪里**：`reference_line_info/`（45 个文件）；生成与平滑见《子模块5：reference_line_info 参考线子模块》。

> **📘 概念｜EmPlanner（行车规划器）**
> **是什么**：C01 行车场景的主规划器（Planner 接口的实现之一，另有泊车 OpenSpacePlanner、倒车 ReverseTrackingPlanner）。它把规划拆成"路径"与"速度"两半：沿每条参考线先定路径再优化速度，反复迭代直到收敛——EM 即[**期望最大化**](../../../正典阁/技术栈/AI/期望最大化%20EM.md)（Expectation-Maximization）的迭代思想（求解路径时假设速度已知、求解速度时假设路径已知，两步交替逼近）。
> **类比**：主考官面试两道大题：先答"横向走哪条道"（路径），再答"纵向开多快"（速度），答完发现互相矛盾就再迭代一轮。
> **🎯 为什么这样设计**：路径与速度强耦合（变道决策影响速度曲线），但联合求解维度爆炸——拆成两半交替迭代，每次只解低维问题，收敛快且可解释（每步中间结果都能打印排查）。
> **🗂 代码在哪里**：`planner/`（8 个文件）；`PlannerManager` 按场景分发（§4 类图与证据块）；任务管线细节见《子模块1》。

根级核心文件职责表：

| 文件 | 职责 |
|-|-|
| `planning_core.cpp`（2702 行） | **Planning 类**主实现：14 步 `Process()` 主流程、`RunOnce()`、异常事件等 |
| `planning.h` | `Planning : public IPlanningProcessor` 类声明与成员 |
| `planning_api.h` | 对外接口：`IPlanningProcessor`、`PlanningFrameData`、`CreatePlanningProcessor()` C 工厂 |
| `planner_manager.cpp/.h` | **PlannerManager（规划器管理器）**：按 HPI 输入在 3 种规划器间选择/切换 |
| `planning_frame_management.cpp` | `InitFrame`、`ProcessFrameInitStuff`（帧初始化+交通规则决策） |
| `planning_planner_management.cpp` | 规划器生命周期管理 |
| `preprocess.cpp` | `PlanningPreProcessBase` 实现（rasmap 拼接、道路 mask 解码） |
| `planning_trajectory_process.cpp` | 轨迹后处理（stitch 点、轨迹点加工） |
| `mission_planner.cpp/.h` | 任务级（mission）规划 |
| `open_space_planning_async_manager.cpp/.h` | 泊车异步规划管理 |
| `planning_collision_check.cpp`、`planning_speed_control.cpp`、`planning_signal_control.cpp` 等 | 碰撞检查、速度/灯语控制等专项逻辑 |

---

## 3. 整体处理流程图

**一句话结论**：一帧规划的旅程是「触发汇聚 → 子图五级流水（预处理→地图拼接→核心规划→后处理）→ FrameDone 发布 13 路输出」，核心规划在第三级。

> **📘 概念｜参考线 ReferenceLine**
> **是什么**：规划的空间骨架——从地图车道中心线生成、经平滑（QpSpline/OSQP）后的候选路线，最多保留 3 条。规划不是在空地上随便画线，而是先选一条参考线，再在这条"轨道"上做路径与速度的全部文章。
> **类比**：导航 App 给你的两三条候选路线——先选走哪条，再谈这条路上怎么开（跟车、超车、让行）。
> **🎯 为什么这样设计**：把二维平面上的自由寻路降维成"沿已知路线的一维问题"（线上的位置 s），搜索空间骤减、实时性才做得到；地图约束（车道边界）天然内建。
> **🗂 代码在哪里**：生成与平滑见《子模块5：reference_line_info 参考线子模块》；下游挂载方式见 §4 类图的 Frame o-- ReferenceLineInfo。

以代码为准的端到端数据流（图配置见 `planning_graph.cfg` 与 `planning/planning/config/planning_sub_graph.cfg`）：

```mermaid
graph TB
    A[上游 Topic: 感知/定位/地图/BLC] --> B[ChannelCache 通道缓存]
    B --> C[AnyCalculator
planning_assemble_node
TRIGGER:0:perception__objects
FINISHED back edge 防重入]
    C -->|planning_input: 排序后消息向量| D[PlanningSubgraph 子图]
    subgraph planning_sub_graph
        D --> E[PlanningInputPreprocessCalculator
逐 topic 解析→PlanningFrameData]
        E --> F[PlanningStitchMapCalculator
建 Planning 对象/地图拼接/
初始轨迹+LocalRouting]
        F --> G[PlanningCoreCalculator
IPlanningProcessor::Process
14 步核心规划]
        G --> H[PlanningPostProcessCalculator
组装 topic→msg 映射]
    end
    H -->|planning_output| I[FrameDoneCalculator
planning_frame_done_node]
    I -->|OUTPUT:0~12| J[node Publish 发布各输出 Topic]
    I -->|TRIGGER: planning_done| C
    G -->|FRAME_CONTEXT back edge 自回灌| E
```

**图 3-1 · 规划一帧的完整数据流**（图配置：`planning_graph.cfg` ＋ `planning_sub_graph.cfg`，方框内为 Calculator 名）

**读图三提示**：① `TRIGGER:0:perception__objects` 与 `FINISHED back edge 防重入` 是本图灵魂——AnyCalculator 用它保证"上一帧没算完绝不接新活"（天然背压，读不懂这两条边就读不懂图）；② 子图内部五级流水是**每帧重复**的完整旅程，`FRAME_CONTEXT back edge 自回灌` 是规划给自己留的状态接力（上一帧上下文喂给下一帧装配）；③ 出口 `OUTPUT:0~12` 对应 §5 的 13 个输出 Topic——轨迹只是其中之一，debug/context 等同帧一起发布。

关键节点说明：

- **AnyCalculator**（`planning_assemble_node`）：触发汇聚器。收到新触发消息且上一帧已 `FINISHED` 才会重新装配（`any_calculator.cc:115-133`）；输出 `planning_input`（按 topic 排序的 `OnboardMessageConstPtrVector`）。
- **PlanningSubgraph** 是 cfg 中声明的**子图**（非 C++ 类）：`planning_sub_graph.cfg` 首行 `# subgraph name: PlanningSubgraph`，由 `planning_graph.cfg` 的 `node { calculator: "PlanningSubgraph" }` 引用。
- **PlanningCoreCalculator** 调用核心规划对象 `IPlanningProcessor::Process()`（实现类为 `Planning`），完成参考线→决策→任务管线→轨迹校验的 14 步流程。

> 文件路径：/sandbox/planning/planning/calculators/planning_core_calculator.cc  
> 函数名：PlanningCoreCalculator::Inference()  
> 核心逻辑：
> 
> ```cpp
> planning_->Process(
>     input_data.plan_with_context, *input_data.tl_response_,
>     input_data.vehicle_state_, input_data.frame_context_, local_routing,
>     map_msg, road_mask_decoder, stitch_map_thread_pool_,
>     *input_data.perception_objects_extra_, *input_data.fusion_map_,
>     sd_horizon_map, input_data.perception_obstacles_.get(),
>     input_data.magic_carpet_perception_,
>     output_data.trajectory.get());
> ProcessSafetyRequest(output_data);
> ...
> output_data.frame_context_ = planning_->GetFrameContext();
> ```
> 
> 逻辑说明：核心规划结果写回 `PlanningFrameDataOutput`（轨迹、debug、response、semantic_info、stop_obstacles 等），随后交由 `PlanningPostProcessCalculator` 组装、`FrameDoneCalculator` 发布。

`Planning::Process()` 的 14 步主流程（`planning_core.cpp:1299-1442`）：1 输入验证 → 2 系统初始化 → 3 路由处理 → 4 设置 FrameContext → 5 感知对象处理 → 6 调试信息 → 7 HPI 前置 → 8 准备 RunOnce → 9 HPI 后置 → **10 `RunOnce()`** → 11 后台 OSP → 12 轨迹后处理 → 13 控制模式设置 → 14 最终处理。其中 `RunOnce()`（`planning_core.cpp:201-275`）内部依次为：`InternalRun()`（帧初始化 `ProcessFrameInitStuff` 含 `InitFrame`+`traffic_decider_.Execute`，核心规划 `ProcessPlanStuff` 即 `planner_->Plan(frame_)`）→ `ExecuteTrajectoryValidation()`（**TrajectoryChecker 轨迹校验**）→ 意图/语义/异常事件处理。

---

## 4. 核心类图

> **预备课：怎么读这张类图**。类图描述的是"代码里谁持有谁、谁实现谁"的**静态关系**，不描述时间顺序（那是 §3 流程图的事）。读图口诀三步：先找**接口**（`<<interface>>` 标记，定义"能做什么"）→ 再看**实现与持有**（实线箭头＝持有成员，虚线＝依赖/实现）→ 最后对照下方证据块确认每个关系都有代码出处。本图五层自上而下正好是一条调用链：组件壳 → 核心对象 → 规划器管理器 → 具体规划器 → 帧/任务。

```mermaid
classDiagram
    class PlanningComponent {
        +Init() bool
        +Proc(...) bool
        +Clear() void
    }
    class IPlanningProcessor {
        <<interface>>
        +Load(config, task_type) bool
        +Process(...) bool
        +SetFrameContext(ctx)
        +GetFrameContext()
        +GetStopObstacles()
    }
    class Planning {
        -PlannerManager* planner_manager_
        -Frame* frame_
        -TrafficDecider traffic_decider_
        +Process(...) bool
        +RunOnce(...) bool
        +InternalRun(...) bool
        +ProcessFrameInitStuff(...) bool
        +ProcessPlanStuff() bool
    }
    class PlannerManager {
        +mutable_planner() shared_ptr~Planner~
        +em_planner() shared_ptr~Planner~
        +open_space_planner() shared_ptr~Planner~
        +reverse_tracking_planner() shared_ptr~Planner~
    }
    class Planner {
        <<interface>>
        +Plan(Frame*) bool
        +PlanOnReferenceLine(...) bool
        +GenerateAdcTrajectory(...) bool
    }
    class Frame {
        +GetEmReferenceLineInfo()
        +Preprocess(pool)
        +GetVehicleState()
    }
    class ReferenceLineInfo
    class Task {
        <<interface>>
        +Execute(Frame*, ReferenceLineInfo*) DR_STATUS
    }
    class TrafficDecider {
        +Execute(Frame*, ReferenceLineInfo*) bool
    }
    PlanningComponent ..> IPlanningProcessor : 经图 side packet 间接持有
    Planning ..|> IPlanningProcessor
    Planning --> PlannerManager
    PlannerManager o-- Planner
    Planner <|.. EMPlanner_OpenSpacePlanner_ReverseTrackingPlanner
    Planner --> Frame
    Frame o-- ReferenceLineInfo
    Task ..> Frame
    Task ..> ReferenceLineInfo
    Planning --> TrafficDecider
    TrafficDecider ..> Frame
```

类关系证据：

> 文件路径：/sandbox/planning/planning/planning.h（L106）  
> 核心逻辑：
> 
> ```cpp
> class Planning : public IPlanningProcessor {
>  public:
>   bool Load(deeproute::planning::ParsingConfig& parsing_config,
>             const std::string& task_type = "L4") override;
>   bool Process(..., deeproute::planning::ADCTrajectory *trajectory_pb) override;
> ```
> 
> 逻辑说明：`Planning` 是 `IPlanningProcessor` 的实现，经 `CreatePlanningProcessor()` C 工厂创建（`planning_api.h:177-178`），由 `PlanningStitchMapCalculator::Open()` 持有（`planning_stitch_map_calculator.cc:115`：`planning_.reset(DeepRoute::planning::CreatePlanningProcessor())`）。

> 文件路径：/sandbox/planning/planning/planner/planner.h（L15-25）  
> 核心逻辑：
> 
> ```cpp
> // an interface class for trajectory planning.
> class Planner {
>  public:
>   virtual bool Plan(Frame* frame) = 0;
>   virtual bool PlanOnReferenceLine(Frame* frame,
>                                    ReferenceLineInfo* reference_line_info) = 0;
> ```
> 
> 逻辑说明：**Planner（规划器）** 基类持有 `adc_trajectory_` 成员（L116），规划结果即写入该 proto。`PlannerManager`（`planner_manager.h:15-53`）以 `planner_factory_` map 管理 3 种规划器实例并按 `HPIPlanningInterface` 分发（`PlannerDispatch`，L44-45）。

> 文件路径：/sandbox/planning/planning/tasks/task.h（L13-17）  
> 核心逻辑：
> 
> ```cpp
> // An interface class to perform a planning task. Data IO is
> // through Execute() interface.
> class Task {
>  public:
>   virtual DR_STATUS Execute(Frame* frame,
>                             ReferenceLineInfo* reference_line_info) = 0;
> ```
> 
> 逻辑说明：**Task（任务）** 是 EMPlanner 管线上的最小算子单元，输入输出都是 Frame/ReferenceLineInfo；tasks/ 下 20+ 子目录（dp_path、dp_speed、ilqr、qp_speed、lane_change_decider、trajectory_safety 等）均为其派生。

> 文件路径：/sandbox/planning/planning/planning.h（L646）  
> 核心逻辑：
> 
> ```cpp
> TrafficDecider traffic_decider_;
> ```
> 
> 逻辑说明：`Planning` 持有 `TrafficDecider`（定义于 `planning/traffic_rules/traffic_decider.h:22`），在 `ProcessFrameInitStuff` 中对每条参考线执行 `traffic_decider_.Execute(frame_.get(), ref_line_info.get())`（`planning_frame_management.cpp:101`）。

---

## 5. 与 Perception / 中间件 / 控制交互关系

调度中间件为 **Church（自研 GRAPH/graphpipe 图调度框架）**：jsonnet 声明 topic 通道 → `planning_graph.cfg` 声明流图 → AnyCalculator/FrameDoneCalculator 完成汇聚与发布。Topic 交互全景：

| 方向 | Topic | 消息类型 | 说明 |
|-|-|-|-|
| 输入（TRIGGER） | `/perception/objects` | `deeproute.perception.PerceptionObstacles` | 帧触发源，required |
| 输入 | `/perception/traffic_lights_status` | `deeproute.perception.TrafficLightResponse` | required，缺失报错 |
| 输入 | `/map/ras_map_plus` | `deeproute.map.RASMapPlus` | required，缺失报错 |
| 输入 | `/canbus/car_state` | `deeproute.common.VehicleState` | required（底盘状态） |
| 输入 | `/localization/pose` | `deeproute.drivers.gnss.Ins` | optional，覆盖车状态位姿/速度 |
| 输入 | `/perception/ras_map`、`/perception/ras_map_parking` | `deeproute.perception.RASMap` | all_new / optional |
| 输入 | `/planner/request`、`/planner/multi_requests` | `PlanningRequest(s)` | all_new，请求事件 |
| 输入 | `/map/fusion_map`、`/map/sd_horizon_map`、`/blc/*`、`/vla/vla_output` 等 | 各异 | optional（共 24 个输入通道） |
| 输出 | `/planner/trajectory` | `deeproute.planning.ADCTrajectory` | supervision，→ 控制/AEB/回灌 |
| 输出 | `/planner/context` | `deeproute.planning.FrameContext` | 帧上下文（子图内自回灌+对外发布） |
| 输出 | `/planner/debug_info`、`/planner/response`、`/planner/event`、`/planner/semantic_info`、`/planner/stop_objects`、`/safety/request` 等 | 各异 | 调试/响应/事件/安全 |
| 下游 | `/planner/trajectory` → CbwControlComponent | — | 控制订阅（见《05》篇） |

> 文件路径：/sandbox/driver/config/component/planning.jsonnet（L20-218）  
> 逻辑说明：完整输入 24 通道 / 输出 13 通道声明见该文件；`need_topic_supervision: true` 仅 `/planner/trajectory`，表示该通道受 **topic supervision（通道监管，超时/丢帧监控）**。

---

## 6. 模块配置文件路径与初始化入口

| 配置 | 路径 | 作用 |
|-|-|-|
| 组件声明 | `/sandbox/driver/config/component/planning.jsonnet` | 组件挂载、任务线程、触发通道、输入/输出通道 |
| 主图配置 | `/sandbox/driver/config/component/planning_graph.cfg`（运行时路径 `planning/config/planning_graph.cfg`） | AnyCalculator→PlanningSubgraph→FrameDoneCalculator 三节点流水与 executor |
| 子图配置 | `/sandbox/planning/planning/config/planning_sub_graph.cfg` | `PlanningSubgraph` 子图内部 5 个 Calculator 连线与 back edge |
| 算法配置目录 | `/sandbox/planning/planning/config/`（`filelist.txt` + 品牌 `geely/gwm/hw/lp/seres/share/smart` 子目录） | 各品牌/车型的 EMPlanner、TrafficRules 等算法参数 |
| gflags | `/sandbox/planning/planning/planning_gflags/`（planning/、tests/ 子目录） | 开关类 flag（如 `FLAGS_only_publish_one_trajectory`、`FLAGS_perception_timestamp`） |
| 泊车制造数据配置 | `$DEEPROUTE_PATH/planning/config/planning/open_space_e2e_manufacture_data_config.jsonnet` | E2E 制造数据定制请求（`planning_input_preprocess_calculator.cc:803-817` 动态加载） |
| 线程配置 | `/sandbox/driver/config/thread_config/C01/perception.json` | t_Planning / planning_executor 等线程调度参数 |

初始化入口链路（标注"推断"处未经逐行验证）：

1. mainboard 按 `planning.jsonnet` 创建 `PlanningComponent`，调 `Init()`：读取 `/task/city`、`/task/task_type`（`L2_driving_vision → L2_driving` 映射，`planning_component.cc:45`），注入 `publish_handle`（`node()->Publish` 回调），启动 `PostProcessInterventionReporter`。
2. 图框架加载 `planning_graph.cfg`，实例化 AnyCalculator / PlanningSubgraph / FrameDoneCalculator（推断：FrameDoneCalculator 的 `TOPIC_TO_STREAM_ID_MAP`、`GENERATE_HEADER_CALLBACK` 等 side packet 由框架按 output_channels 自动生成，未验证细节）。
3. 首个数据帧到来时，`PlanningStitchMapCalculator::Open()` 调 `CreatePlanningProcessor()` 创建 `Planning` 核心对象并 `Load()` 配置（`planning_stitch_map_calculator.cc:111-120`）。

---

## 7. 阅读关系说明

建议阅读顺序与分工：

| 文档 | 内容 | 适合何时读 |
|-|-|-|
| 本篇《00_总览》 | 模块定位、目录地图、整体流水、类体系 | 第一次接触仓库 |
| 《01_输入数据接入与有效性校验》 | 24 输入通道、触发汇聚、逐路解析与校验 | 排查输入问题（丢帧/缺数据/时间戳） |
| 《05_输出发布与控制指令生成》 | 13 输出通道、发布顺序、ADCTrajectory 字段、控制交互 | 排查轨迹发布/控制不响应问题 |
| 其他子 Agent 文档（场景决策、任务管线等） | Scene/Tasks/Planner 细节 | 深入算法逻辑 |

代码阅读入口推荐顺序：  
`planning.jsonnet`（通道）→ `planning_graph.cfg` + `planning_sub_graph.cfg`（数据流）→ `planning_input_preprocess_calculator.cc`（输入）→ `planning_core.cppProcess()/RunOnce()`（核心）→ `planning_post_process_calculator.cc`（输出）→ `frame_done_calculator.cc`（发布）。

---

## 8. FAQ 与自测

**Q1：PlanningComponent 的 Proc() 是空的，那规划代码到底在哪执行？**
A：在图里。组件壳只负责被触发与注入 side packet（§1 证据），真正的规划逻辑由 `planning_graph.cfg` 声明的 Calculator 链承担——装配 → 子图（预处理/地图拼接/核心规划/后处理）→ FrameDone 发布（§3）。这也是 church 图执行架构的通用形态：壳薄、图厚。

**Q2：Proc() 空实现为什么还要触发策略 IMMEDIATE？**
A：IMMEDIATE 触发的是"装配"而非"规划"：`/perception/objects` 到达时 AnyCalculator 立即收集本帧全部输入消息打包成 planning_input（§3 图 C 节点），把原料递进子图；规划本身在图执行线程池里跑（§1 线程证据的 planning_executor）。触发策略决定的是"何时开工"，不是"在哪算"。

**Q3：`/planner/context` 是规划的输入吗？**
A：不是。它是规划自己的状态转储（FrameContext），在**子图内部**经 FRAME_CONTEXT back edge 自回灌给下一级 Calculator（附录修正 2 与 §3 读图提示 ②）；对外发布它只是调试可见性，外部组件不应消费它做决策。

**自测（能答上来才算读懂）**

1. 规划一个周期内的执行顺序是什么？（提示：14 步里哪步是核心，RunOnce 内部三段是什么。答：Process 共 14 步，第 10 步 RunOnce 是核心；RunOnce ＝ 帧初始化＋交通规则（ProcessFrameInitStuff）→ 核心规划（planner_->Plan）→ 轨迹校验（TrajectoryChecker）。§3。）
2. 多条参考线时，最后输出哪条？
   （答：每条参考线各自完整走一遍任务管线，按代价择优，选中的 ReferenceLineInfo 生成最终 ADCTrajectory。§2/§4。）

---

## 附：与既有结论基线的差异与修正

1. **差异**：`/perception/ras_map` 在 jsonnet 中类型为 `all_new`（每条新消息都进入装配，`any_calculator.cc:173-184`），并非 "required"；`/planner/request`、`/planner/multi_requests` 同为 `all_new`。
2. **修正**：`/planner/context` 不是外部输入通道（当前 jsonnet input_channels 中无此项）；**FrameContext 自回灌发生在子图内部**：`PlanningCoreCalculator` 输出 `FRAME_CONTEXT` 流，经 back edge 回连 `PlanningInputPreprocessCalculator`（planning_sub_graph.cfg L23-27）。
3. **补充**：除 `/perception/traffic_lights_status` 外，`/map/ras_map_plus` 缺失同样直接返回 `InvalidArgumentError`（planning_input_preprocess_calculator.cc:629-639）。
