---
title: "子模块8：visualizer 与 planning_debug 调试可视化子模块"
date: 2026-09-20
description: "调试可视化子模块：RvizVisualizer 仿真边界与 planning_debug 调试数据链路。"
categories:
  - 撰修司
tags:
  - Planning
  - E2E
---

> **30 秒导读**："调试望远镜"：把规划内心戏变成可视化数据，注意 RvizVisualizer 只在仿真用。
> **本篇回答**：调试数据怎么流转？车端和仿真各用什么？iLQR 调试看哪里？
> **先修阅读**：[**Planning 05 输出发布与控制指令生成**](../05%20Planning%20输出发布与控制指令生成.md)（调试数据随输出发出）。

> **本篇概念速成块**（30 秒，读完再进正文不卡壳）：
> - **两个目录两条链路**：planning_debug 是车端主链路的调试数据组装与发布层（`/planner/debug_info`）；visualizer 是**仿真专用**的 RViz 画笔（车端不调用）。
> - **DebugHandle 单例**：200+ 个 Write\* 方法、每字段独立 mutex——各规划环节并发写各自字段互不阻塞。
> - **多线对齐**：`trajectory[]`/`reference_line[]` 按参考线条数组织，`MessageSizeCheck` 保证第 i 条对第 i 条。
> - **open_space 深拷贝**：选中 open_space 时取出 debug 必须深拷贝——异步线程可能还在写（异步机制见 [**开放空间规划**（子模块7 §1.2）](子模块7：mission_planner%20与%20open_space%20泊车规划子模块.md)）。
> - **降采样**：抽稀间隔 10、采样间隔宏分级 1/5、末点必含——proto 体积与排查信息的平衡。
> - **指令回执**：`/visualizer/command` 进、`/visualizer/command_rp` 出，回执携带原 `id` 对账。
> - **ilqr 三层 map**：`records_[拍][障碍物][代价类型]` 支持"第 i 拍哪个障碍物贡献了哪类代价"的逐拍定位。


> 分析对象：`/sandbox/planning/planning/visualizer/`（2 文件：rviz_visualizer.h 794 行、rviz_visualizer.cpp 13135 行）；`/sandbox/planning/planning/planning_debug/`（11 文件）  
> 代码分支：perception/planning/driver @ Stable_Master_4.0_new

## 1. 子模块定位与职责

**一句话结论**：两个目录共同构成 Planning 的调试数据出口——planning_debug 服务车端（组装+发布），visualizer 只服务仿真（画 rviz marker）。

**为什么调试数据值得单独一篇**：规划是「黑盒程度最高的模块」——输入几十个障碍物与几条参考线，输出一条轨迹，中间发生了什么全靠 debug 数据还原。线上排查「为什么减速了」「为什么选了这条线」「iLQR 为什么不收敛」，答案都在 PlanningDebug 的某个字段里；而 debug 体系自身的并发写、降采样、发布门控又直接影响主循环性能——读懂本篇，等于拿到了拆黑盒的工具箱，也知道了这个工具箱本身的代价。

本组两个目录共同构成 Planning 的**调试数据出口**，但服务对象不同：

- **planning_debug（11 文件）**：车端主链路的调试数据**组装与发布层**。各规划算法在执行中通过 `DebugHandle` 单例写入 `PlanningDebug` proto，最终以 `/planner/debug_info` 通道发布——这是回放工具（bag_parser/topics.ini 中列出）和排查的主要数据源。
- **visualizer（2 文件）：仿真链路专用**的 RViz Marker 可视化器（`RvizVisualizer`），把 PlanningDebug 转成 rviz marker 数组发往 `/planner/rviz_visualizer`；**车端主链路不调用它**（调用方仅 `sim_planning_interface/sim_main_start.cpp`，见第6节证据3）。

`/visualizer/command`（下游调试指令输入）与 `/visualizer/command_rp`（回执输出）链路则不在上述目录中实现，而由 calculators 层处理（见第4节）——本节按"通道视角"一并说明。

planning_debug 11 文件清单：`planning_debug_handle.h/.cpp`（997/6816 行）、`ilqr_debug_handle.h/.cpp`（183/1070 行）、`ilqr_debug_utils.h/.cpp`、`product_business_processor.h/.cpp`（93 行）、`obstacle_cost_recorder.h`（68 行）、`debug_test.cpp`。

## 2. 核心类结构与成员变量

**一句话结论**：DebugHandle 是"单例+每字段独立锁"的写入口，RvizVisualizer 是仿真专用的画图单例；辅助处理器把中间量加工成业务可读字段。

### 2.1 DebugHandle（调试数据组装单例）

> 文件路径：/sandbox/planning/planning/planning_debug/planning_debug_handle.h  
> 函数名：class DebugHandle  
> 核心逻辑：
> 
> ```cpp
> class DebugHandle {
>  public:
>   void InitPlanningDebugInfo(...);          // 每帧初始化 PlanningDebug
>   void WriteSafetyTrajectory(...);          // 安全轨迹
>   void WriteTrajectoryChecker(...);         // 轨迹校验结果
>   void WriteLaneChangeCost(...);            // 变道代价
>   void WriteModelReflineInfo(...);          // 模型参考线
>   void WriteTrafficLightDebug(...);         // 红绿灯
>   // ... 200+ 个 Write* 方法，覆盖 path/speed/open_space/scene 各环节
>  private:
>   std::shared_ptr&lt;deeproute::planning::debug::PlanningDebug> planning_debug_;
>   // 50+ 细粒度互斥锁（多线程写入保护）：
>   std::mutex mtx_safety_trajectory_, mtx_trajectory_checker_, ...;
>   // open_space 相关 13 个细粒度锁（L963-980）：
>   std::mutex mtx_open_space_boundary_, mtx_open_space_trajectory_, ...;
>   ProductBusinessProcessor product_business_processor_;  // 业务化处理器
> };
> DECLARE_SINGLEINSTANCE(DebugHandle);        // L988-993 单例
> ```
> 
> 逻辑说明：单例 + **每字段独立 mutex** 的写法，允许规划管线各任务并发写各自字段而互不阻塞。`PlanningDebug` proto（offboard/planning/planning_debug_info.pb.h）结构大体与规划输出对应：`trajectory`（多参考线各一条）、`reference_line`（多参考线各一条）、路径/速度决策、ST 图、open_space、critical objects 等。`MessageSizeCheck`（planning_debug_handle.cpp L103-116）校验 `trajectory_size == reference_line_size == num_ref_line`，保证多线对齐。

### 2.2 辅助处理器

- **ProductBusinessProcessor**（product_business_processor.h，93 行）：`PopulateCriticalObjects/ProcessCriticalObjects/RetrieveStoplineReason/ProcessBroadcastInfo`；成员 `closest_overtake_/soft/follow/stop_object_id_distance_`、`critical_object_id_`、`vru_obj_id_`、`stopline_reason_`、`broadcast_info_`——把原始规划中间量加工成"业务可读"字段（最近超越目标、停车线原因、广播信息等）。
- **IlqrDebugHandler**（ilqr_debug_handle.h，183 行）：持有 `IlqrDebugInfo`/`IlqrSolverDebugInfo`（ILQR 求解器专调数据：初值轨迹、输出轨迹、代价明细）；枚举 `ObjectType{ROAD_EDGE,STATIC,DYNAMIC}`、`TrajType{ILQR,RAW,EM}`、`PolylineType{CENTER,LEFT_BOUNDARY,...}`。
- **ObstacleCostRecorder**（obstacle_cost_recorder.h，68 行，ilqr 命名空间）：线程安全的三层 map 记录器 `records_[index][obstacle_id][cost_type] = value`（轨迹 index 0-49 → 障碍物 ID → 代价类型 → 值，`RecordCost/GetRecords/Clear`），支持「第 i 拍上哪个障碍物贡献了哪类代价」的逐拍定位。

**调试对象里的 AI 名词**：IlqrDebugHandler 调的是 **iLQR**（基于车辆动力学模型的轨迹优化算法，任务链里的「模型级打磨」工序，原理见 [**AI 字典·iLQR 与 LQR**](../../../../正典阁/技术栈/AI/iLQR%20与%20LQR.md)）——它记录的「初值轨迹/输出轨迹/代价明细」是排查 iLQR 解不收敛、轨迹跳变的第一手材料；ObstacleCostRecorder 的 cost_type 则对应求解器内部各项代价（碰撞/偏差/平滑等）的拆解，逐拍定位哪个障碍物在哪个时刻贡献了哪类代价。

### 2.3 RvizVisualizer（仿真可视化单例）

> 文件路径：/sandbox/planning/planning/visualizer/rviz_visualizer.h  
> 函数名：class RvizVisualizer  
> 核心逻辑：
> 
> ```cpp
> class RvizVisualizer {
>  public:
>   DECLARE_SINGLEINSTANCE(RvizVisualizer);   // L55
>   RvizVisualizer();   // L59-73 构造时发布 vehicle→lidar 静态 TF
>   bool DebugTestRvizWrapper(const PlanningDebug&,
>                             const RoutingResponse&, const bool); // 总入口
>   // L76：id_map_ 按 ReferenceLinePosition 7 种位置建 id 段
>   // 能力：DrawRoadDebugImage / DrawTrajectory / DrawStBoundary /
>   //       DrawSTGridWrapper / DrawVSValue / DrawVisInputAndHpiStatus ...
>  private:
>   std::map<...> id_map_;                    // marker id 分配
>   uint32_t chosen_trajectory_id_ = 0;       // 选中的轨迹
> };
> ```
> 
> 逻辑说明：构造即挂静态 TF（车体→激光雷达坐标系），说明其 rviz 场景按车体坐标组织；`id_map_` 用参考线位置（LEFT/MIDDLE/RIGHT 等 7 类）分配 marker id，便于 rviz 端按 ns 过滤。

## 3. 核心处理流程与函数调用链

**一句话结论**：两条链路——主链路组装/取出/发布 `/planner/debug_info`；仿真链路额外画 rviz marker；另有 command 指令进、command_rp 回执出的对账回路。

```mermaid
graph TB
    subgraph SG1["debug 数据组装（主链路）"]
    A["规划各环节（path/speed/open_space/scene）"] --> B["DebugHandle 单例
200+ Write* 方法（细粒度锁）"]
    B --> C["planning_debug_ shared_ptr&lt;PlanningDebug&gt;"]
    end
    C --> D["planning_core_calculator.Inference 完成后
ProcessDebugInfo"]
    D --> E["GetDebugInfoFromSingleInstance
planning_misc_utils.cpp L2484-2495
SELECTION_OPEN_SPACE 时 SafeCopyPlanningDebugInfo 深拷贝
否则 GetPlanningDebugInfoSharedPtr"]
    E --> F["ShouldPublishPlanningDebugInfo L2502-2509
WRITE_DEBUG_HEAVY / MID / LIGHT 编译宏"]
    F -- 允许 --> G["PlanningFrameDataOutput.debug_info"]
    G --> H["planning_post_process_calculator L128
发布 /planner/debug_info"]
    G --> I["RvizVisualizer::DebugTestRvizWrapper
（仅仿真链路 sim_main_start 调用）"]
    I --> J["Publish_v1 → PublishRvizMarkerArray
topic=/planner/rviz_visualizer"]
    subgraph SG2["visualizer command 链路"]
    K["/visualizer/command 订阅
planning_input_preprocess_calculator L641-655"] --> L["outputs-&gt;vis_cmd"]
    L --> M["planning_stitch_map_calculator L471-478
task_type 为 L2_driving/L2_parking/L2_driving_vision 时 UpdateVisInput
生成 cmd_rp_ 并 set_id(vis_cmd.id())"]
    M --> N["planning_core_calculator L86-93 透传 cmd_rp"]
    N --> O["planning_post_process_calculator L138
发布 /visualizer/command_rp"]
    end
```

**图 3-1 · 调试数据双链路（主链路组装发布 + 仿真画图 + 指令回执）**（B 是全链路写入口，F 是发布门控，I 仅仿真，K→O 是指令对账回路）

**读图提示**：① 上半 SG1 是主链路：各环节并发写 DebugHandle，主循环保留共享指针、open_space 选中时才深拷贝；② F 是门控——编译宏 WRITE_DEBUG_HEAVY/MID/LIGHT 分级，否则按降采样间隔发布；③ I 在 SG1 外且仅仿真链路调用（sim_main_start），车端不走；④ 下半 SG2 是指令回路：command 进来先转 VisInput 写 frame_context 影响规划，再原样带 id 回执。

**降采样与一致性**：`planning_debug_handle.cpp` 匿名空间提供 `PopulatePolylineIfValid`（参考线/模型路径抽稀，间隔10）、`GetSampleInterval5()`（`WRITE_DEBUG_HEAVY` 定义时=1，否则=5）、`CopyPolylineWithDownsampling/CopyTrajectoryPointsWithDownsampling/CopySpeedPointsWithDownsampling`（均保证末点必含）——proto 体积与性能的平衡手段。

## 4. 核心算法入口与关键逻辑

**一句话结论**：debug 组装三步（重置→各环节 Write→取出校验降采样）+ command 指令映射 + 排查对症表；取出时 open_space 深拷贝是唯一特例。

### 4.1 /planner/debug_info 的组装结构

每帧流程：`DebugHandle::InitPlanningDebugInfo` 重置 → 各环节 `Write*` 填充 → `GetDebugInfoFromSingleInstance` 取出（open_space 选中时**深拷贝**，因 open_space 在独立线程写 debug，直接转发共享指针会与下一帧写入竞态——异步机制见 [**开放空间规划**（子模块7 §1.2）](子模块7：mission_planner%20与%20open_space%20泊车规划子模块.md)）→ 大小校验/降采样 → 输出。`PlanningDebug` 主要区块：`trajectory[]`/`reference_line[]`（多参考线对齐）、path/speed 决策、ST 图、open_space（13 个锁对应的细分字段）、`critical_objects`、ilqr solver debug、业务化字段（`stopline_reason` 等）。

### 4.2 /visualizer/command 输入 → /visualizer/command_rp 输出

- **输入**：`planning_input_preprocess_calculator.cc` L641-655 订阅 `VisualizerCommand` 放入 `outputs->vis_cmd`（可选输入，无消息时整段跳过）。
- **消费**：`planning_stitch_map_calculator.cc` L471-478——`vis_cmd.ByteSizeLong() > 0` 且 `task_type ∈ {L2_driving, L2_parking, L2_driving_vision}` 时调用 `UpdateVisInput()`，把指令逐项映射为 `VisInput`（`sdlane_type` 的 OPEN_SDLANE/CLOSE_SDLANE、`entry_lane_type`、`perception_follow/pnc_follow_virtual_lane_type`、`ilc_or_auto_turn`、`l2_status_type`、`dynamic_obstacle_type`、`static_obstacle_tpe`、`sonar_type`），写入 frame_context 供规划使用；同时生成回执 `cmd_rp_ = make_unique<VisualizerCommandRP>(); cmd_rp_->set_id(input_data.vis_cmd.id())`。
- **输出**：`cmd_rp` 经 `planning_core_calculator`（L86-93 可选透传）→ `planning_post_process_calculator` L138 发布 `/visualizer/command_rp`，下游以 `id` 对应确认指令已生效。

### 4.3 debug 数据如何辅助排查

排查顺序建议：先用 [**公共 05 的全链路时序**](../../00_公共基础文档/05%20端到端全链路时序与异常机制（C01%20-%20orinx）.md)定位问题环节，再按下表对症取数；ST 边界与轨迹拦截细节分别见 [**ST 图**（子模块1 §3）](子模块1：planner%20与%20tasks%20决策规划任务管线.md) 与 [**轨迹校验**（子模块4 §1）](子模块4：trajectory_checker%20轨迹校验子模块.md)。

| 排查场景 | 使用的 debug 数据 | 来源 |
|-|-|-|
| 某障碍物为何避让/绕行 | `critical_objects`、逐拍障碍物代价 `ObstacleCostRecorder` 三层 map | ProductBusinessProcessor / ilqr |
| 减速/停车原因 | `stopline_reason`、follow/stop 目标距离 | ProductBusinessProcessor |
| 参考线选错/质量差 | `reference_line[]` 与 `trajectory[]` 对齐的多线数据、`WriteLaneChangeCost`、模型参考线 `WriteModelReflineInfo` | DebugHandle |
| ILQR 解不收敛/轨迹跳变 | `IlqrSolverDebugInfo`（初值/输出轨迹、代价曲线） | IlqrDebugHandler |
| 泊车失败 | open_space 细分字段（边界/轨迹/状态，13 个独立锁对应字段） | DebugHandle |
| ST 边界异常 | ST 图 / StBoundary 绘制数据 | DebugHandle（rviz 端 DrawSTGrid） |

## 5. 输入输出数据结构

**一句话结论**：输入是各环节中间结果+command 指令，输出是 `/planner/debug_info`（主链路）、`/planner/rviz_visualizer`（仅仿真）、`/visualizer/command_rp`（回执）三通道。

**输入**：

- 规划管线各环节的中间结果（经 `DebugHandle::Write*`，如 SafetyTrajectory、TrajectoryChecker、LaneChangeCost、ModelRefline、TrafficLight、open_space 边界/轨迹）；
- `/visualizer/command`（`VisualizerCommand` proto，下游调试指令，可选输入）；
- 仿真链路：`PlanningDebug` + `RoutingResponse`（`DebugTestRvizWrapper` 入参）。

**输出**：

- `/planner/debug_info`（`PlanningDebug` proto，主链路每帧发布，受编译宏/降采样控制）；
- `/visualizer/command_rp`（`VisualizerCommandRP`，携带原命令 `id` 的回执）；
- `/planner/rviz_visualizer`（rviz `MarkerArray`，仅仿真链路）。

## 6. 代码证据与关键片段

**一句话结论**：五段证据钉死取出/发布条件、calculator 落点、仿真边界、指令回执与多线对齐校验。

### 证据1：debug 单例取出与发布条件

> 文件路径：/sandbox/planning/planning/planning_misc_utils.cpp  
> 函数名：GetDebugInfoFromSingleInstance() / ShouldPublishPlanningDebugInfo()  
> 核心逻辑：
> 
> ```cpp
> // L2484-2509（节选）
> std::shared_ptr&lt;PlanningDebug> GetDebugInfoFromSingleInstance() {
>   FlushPendingDetourReverseReferenceLine();
>   if (planner_selection == SELECTION_OPEN_SPACE) {
>     return DebugHandle::Instance()->SafeCopyPlanningDebugInfo(); // 深拷贝
>   }
>   return DebugHandle::Instance()->GetPlanningDebugInfoSharedPtr();
> }
> bool ShouldPublishPlanningDebugInfo() {
> #if defined(WRITE_DEBUG_HEAVY) || defined(WRITE_DEBUG_MID) || \
>     defined(WRITE_DEBUG_LIGHT)
>   return true;   // 按编译宏分级；否则按降采样间隔发布
> #endif
>   ...
> }
> ```
> 
> 逻辑说明：open_space 选中时必须深拷贝——因为异步 open_space 线程可能仍在写 debug 共享对象；普通巡航路径直接转发共享指针以省一次拷贝。

### 证据2：calculator 链路的 debug 取出与发布

> 文件路径：/sandbox/planning/planning/calculators/planning_core_calculator.cc  
> 函数名：PlanningCoreCalculator::ProcessDebugInfo()  
> 核心逻辑：
> 
> ```cpp
> // L199-215（节选）
> void ProcessDebugInfo(PlanningFrameDataOutput& output_data) {
>   auto debug_info = DeepRoute::planning::GetDebugInfoFromSingleInstance();
>   const bool should_publish_planning_debug_info =
>       DeepRoute::planning::ShouldPublishPlanningDebugInfo();
>   if (debug_info && should_publish_planning_debug_info) {
>     output_data.debug_info = *debug_info;   // 填入输出包
>   }
> }
> // planning_post_process_calculator.cc L128：
> //   将 output_data.debug_info 发布到 "/planner/debug_info"
> ```
> 
> 逻辑说明：与基线一致，`/planner/debug_info` 是 `PlanningFrameDataOutput.debug_info` 的落点，位于 planning_post_process_calculator 输出映射段。

### 证据3：RvizVisualizer 仅仿真链路调用

> 文件路径：/sandbox/planning/planning/visualizer/rviz_visualizer.cpp  
> 函数名：RvizVisualizer::DebugTestRvizWrapper() / Publish_v1()  
> 核心逻辑：
> 
> ```cpp
> // L34-66（节选）
> bool RvizVisualizer::DebugTestRvizWrapper(const PlanningDebug& debug,
>     const RoutingResponse& routing, const bool xx) {
>   if (!MessageSizeCheck(debug, num_ref_line)) return false;
>   DrawPlanningDebugInfo(debug, routing);   // 参考线/轨迹/ST 图等
>   ...
>   Publish_v1();                            // L68-221
> }
> // Publish_v1 内（L197）：
> DeepRoute::adapter::FactoryCenter::PublishRvizMarkerArray(markerArray_to_publish_);
> // topic = "/planner/rviz_visualizer"（sim_main_start.cpp L566 注册）
> // 调用方：sim_planning_interface/sim_main_start.cpp L239/401（仅仿真）
> ```
> 
> 逻辑说明：`Publish_v1` 按 `chosen_trajectory_id_` 把选中轨迹 marker 命名为 `ref_line_best`/`Debug` 命名空间、候选黄色、碰撞红色，再合并 ref_line_0\~3 与 frame marker 发布。**车端主链路（planning_core 等）不调用 RvizVisualizer**——车端调试依赖 `/planner/debug_info` + 离线回放工具；grep 全仓库调用点仅 `sim_planning_interface`。

### 证据4：/visualizer/command → command_rp 回执生成

> 文件路径：/sandbox/planning/planning/calculators/planning_stitch_map_calculator.cc  
> 函数名：PlanningStitchMapCalculator::Process()  
> 核心逻辑：
> 
> ```cpp
> // L471-478（节选）
> if (input_data.vis_cmd.ByteSizeLong() > 0) {
>   if (task_type_ == "L2_driving" || task_type_ == "L2_parking" ||
>       task_type_ == "L2_driving_vision") {
>     UpdateVisInput(input_data.vis_cmd, ...);   // 指令 → VisInput（写 frame_context）
>   }
>   cmd_rp_ = std::make_unique&lt;deeproute::visualizer::VisualizerCommandRP>();
>   cmd_rp_->set_id(input_data.vis_cmd.id());    // 回执携带原 id
> }
> ```
> 
> 逻辑说明：C01（L2_driving）在支持列表内，`/visualizer/command` 指令生效并回执；`UpdateVisInput` 支持的指令类别见 4.2 节列表（sdlane 开闭、跟车模式、sonar 等调试注入）。

### 证据5：多线对齐校验

> 文件路径：/sandbox/planning/planning/planning_debug/planning_debug_handle.cpp  
> 函数名：MessageSizeCheck()  
> 核心逻辑：
> 
> ```cpp
> // L103-116
> bool MessageSizeCheck(const PlanningDebug& planning_debug_info,
>                       const size_t num_ref_line) {
>   if (planning_debug_info.trajectory_size() != (int)num_ref_line ||
>       planning_debug_info.reference_line_size() != (int)num_ref_line) {
>     MLOG(WARN) << planning_debug_info.trajectory_size() << ' '
>                << planning_debug_info.reference_line_size() << ' ' << num_ref_line;
>     return false;
>   }
>   return true;
> }
> ```
> 
> 逻辑说明：`PlanningDebug` 的 `trajectory`/`reference_line` 都是按参考线条数组织的 repeated 字段，此校验保证"第 i 条参考线 ↔ 第 i 条轨迹"的下标对齐，是回放工具正确渲染多线数据的前提。

## 7. FAQ 与自测

**Q1（新手常见误解）**：车端也会调 RvizVisualizer 画 rviz 图吧？可视化器不就是干这个的？
不会。RvizVisualizer 是**仿真链路专用**——全仓库调用点只有 `sim_planning_interface/sim_main_start.cpp`（证据3），车端主链路根本不 include 它。车端调试靠 `/planner/debug_info` 发布的 PlanningDebug proto + 离线回放工具渲染，不在车上画。

**Q2**：为什么 open_space 选中时取出 debug 要深拷贝，平时不用？
因为 open_space 规划在独立线程池异步执行（子模块7），本帧发布时工作线程可能还在往同一个 debug 共享对象里写；直接转发共享指针会与下一帧写入产生竞态。普通巡航路径规划全部在主循环内完成，取出时本帧已写完，转发共享指针省一次拷贝（证据1）。

**Q3**：debug 发布会不会拖慢主循环？
有多重护栏：编译宏 WRITE_DEBUG_HEAVY/MID/LIGHT 分级控制发布量；非宏路径按降采样间隔发布；抽稀间隔 10/5 且保证末点必含；`ShouldPublishPlanningDebugInfo` 不过关时 `ProcessDebugInfo` 直接不填输出包（证据2）。生产版本通常只开 LIGHT 级。

**自测**：

1. DebugHandle 怎么做到各规划环节并发写不互堵？
    单例 + 每字段独立 mutex（50+ 把，open_space 相关就 13 把）——各任务只锁自己要写的字段，互不阻塞（§2.1）。
2. `/visualizer/command` 的回执怎么与原指令关联？
    `cmd_rp_->set_id(input_data.vis_cmd.id())`——回执携带原指令 id，下游以 id 对账确认生效（证据4）。
3. 多参考线数据的对齐靠什么保证？
    `MessageSizeCheck`：`trajectory_size == reference_line_size == num_ref_line`，保证第 i 条参考线对应第 i 条轨迹（证据5）。

## 附：未验证/推断项

- `ilqr_debug_handle.cpp`（1070 行）/`ilqr_debug_utils.*` 的字段级填充逻辑未逐行核验（接口与数据结构已确认）——**未验证**。
- `ShouldPublishPlanningDebugInfo` 非宏路径的降采样间隔具体值（依赖 gflags/配置）——**未验证**。
- `RvizVisualizer` 各 Draw\* 的 marker 细节（13135 行 .cpp 未全读，仅核验主链路与发布点）——**推断**为常规 rviz marker 封装。
- platform/church（dev_master）侧这两个目录的差异——**未验证**。
