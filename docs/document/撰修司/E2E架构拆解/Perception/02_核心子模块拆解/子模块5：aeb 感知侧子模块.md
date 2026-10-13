---
title: "子模块5：aeb 感知侧子模块"
date: 2026-09-20
description: "感知侧 AEB 子模块：目标过滤链与安全目标筛选。"
categories:
  - 撰修司
tags:
  - Perception
  - E2E
---

> **30 秒导读**：感知内部的安全过滤链：确认危险目标不被漏报误报。
> **本篇回答**：AEB 需要什么目标？过滤链按什么顺序筛？和整车 AEB 什么关系？
> **先修阅读**：《00 入门》§1"遇到危险时"。

> **本篇概念速成块**（30 秒，读完再进正文不卡壳）：
> - **aeb 过滤链**：感知里的「安全质检复核台」——对 tracker 目标做 AEB 视角的二次过滤（完整卡片见 §4.1）。
> - **感知侧 AEB vs 车端 AEB**：本模块只筛目标不做制动——无 TTC、无制动请求，刹车决策在 driver 仓独立 AebComponent（§1.1 新手易混）。
> - **全量+状态码输出**：被过滤目标不丢弃，贴 StatusCode（如 FILTERED_BY_CONFIDENCE）随全量回传，下游自主判读（§6）。
> - **盲区分档阈值**：盲区内分数阈值随距离线性衰减，越近越宽松防漏报；非盲区按距离区间查表（§4.1）。
> - **雨天防抖**：雨点超阈值进雨天态，连续 N 帧非雨才退出——防雨停雨来回切换（§4.1）。
> - **行车/泊车合并**：行车目标为骨架，盲区静态车用 AVP（环视+mighty）版本替换——泊车相机对近距看得更准（§4.2）。
> - **尺寸历史保持**：tracker 未匹配（detection_id=-1）时用 LruMap 历史宽长高回填，防目标闪烁（§4.1）。


> 仓库路径：`/sandbox/perception/submodules/aeb`（perception 分支 `Stable_Master_4.0_new`，当前检出即目标分支）  
> 规模：70 个源文件（不含 proto/cfg）。本文所有结论均有代码证据，推断处已标注。

## 1. 子模块定位与职责

**一句话结论**：submodules/aeb 是感知内的「AEB 目标配料车间」——不刹车、不算碰撞，只把 [**tracker / track_id**（子模块3 §1）](子模块3：tracker%20多目标跟踪子模块.md) 输出的目标做 AEB 视角的过滤/富化/合并，产出专用目标集发布。

**为什么 AEB 的目标要单独再筛一遍**：常规 /perception/objects 服务于规划，追求「别错杀」；AEB 是急刹安全网，追求「别漏报」——同一份 tracker 输出，两套验收标准。所以感知为 AEB 单开一条过滤链：把雨点误报、低置信度疑影这类「规划不在意但 AEB 会紧张」的目标提前打标，让下游安全组件拿到的是「按安全视角预筛过」的目标集。

### 1.1 与车端独立 AebComponent 的关系（核心结论）

**submodules/aeb 是"感知侧 AEB 支撑子模块"**：它在 perception mainboard 进程内，对感知跟踪输出的目标做**AEB 专用的过滤、富化、行车/泊车目标合并**，最终通过 C01 l2avp 感知图发布到 `/perception_aeb/objects` 话题；**它不做 AEB 控制决策**（无 TTC 计算、无制动请求逻辑）。消费 `/perception_aeb/objects` 并做碰撞判断与制动的是 driver 仓库中的**独立 AEB 组件**（不在本文范围内）。

两者通过话题衔接，证据链如下：

> 文件路径：/sandbox/driver/config/component/perception_graph_l2avp_orin.cfg  
> 函数名：（图配置，无函数）  
> 核心逻辑：
> 
> ```cfg
> # 感知图顶层输出流（L25）：感知侧 AEB 目标集
> output_stream: "perception_aeb__objects"
> ...
> node {
>   name: "perception_frame_done"
>   calculator: "FrameDoneCalculator"
>   ...
>   output_stream: "OUTPUT:6:perception_aeb__objects"   # L159
> ```

> 文件路径：/sandbox/driver/config/component/perception_orin.jsonnet  
> 函数名：（jsonnet 发布配置，L287-290）  
> 核心逻辑：
> 
> ```jsonnet
> { "name": "/perception_aeb/objects",
>   "stream": "perception_aeb__objects", ... }
> ```
> 
> 逻辑说明：感知 mainboard 把内部流 `perception_aeb__objects` 以话题 `/perception_aeb/objects` 发布。

> 文件路径：/sandbox/driver/integration/components/aeb_component.cc  
> 函数名：AEBComponent（消费端，仅作衔接证据）  
> 核心逻辑：
> 
> ```cpp
> 349:  input_msg = FindLastMessage(input_msgs, "/perception_aeb/objects");
> ```
> 
> 逻辑说明：车端独立 AEB 组件订阅 `/perception_aeb/objects`。即：**submodules/aeb（生产）→ 话题 → driver AebComponent（消费）**。submodules/aeb 内部代码（aeb_light_fusion_process_calculator.cc、aeb_merge_driving_parking_objs_calculator.cc 等）只做感知目标级的处理，全仓库 grep 不到任何制动/碰撞控制代码，职责边界以代码为准。

### 1.2 在 C01 感知图中的启用条件

C01（orinx 平台 L2AVP）使用 `perception_orin_l2avp.cfg`，其中 `enable_aeb_process: true`（cfg L67；`perception_default.cfg`/`perception_vision.cfg` 中为 false）。该开关经 `PerceptionIoPreprocessing` 的 `FILL_EXPECTATION_20` 变成 side packet，控制 `SimpleGateCalculator` 是否放行 AEB 分支（graph_l2avp.cfg L68/L285）。

## 2. 核心类结构与成员变量

**一句话结论**：全部是 graphpipe Calculator 薄节点——主过滤（LightFusion）一个、行车/泊车合并一个、泊车筛选一个，阈值参数全在 AebParamSingleton 单例的 proto 里。

全部核心类位于 `percep_aeb` 命名空间，均为 graphpipe **Calculator**（mediapipe 计算器）：

| 类 | 文件 | 职责 |
|-|-|-|
| `AebLightFusionProcessCalculator` | percep_aeb/onboard/calculators/aeb_light_fusion_process_calculator.cc | **主链路核心**：对跟踪后目标做 AEB 专项过滤 |
| `AebMergeDrivingParkingObjsCalculator` | 同目录 aeb_merge_driving_parking_objs_calculator.cc | 行车目标与泊车(AVP)目标合并，AVP 补盲区 |
| `AebParkingCalculator`（及 `_qnx` 变体） | aeb_parking_calculator.cc / aeb_parking_calculator_qnx.cc | 泊车模式下对 AVP 目标做 AEB 过滤（CUDA 点云入箱校验） |
| `AebProcessCalculator` | aeb_process_calculator.cc | AEB 独立激光雷达检测子图（aeb_sub_graph.cfg）的后处理；**未在 C01 l2avp 主图调用**（见 §3） |
| `AebParamSingleton` | aeb_lidar_processor_base.h | 参数单例：加载 `aeb_lidar_process_param` proto |
| `AebDetectorPostProcessor` | percep_aeb/modules/postprocess/detector_post_processor.\* | NN 输出解码（仅 AebProcessCalculator 使用） |
| `ObjectFilterManager` / `RainGridManager` / `ObjectGridManager` | percep_aeb/utils/object_filter_manager.\* 等 | 锥桶滑窗过滤 / 雨点栅格 / 障碍物栅格 |

`AebLightFusionProcessCalculator` 关键成员（L968-985）：

```cpp
  AebLidarProcessParam param_;                    // 全部过滤阈值（proto 配置）
  std::unique_ptr<ObjectFilterManager> obj_manager_;      // 锥桶连续帧高度过滤
  std::unique_ptr<RainGridManager> rain_grid_manager_;    // 雨点时空栅格
  std::unique_ptr<ObjectGridManager> object_grid_manager_;
  float ground_z_;                                // 地面高度（取自 ground_config）
  int consecutive_non_rainy_frames_ = 0;          // 连续非雨帧计数（防抖）
  bool is_rain_scene_ = false;
  std::unique_ptr<common::LruMap<int, ObjectHistoryInfo>>
      history_obj_refine_infos_;                  // track_id -> 历史 w/l/h（尺寸保持）
  std::string car_type_ = "DEFAULT";              // 依 CAR_ID 环境变量区分车型
  float ped_blind_area_offset_;                   // 行人盲区偏移（P03=7m，其余3m）
  float cone_blind_area_offset_;                  // 锥桶盲区偏移（M81/M82/M83=2m）
```

参数单例（aeb_lidar_processor_base.h L53-92）：

```cpp
class AebParamSingleton {
 public:
  static AebParamSingleton& GetInstance() {
    static AebParamSingleton instance = AebParamSingleton();
    return instance;
  }
  const AebLidarProcessParam& GetParams();
  void Init(const std::string& param_path, const VehicleConfig& car_config,
            const LidarConfig& lidar_config);
 private:
  AebLidarProcessParam params_;   // proto: proto/aeb_lidar_process_param.proto
  ...
};
```

## 3. 核心处理流程与函数调用链

**一句话结论**：C01 里 AEB 子链 ＝ 一个开关（SimpleGate）+ 两个 calculator（过滤/合并）+ 一个泊车筛选，挂在 tracker 之后、FrameDone 打包发布之前。

### 3.1 C01 l2avp 图中的调用点（已验证）

C01 感知主图 `perception/cfg/graphs/onnx/graph_l2avp.cfg` L278-318：

```cfg
###### AEB subgraph ######
node {
  name: "aeb_simple_gate"
  calculator: "SimpleGateCalculator"
  input_stream: "tracking_preprocess_output"          # 来自感知 tracker（主图 L822）
  output_stream: "aeb_tracking_preprocess_output"
  input_side_packet: "SWITCH:enable_aeb_process"      # C01 配置为 true
}
node {
  calculator: "AebLightFusionProcessSubgraph"         # 注册于 submodules/aeb/cfg/graphs/BUILD.bazel:26
  input_stream: "LIDAR:0:lidar_inputs"
  input_stream: "LIDAR:1:lidar_process_output"
  input_stream: "AVP_LIDAR:mighty_lidar_inputs"       # 泊车前向激光雷达
  input_stream: "PREPROCESS:aeb_tracking_preprocess_output"
  output_stream: "AEB_PROCESS:aeb_tracking_preprocess_fusion_output"
  input_stream: "AEB:aeb_tracking_frame_output"       # 回环（上一帧 AEB 结果）
  input_stream: "AVP:mighty_obstacles_fusion_output"  # 泊车 AVP 目标
  output_stream: "AEB_PROCESS_MERGE:aeb_fusion_process_output"
  output_stream: "AEB_PARKING:aeb_parking_output"
}
```

子图内部（`submodules/aeb/cfg/graphs/aeb_sub_graph_light_fusion.cfg` L21-67）由三个 calculator 组成：

```mermaid
graph LR
    A[感知tracker
tracking_preprocess_output] --> G[SimpleGateCalculator
enable_aeb_process开关]
    G --> B[AebLightFusionProcessCalculator
AEB专项过滤]
    L[lidar_inputs / lidar_process_output] --> B
    B --> C[AebMergeDrivingParkingObjsCalculator
行车+泊车目标合并]
    A2[aeb_tracking_frame_output
上一帧AEB回环] --> C
    V[mighty_obstacles_fusion_output
AVP泊车目标] --> C
    V2[AVP目标] --> P[AebParkingCalculator
泊车AEB目标]
    C --> O1[aeb_fusion_process_output
行车帧输出]
    P --> O2[aeb_parking_output
泊车帧输出]
    O1 --> S[PredictionAndStatusResultSyncCalculator
主图L902帧同步]
    S --> F[PerceptionOutputProcessCalculator
FINAL_AEB:0]
    F --> T[FrameDoneCalculator → /perception_aeb/objects]
    O2 --> F2[PerceptionOutputProcessCalculator
FINAL_AEB:1 泊车帧]
```

**图 3-1 · C01 感知图内 AEB 子链路（tracker 目标 → 过滤 → 行车/泊车合并 → 发布）**（自上而下，C 是行/泊合流点，T 是发布出口）

**读图提示**：① G 节点是总闸——`enable_aeb_process=false` 时 AEB 分支整条不通（SimpleGate 不放行）；② AEB 回环流（A2→C）是跨帧尺寸保持的关键，上一帧结果喂回本帧合并；③ O1 走行车帧、O2 走泊车帧，两条路最后都汇入 [**FrameDone**（公共 02 §6.1）](../../00_公共基础文档/02%20模块配置与%20Topic%20数据流拓扑（C01%20-%20orinx）.md) 打包发布。

`PerceptionObjectsTransferCalculator`（主图 L310-316）把过滤后目标回写 `aeb_tracking_frame_output` 形成回环，用于跨帧尺寸保持。

**注意**：`AebProcessCalculator`（AEB 独立检测子图）只被 `aeb_sub_graph.cfg` / `aeb_sub_graph_light.cfg` 引用，而这两个 cfg 在 C01 l2avp 主图中**未被引用**（全仓库仅 `submodules/aeb/cfg/graphs/BUILD.bazel` 注册），属于其它图配置/历史方案，C01 未启用——此为代码 grep 结论。

### 3.2 与车端调度器的关系

AEB 子图节点运行在感知 mainboard 的 graphpipe（GRAPH 调度器）线程池内，受 `FrameSyncCalculator` 100ms 帧同步驱动，无独立调度进程，最终随感知帧经 [**FrameDone**（公共 02 §6.1）](../../00_公共基础文档/02%20模块配置与%20Topic%20数据流拓扑（C01%20-%20orinx）.md) 发布；`MTRACE_GPU_SCOPE("AebLightFusionProcessCalculator")` 表明其耗时进入感知 trace。

## 4. 核心算法入口与关键逻辑

**一句话结论**：核心就三段——专项过滤（雨检→GRIDMAP→DETECTOR→置信度四层）、行车/泊车合并、泊车目标筛选；每个被删目标都带 StatusCode 回传。

**三段里出现的 AI 名词**：过滤第四层比较的 `confidence` 是检测模型对「这真的是个障碍物」的把握程度（见 [**AI 字典·置信度**](../../../../正典阁/技术栈/AI/置信度.md)）；行人密集簇过滤用的是 DBSCAN 聚类——按密度把相邻行人聚成一簇再统一取舍（见 [**AI 字典·聚类与 DBSCAN**](../../../../正典阁/技术栈/AI/聚类与%20DBSCAN.md)）；泊车目标筛选里的 IOU 去重是算两个框重叠比例再留一个（见 [**AI 字典·IoU 交并比**](../../../../正典阁/技术栈/AI/IoU%20交并比.md)）。

### 4.1 AebLightFusionProcessCalculator::Process()——AEB 专项过滤

输入是 tracker 输出的 `std::vector<base::ObjectPtr>`（共享指针，原地过滤）。处理分四层：

> 文件路径：/sandbox/perception/submodules/aeb/percep_aeb/onboard/calculators/aeb_light_fusion_process_calculator.cc  
> 函数名：AebLightFusionProcessCalculator::Process()  
> 核心逻辑：
> 
> ```cpp
> // (1) 雨天检测：统计 NOISE 语义点数量与关键区域雨点数
> for (size_t i = 0; i < lidar_outputs.semantics->size(); i += 1) {
>   uint32_t type = `static_cast<uint32_t>`(lidar_outputs.semantics->at(i));
>   if (type == base::PointSemanticType::NOISE) { ... key_rain_count += 1; ... }
> }
> if (rain_count > param_.rain_filter_threshold() ||
>     key_rain_count > param_.rain_filter_key_area_threshold()) {
>   consecutive_non_rainy_frames_ = 0;  is_rain_scene_ = true;
> } else { /* 连续 N 帧非雨才退出雨天态（防抖） */ }
> 
> // (2) GRIDMAP（栅格地图生成）目标：雨场景/雨栅格置状态码而非删除
> if (obj->algo_name == base::AlgoName::GRIDMAP) {
>   in_rain_grid = rain_grid_manager_->isPolygonInRainGrid(obj->polygon);
>   ...
>   if ((param_.rain_sence_filter_gridmap() && is_rain_scene_) ||
>       in_rain_grid || in_object_grid) {
>     update_status_for_objects(objects, it, status_map,
>         base::StatusCode::FILTERED_POLY_BY_RAIN_SCENE_OR_RAIN_GRID);
>   }
>   // 悬空/过矮多边形、植被、护栏臂等硬删除：
>   if (min_height > ground_z_ + param_.min_obstacle_filter_z()) {
>     it = erase_with_status_for_objects(objects, it, status_map,
>         base::StatusCode::FILTERED_BY_FLOATING_POLY, removedObjects);
>     continue;
>   }
> 
> // (3) DETECTOR（检测器）目标：盲区/非盲区分档分数阈值
> } else if (obj->algo_name == base::AlgoName::DETECTOR) {
>   bool blind_flag = is_blind_area(lidar_center.x(), lidar_center.y(),
>       param_.blind_area_angle_min(), param_.blind_area_angle_max(),
>       param_.blind_area_x_min(), param_.blind_area_x_max());
>   ...
>   float score_thres = param_.default_score_thres();
>   if (blind_flag) {  // 盲区阈值随距离线性衰减
>     switch (obj->type) { case base::ObjectType::SMALLMOT:
>       score_thres = CalBlindAreaScoreThres(lidar_center.x(), lidar_center.y(),
>         param_.blind_area_car_score_thres(),
>         param_.far_blind_area_car_score_thres(), param_.close_thres()); ... }
>   } else {           // 非盲区按距离分区间查表
>     int idx = FindScoreThredsIndex(param_.distance_boundary(), lidar_center.x());
>     switch (obj->type) { case base::ObjectType::SMALLMOT:
>       score_thres = param_.car_score_thres(idx); ... }
>   }
>   // (4) 置信度过滤（带跟踪时长豁免）：
>   if (obj->confidence < score_thres) {
>     if ((obj->type==SMALLMOT || obj->type==BIGMOT) &&
>         obj->tracking_time > param_.vehicle_traking_check_time())
>       score_filter_flag = false;          // 长期跟踪目标豁免
>     ...
>     it = erase_with_status_for_objects(objects, it, status_map,
>         base::StatusCode::FILTERED_BY_CONFIDENCE, removedObjects);
>   }
> ```
> 
> 逻辑说明：① 每个被删目标写入 `status_map`（detection_id→StatusCode），并被移入 `removedObjects`；② 函数末尾 `objects.insert(objects.end(), removedObjects...)` 把被删目标**重新放回输出**（L787-788）——即 AEB 输出包含"被过滤目标+过滤原因码"，由下游 AEB 控制组件自行判读，这是 AEB 专用输出区别于常规 `/perception/objects` 的关键设计。

> **📘 概念｜aeb 过滤链（AEB 专项目标过滤）**
> **是什么**：感知侧为安全兜底专门开的一条「质检线」——对 tracker 输出的目标做 AEB 视角的二次过滤（雨天/盲区/置信度/行人密集簇/悬空多边形等），输出「全量目标 + 过滤原因码」给车端 AEB 组件。它与 tracker 的区别：tracker 回答「这些目标是谁、在哪」，aeb 过滤链回答「哪些够格当安全威胁、哪些只是疑似」；它与常规 `/perception/objects` 输出的区别：普通输出丢掉被滤目标，AEB 输出把被滤目标贴 StatusCode 一起带上，让下游自主判读。
> **类比与角色映射**：aeb 过滤链是「机场安检的复核台」——tracker 是初检（把行李送上来，子模块3），复核台按更严的清单再查一遍：雨天雨点误报（RainGridManager 时空栅格）、盲区贴近距离规则（ped_blind_area_offset_ 行人 P03=7m 其余 3m、锥桶 M81/M82/M83=2m）、置信度分档（default_score_thres 距离查表+长期跟踪豁免）、扣留品不扔垃圾桶而是贴标签（StatusCode FILTERED_BY_CONFIDENCE 等）放回传送带；行车泊车两条传送带在此合流（AebMergeDrivingParkingObjsCalculator）。真实数字：连续非雨帧计数防抖（consecutive_non_rainy_frames_）、历史尺寸 LruMap 回填（history_obj_refine_infos_，track_id→w/l/h）。
> **🎯 为什么这样设计**：AEB 是最后的安全网，宁可多报不可漏报——被过滤目标也回传，让 AEB 控制组件自己决定「疑似目标要不要当威胁」，感知侧不替安全系统做决定；过滤逻辑全部参数化（AebLidarProcessParam proto），车型差异（CAR_ID 区分 P03/M81 等）靠配置切换不改代码。
> **🗂 代码在哪里**：percep_aeb/onboard/calculators/aeb_light_fusion_process_calculator.cc Process()（四层过滤）；被删目标回流 L787-788；行车/泊车合并 aeb_merge_driving_parking_objs_calculator.cc；泊车筛选 aeb_parking_calculator.cc。
>
> **30 秒最小例子**：雨天，前方 25m 检出一辆置信度 0.71 的静态车。雨检层：关键区雨点超阈值 → is_rain_scene_=true；GRIDMAP 层：该目标是 DETECTOR 来源不适用；DETECTOR 层：非盲区按距离查表得阈值 0.65，0.71 > 0.65 保留；若它只有 0.5——被 erase_with_status_for_objects 打上 FILTERED_BY_CONFIDENCE 移入 removedObjects，函数末尾又随全量输出回传，车端 AEB 组件看到状态码自行决定是否仍当威胁。

其它关键点：

- **尺寸历史保持**（L471-479）：`detection_id == -1`（tracker 未匹配）时用 LruMap 中历史 w/l/h 回填，避免目标闪烁。
- **行人速度/高度双重过滤**（L482-502）：运动行人高度过低或静止行人过矮则删除（对应飞书安全 bug 链接注释）。
- **DBSCAN 密集行人簇过滤**（`filterDensePedestrianTargets`，L825-882）：对行人做 DBSCAN 聚类，簇内分数低于簇中位数 `dense_ped_score_threshold` 的剔除（`FILTER_PED_BY_DENSE_STRATEGE`）。
- **GRIDMAP 高度拆分**（`splitGridmapObjectsByHeight`，L884-966）：按 `heights` 数组把"悬空段"与"落地段"拆成多个子多边形（`SPLIT_POLY_BY_HEIGHT`）。

### 4.2 AebMergeDrivingParkingObjsCalculator::Process()——行车/泊车目标合并

> 文件路径：/sandbox/perception/submodules/aeb/percep_aeb/onboard/calculators/aeb_merge_driving_parking_objs_calculator.cc  
> 函数名：AebMergeDrivingParkingObjsCalculator::Process()  
> 核心逻辑：
> 
> ```cpp
> cc->SetInputStreamHandler("ImmediateInputStreamHandler");  // 行车/泊车流异步到达
> ...
> if (param_.merge_avp_obj()) {
>   if (!aeb_packet.IsEmpty() && !avp_packet_.IsEmpty() && !lidar_packet_.IsEmpty()) {
>     // avp的障碍物时间戳要在一定范围
>     if (IsInTimeRange(merged_obstacles->..., avp_obstacles->...)) {
>       // first remove static car / truck in driving obstacles, we use avp
>       // static car for better position
>       for (auto it = mutable_aeb_obstacles->begin(); it != ...;) {
>         if ((obj.type()==VEHICLE || obj.type()==TRUCK) && 速度≈0
>             && IsInROI(...) && is_blind_area(...)) {
>           it = erase_with_status_for_obstacle(..., FILTERED_BY_AVP_MERGING, ...);
>         }  // 行车链路的盲区静态车被删除，改用 AVP（泊车环视）版本
>       }
>       for (int i = 0; i < avp_obstacles_sz; ++i) {
>         ...
>         if (obj.type()==PARK_FREESPACE &&
>             (freespace_type()==FS_OTHERS_STATIC || freespace_type()==FS_WALL))
>           keep_flag = true;                        // 松散自由空间（墙/静态物）
>         if (IsInROI(...) && is_blind_area(...)) keep_flag |= ShouldKeepObject(obj);
>         else if (IsInExtraROI(...)) keep_extra_flag = ShouldKeepObject(obj);
>         if (keep_flag || keep_extra_flag) { ...加进 merged_obstacles... }
>       }
>     } else { avp_packet_ = Packet(); }  // 超时清缓存
>   }
> }
> ```
> 
> 逻辑说明：合并策略为"**行车目标为骨架 + AVP 目标补盲区**"：行车链路盲区内的静态车用 AVP（环视+mighty）结果替换（位置更准）；AVP 侧仅保留 ROI 内感兴趣类型（`ShouldKeepObject`：行人/灭火器/静态车/高置信锥桶/各类 FreeSpace）。输出 `aeb_fusion_process_output`。AVP 侧目标的来龙去脉见 [**avp 泊车感知**（子模块6 §1）](子模块6：avp%20自动泊车感知子模块.md)。

### 4.3 AebParkingCalculator::UpdateAebObject()——泊车帧 AEB 目标筛选

> 文件路径：/sandbox/perception/submodules/aeb/percep_aeb/onboard/calculators/aeb_parking_calculator.cc  
> 函数名：AebParkingCalculator::UpdateAebObject()（QNX 平台用 aeb_parking_calculator_qnx.cc，BUILD 中 select 切换）  
> 核心逻辑：
> 
> ```cpp
> std::set&lt;int32_t> delete_fs_ids;
> MatchOtherClassObstaclesWithIOU(objects, delete_fs_ids); // freespace与非自由物IOU去重
> for (int i = 0; i < objects.perception_obstacle_size(); ++i) {
>   const auto& obj = objects.perception_obstacle(i);
>   if (delete_fs_ids.find(i) != delete_fs_ids.end()) continue;
>   if (obj.has_type() && (
>       obj.type()==PEDESTRIAN || obj.type()==BICYCLE || obj.type()==VEHICLE ||
>       (!param_.close_avp_bigmot() && obj.type()==TRUCK) ||
>       obj.type()==FIRE_HYDRANT ||
>       (obj.type()==TRAFFIC_CONE && obj.confidence_score() > param_.avp_cone_score_thres()) ||
>       (obj.type()==PARK_FREESPACE && ... FS_WALL/FS_LOCK_ON/FS_FENCE/FS_BIGCAR/...))) {
>     auto remain_obj = remain_obstacles.add_perception_obstacle();
>     remain_obj->CopyFrom(obj);
>     remain_obj->set_pt_size(10000);        // 点数标记放大（下游AEB识别用）
>   }
> }
> ```
> 
> 逻辑说明：泊车模式下直接从 AVP 目标集筛选 AEB 关心的类型；对 BICYCLE/VEHICLE 再用 CUDA `points_in_box` 把激光点云按 box 归属补充（L275-300 起）。输出 `aeb_parking_output`，最终走 `PerceptionOutputProcessCalculator FINAL_AEB:1`（graph_l2avp.cfg L1021，注释 "parking objetcs which do not merge driving objects"）。

## 5. 输入输出数据结构

**一句话结论**：输入 tracker 目标 + lidar 数据 + AVP 目标 + 上一帧回环，输出行车/泊车两路 AEB 目标集——被滤目标全量回传带原因码。

| 流 | 方向 | 类型 | 来源/去向 |
|-|-|-|-|
| `PREPROCESS`（tracker 目标） | 入 | `std::vector<base::ObjectPtr>` | 感知 tracker（主图 `INTER:1:tracking_preprocess_output`） |
| `LIDAR:0/1` | 入 | `base::LidarInputsWrapper` / `LidarOutputsWrapper`（含 pcd、semantics、status_map、tf） | lidar 子图 |
| `AVP_LIDAR` | 入 | `base::LidarInputsWrapper` | `mighty_lidar_inputs`（泊车前向激光） |
| `AVP` | 入 | `CombinedObstaclesPtr`（含 `PerceptionObstacles` + `avp_vis_obstacles`） | AVP 泊车目标 `mighty_obstacles_fusion_output` |
| `AEB`（回环） | 入 | `CombinedObstaclesPtr` | 上一帧 AEB 结果 |
| `AEB_PROCESS` | 出 | `std::vector<base::ObjectPtr>` | `PerceptionObjectsTransferCalculator` 回写 tracker |
| `AEB_PROCESS_MERGE` | 出 | `CombinedObstaclesPtr` | → `aeb_fusion_process_output` → `/perception_aeb/objects`（行车帧） |
| `AEB_PARKING` | 出 | `CombinedObstaclesPtr` | → `aeb_parking_output` → `/perception_aeb/objects`（泊车帧） |

消息 proto：`deeproute::perception::PerceptionObstacle(s)`（含 `StatusCode`、`freespace_type`、`PARK_FREESPACE` 类型）；内部参数 proto：`proto/aeb_lidar_process_param.proto`（`AebLidarProcessParam`）、`proto/aeb_post_processor.proto` 等。

被过滤目标携带状态码示例（均在 base::StatusCode 中）：`FILTERED_BY_CONFIDENCE`、`FILTERED_BY_RAIN_RATIO`、`FILTERED_CONE_BY_CONSECUTIVE_PT_HEIGHT`、`FILTERED_BY_NO_HEIGHT_OVERLAP`、`FILTERED_BY_AVP_MERGING`、`KEPT_BY_EXTRA_ROI`、`FILTER_PED_BY_DENSE_STRATEGE` 等。

## 6. 代码证据与关键片段

**一句话结论**：AEB 输出的独特设计是「被删目标回流」——质检不合格品贴标签放回传送带，而不是扔垃圾桶。

（§2/§4 已含 5 段核心片段：成员变量、参数单例、雨检+盲区分档过滤、行车/泊车合并、泊车目标筛选。此处补第 6 段——被删目标回流设计。）

> 文件路径：/sandbox/perception/submodules/aeb/percep_aeb/onboard/calculators/aeb_light_fusion_process_calculator.cc  
> 函数名：AebLightFusionProcessCalculator::Process()（末段）  
> 核心逻辑：
> 
> ```cpp
> filterDensePedestrianTargets(objects, param_.ped_dbscan_eps(),
>                              param_.ped_dbscan_minp(), status_map,
>                              removedObjects);
> 
> objects.insert(objects.end(), removedObjects.begin(),
>                removedObjects.end());          // 被过滤目标重新放回输出
> auto out_packet = MakePacket&lt;std::vector&lt;base::ObjectPtr>>(objects);
> cc->Outputs().Get(kOutputTag, 0)
>     .AddPacket(out_packet.At(cc->Inputs().Get(kInputTag, 0).Value().Timestamp()));
> ```
> 
> 逻辑说明：AEB 输出不是"干净目标列表"，而是**全量目标 + 每目标 StatusCode**。下游独立 AEB 组件可据此区分"确认障碍物"与"疑似/被过滤障碍物"，用于 AEB 误触发抑制策略。（`update_status_for_objects` 与 `erase_with_status_for_objects` 定义于 utils/filter_utils.h。）

### 6.1 非主链路文件索引

| 目录/文件 | 说明 | C01 状态 |
|-|-|-|
| percep_aeb/modules/postprocess/detector_base.*、detector_post_processor.* | AEB 独立检测 NN 后处理 | 未启用（仅 AebProcessCalculator 用） |
| percep_aeb/onboard/calculators/aeb_process_calculator.cc、aeb_light_process_calculator.cc | AEB 独立检测子图 | 未在 l2avp 图引用 |
| accel_ops/（cpu/cuda/opencl 三后端 detector_utils、points_in_box、memset_util） | 加速算子 | points_in_box 被 AebParkingCalculator 引用 |
| aeb_cuda_utils/ | CUDA 工具 | 同上 |
| proto/\*.proto | 参数与配置 proto | 已用 |
| perception_routing 式后处理 | 无 | — |

### 6.2 平台差异标注

- 行车过滤逻辑含 `#ifdef __QNX__` 分支（如非盲区点数过滤 L657-661：x86 允许 D03 行人盲区豁免，QNX 不允许）；C01 orinx 走非 QNX 分支。
- 泊车 calculator 文件级切换：QNX 用 `aeb_parking_calculator_qnx.cc`，其余用 `aeb_parking_calculator.cc`（onboard/calculators/BUILD.bazel `select()`）。
- 本模块随 perception 仓库在 `Stable_Master_4.0_new` 分支；platform/church 仓库在 `dev_master` 分支，两者独立演进，话题/类型契约以上述 proto 与 jsonnet 为准。

## 7. FAQ 与自测

**FAQ**：

**Q1：感知侧 AEB 会帮忙刹车吗？**（新手常见误解）
不会。submodules/aeb 只做目标级过滤/富化/合并，全仓库 grep 不到任何 TTC 计算或制动请求代码；做碰撞判断与制动的是 driver 仓独立 AEB 组件，两者靠 `/perception_aeb/objects` 话题衔接（§1.1）。把它当「AEB 控制器」是本篇最常见误解。

**Q2：被过滤掉的目标去哪了？会不会影响其它功能？**
没消失。它们被打上 StatusCode（FILTERED_BY_CONFIDENCE、FILTERED_BY_AVP_MERGING 等）随全量目标回传（§4.1/§6）；这只影响 `/perception_aeb/objects` 这条 AEB 专用输出，常规 `/perception/objects` 不受影响。

**Q3：为什么行车链路的盲区静态车要换成 AVP 版本？**
环视泊车相机对近距目标位置更准——行车链路盲区内速度≈0 的车/卡车被删除，改用 AVP 结果补位（FILTERED_BY_AVP_MERGING）；AVP 侧只保留 ROI 内感兴趣类型（行人/静态车/墙/自由空间等）（§4.2）。

**Q4：AebProcessCalculator 为什么在 C01 没用上？**
它属于 AEB 独立检测子图（自带 NN 后处理），只被 aeb_sub_graph.cfg / aeb_sub_graph_light.cfg 引用，而这两个 cfg 在 C01 l2avp 主图未被引用——属于其它图配置/历史方案，C01 的 AEB 目标来自 tracker + 过滤链（§3.1）。

**自测**：
1. AEB 输出与常规 `/perception/objects` 最大的区别是什么？
    AEB 输出是「全量目标 + 每目标 StatusCode」——被过滤目标不丢弃，贴原因码回传，供车端 AEB 组件自主判读与误触发抑制。
2. 盲区内小目标的置信度阈值怎么定？
    阈值随距离线性衰减（CalBlindAreaScoreThres），越近越宽松，避免近处漏报；非盲区按距离区间查表取阈值。
3. 雨天态怎么退出？为什么需要防抖？
    连续 N 帧非雨（consecutive_non_rainy_frames_ 计数）才退出；单帧雨点波动就切换会来回抖动，导致过滤状态不稳定。
