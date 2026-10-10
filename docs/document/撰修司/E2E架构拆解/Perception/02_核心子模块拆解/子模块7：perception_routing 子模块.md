---
title: "子模块7：perception_routing 子模块"
date: 2026-09-20
description: "感知路由子模块：导航信息处理与 map_engine 交互边界。"
categories:
  - 撰修司
tags:
  - Perception
  - E2E
---

> **30 秒导读**：感知路由子模块：导航意图与地图信息怎么进入感知视角。
> **本篇回答**：导航信息从哪来？感知怎么用它？与 map_engine 的边界在哪？
> **先修阅读**：《02 Topic 拓扑》地图相关 Topic。

> **本篇概念速成块**（30 秒，读完再进正文不卡壳）：
> - **DDRouting**：导航信息翻译官——把 SDMap/LOR/FusionSdMap 渲染成 uni_model 吃的四层张量（完整卡片见 §4）。
> - **路由先验**：告诉模型「导航想往哪走」的先验输入，不是实时可行驶区域——RASMap 由 uni_model 自行推理（子模块内 grep 0 命中）。
> - **四层张量**：车道数 / 路由掩码 / 车道朝向 cos / 车道朝向 sin（400×240 图，前向 200m、左右各 60m）。
> - **LOR 修正**：定位基准用车道级定位替代 GPS，偏差 >60m 时以 LOR 修正渲染原点，防 GPS 漂移带偏（§4）。
> - **GCJ02→车体系**：国测局加密坐标经 UTM 投影转到车体系再渲染（§4）。
> - **降级设计**：任一输入缺失 → 张量 Memset(0) 清零照常输出 + 有效标志 false，模型输入形状恒定（§3.2）。
> - **引导动作**：来自 FusionSdMap.guidance()；旧 ROUTING_GUIDE_ACTION 接线保留但源码已注释停用（§1）。


> 仓库路径：`/sandbox/perception/submodules/perception_routing`（perception 分支 `Stable_Master_4.0_new`，当前检出即目标分支）。  
> 规模最小：14 个 C/C++ 源文件。README 自述 `perception_map_engine_part`、`contains ddrouting`，"入口文件在 calculator 下面，从这里开始，是模型的预处理和后处理"。

## 1. 子模块定位与职责

**一句话结论**：perception_routing 是「导航→模型」的翻译管道——把地图/导航渲染成四层 NN 张量喂 uni_model，顺带给视觉子图车体系路由链路；不产 RASMap。

**为什么 E2E 模型需要导航先验**：纯看摄像头难以回答「前方岔路该走哪条道」——摄像头不知道司机设的目的地。E2E 模型又不能直接吃文本导航（「前方 300 米右转」这种字符串模型读不懂），只能吃与图像同构的空间张量。perception_routing 干的就是这场翻译：把地图与导航意图画成 400×240 的图，让模型「看图」理解导航意图。

**perception_routing（感知路由预处理子模块）**负责 **DDRouting（端到端导航路由数据生成）：把 SDMap（标准地图）、LockOnRoad（车道级定位，LOR）、FusionSdMap（融合地图+导航引导动作）** 等离线地图/导航信息，渲染成 **E2E 统一感知大模型 uni_model 可直接消费的 NN 输入张量**，并把车体系下的路由链路提供给视觉子图。

**与 RASMap/可行驶区域的关系（已验证）**：本子模块**不产生 RASMap（实时可行驶区域地图）**（RASMap 是泊车侧的地图概念，见 [**avp 泊车感知**（子模块6 §5）](子模块6：avp%20自动泊车感知子模块.md)）——在子模块全部源码中 grep `RASMap|ras_map` 为 **0 命中**；可行驶区域由 uni_model 消费本子模块输出后自行推理得出。本子模块提供的是**路由先验**（routing links、引导动作、车道级位置），属于"导航信息 → 感知模型输入"的数据管道。

**与导航路由建议的关系**：C01 图中 `ROUTING_GUIDE_ACTION` 虽有接线（graph_l2avp.cfg L478），但 calculator 源码中该处理块整体被注释（`// BM input, deprecated later`，L226-255）；当前生效的引导动作来自 `FusionSdMap.guidance()`。

## 2. 核心类结构与成员变量

**一句话结论**：一个 calculator + 一个算法类 + 三个适配器——14 文件的小子模块，核心全在 1074 行的 DDRoutingDataGen。

| 类 | 文件 | 职责 |
|-|-|-|
| `MapEngineDdRoutingPreProcessCalculator` | calculator/map_engine_ddrouting_pre_process_calculator.cc（367行） | 图节点：收流/缓存/投影初始化/调度预处理/输出 |
| `DdRoutingPreProcess` | module/ddrouting_preprocess/ddrouting_preprocess.cpp（153行） | 组合适配层：InsAdapter + DDRoutingDataGen |
| `DDRoutingDataGen` | module/ddrouting_preprocess/ddrouting_data_generate.cpp（1074行，子模块最大文件） | 核心算法：坐标转换 + 四层张量渲染 |
| `InsAdapter` | module/data_adapter/ins_adapter.cpp | 把 SensorsIns（组合惯导消息）转为内部 Ins 格式 |
| `UtmProjector` | module/data_adapter/utm_projector.cpp | 经纬度 → UTM（通用横轴墨卡托投影）转换 |
| `publish_ros_img` | module/debug/publish_ros_img.cc | 调试可视化图发布（仅 debug 构建） |

Calculator 私有成员（L345-363）：`output_nn_data_`（NNInternalDataType，4 层 GPU 节点缓冲）、`projection_`/`projection_initialized_`（首帧有效 GNSS 的 llh 设定的投影原点）、五个输入缓存（`gnss_pose_`/`lock_on_road_`/`sd_horizon_map_`/`fusion_sd_map_`/`routing_guide_action_`）、`routing_pre_process_`。

渲染几何常量（module/ddrouting_preprocess/const_value.h L7-21）：图像 400×240，覆盖范围 x∈[-60,200]m、y∈[-60,60]m（前向 200m、左右各 60m）。

## 3. 核心处理流程与函数调用链

**一句话结论**：主图独立挂一个节点，五入四出；内部链 ＝ 收流 → 首帧投影初始化 → 渲染 → 逐层拷 GPU。

### 3.1 C01 l2avp 图调用点（已验证）

主图 `perception/cfg/graphs/onnx/graph_l2avp.cfg` L468-485 独立挂载本子模块唯一 calculator：

```cfg
node {
  name: "map_engine_ddrouting_preprocess_calculator"
  calculator: "MapEngineDdRoutingPreProcessCalculator"
  input_side_packet: "MODEL_CONFIG:uni_model_nn_param_path"
  input_side_packet: "CAR_CONFIG_PROTO:car_config_proto"
  input_stream: "SD_MAP:sd_map_input"
  input_stream: "GNSS_POSE:gnss_pose"
  input_stream: "LOCK_ON_ROAD:lock_on_road"
  input_stream: "ROUTING_GUIDE_ACTION:routing_guide_action"
  input_stream: "FUSION_SD_MAP:fusion_sd_map"
  output_stream: "DDROUTING_MODEL_INPUT:ddrouting_model_input"
  output_stream: "ROUTING_INPUT_VALID_FLAG:routing_input_valid_flag"
  output_stream: "VEHICLE_ROUTING_LINKS:vehicle_routing_links"
  output_stream: "VEHICLE_HORIZON_MAP_LINKS:vehicle_horizon_map_links"
}
```

下游去向（均已 grep 验证）：`ddrouting_model_input` → `UnimodelPreProcessCalculator INFER_IN:14`（L554，[**uni_model**（子模块1 §1.3）](子模块1：camera%20相机感知子模块.md) E2E 统一大模型的第 14 路输入）；`routing_input_valid_flag`/`vehicle_routing_links`/`vehicle_horizon_map_links` → `CameraProcessSubgraphL2AVP`（L329-331）。

```mermaid
graph LR
    G[GNSS_POSE 组合惯导] --> C[MapEngineDdRoutingPreProcessCalculator]
    S[SD_MAP 地平线路由图] --> C
    L[LOCK_ON_ROAD 车道级定位] --> C
    F[FUSION_SD_MAP 融合图+引导动作] --> C
    R[ROUTING_GUIDE_ACTION
源码中已注释停用] -.-> C
    C --> O1[DDROUTING_MODEL_INPUT 四层NN输入]
    C --> O2[ROUTING_INPUT_VALID_FLAG]
    C --> O3[VEHICLE_ROUTING_LINKS]
    C --> O4[VEHICLE_HORIZON_MAP_LINKS]
    O1 --> U[UnimodelPreProcessCalculator
INFER_IN:14 → uni_model]
    O2 --> CAM[CameraProcessSubgraphL2AVP
主图L329-331]
    O3 --> CAM
    O4 --> CAM
```

**图 3-1 · DDRouting 数据流（地图/定位四入 → 渲染 → uni_model 第 14 路输入 + 视觉子图）**（C 是唯一节点，虚线为已停用流）

**读图提示**：① O1 是重头——四层张量从 INFER_IN:14 进入 uni_model（[**uni_model**（子模块1 §1.3）](子模块1：camera%20相机感知子模块.md) 的统一大模型输入）；② O2~O4 三路给视觉子图做辅助；③ R 虚线是「接线保留但源码注释」的历史流，读图时别被误导。

### 3.2 内部函数链

`Process()` → `TryReceiveNewData()`（收流+缓存校验）→ `TryInitialize()`（首次有效 GNSS 初始化投影原点）→ `DdRoutingPreProcess::GenerateDataForInference()` → `InsAdapter::GetIns()` → `RoutingPreprocess()` → `DDRoutingDataGen::GenerateDataForInference()`（渲染）→ 逐层拷贝进 GPU 缓冲。

失败降级路径：任一输入缺失/匹配失败 → `ROUTING_INPUT_VALID_FLAG=false`，四层张量 `Memset(0)` 清零后仍照常输出（L324-331），模型照跑、标志位告知下游数据无效。

## 4. 核心算法入口与关键逻辑

**一句话结论**：核心是四层张量渲染与定位基准选择——LOR 优先、GCJ02 转 UTM 再转车体系、PULL_OVER 特例 110m。

**代码里出现的 AI 名词**：`e2e_action_one_hot` 是**独热编码**——用「只有一位是 1 其余全 0」的向量表示离散类别（如「直行/左转/右转」各占一位），是模型吃离散指令的标准格式（见 [**AI 字典·独热编码 one-hot**](../../../../正典阁/技术栈/AI/独热编码%20one-hot.md)）；车道朝向拆成 cos/sin 两层是避免「359°与 1° 数值上差很远」的角度编码技巧，与归一化同属特征预处理思路（见 [**AI 字典·归一化**](../../../../正典阁/技术栈/AI/归一化.md)）。

> 文件路径：/sandbox/perception/submodules/perception_routing/module/ddrouting_preprocess/ddrouting_data_generate.cpp  
> 函数名：DDRoutingDataGen::GenerateDataForInference()（L780 起）  
> 核心逻辑：
> 
> ```cpp
> inference_data_.clear();
> // (20240301 update @lzm) use LOR position instead of GPS.
> const common::Point3D& lor_position = lock_on_road.matched_position_wgs84();
> projection_.LatLonToUtm(lor_position.y(), lor_position.x(),
>                         &lor_utm_x, &lor_utm_y);
> Eigen::Vector3d global_translation = global_pose.GetTranslation();
> const double gps_to_lock_on_road_dist = (lor_utm_x - global_translation[0]) * ...
> if (gps_to_lock_on_road_dist > 60.0 * 60.0) {   // GPS 与 LOR 偏差 >60m
>   global_translation[0] = lor_utm_x;            // 用 LOR 位置修正 GPS
>   global_translation[1] = lor_utm_y;
> }
> ::common::Transformation3 lor_pose(global_pose.GetRollPitchYaw(), global_translation);
> vehicle_frame_routing_links =
>     ConvertRoutingResponseFromGcj02ToVehicleFrame(routing_response, projection_, lor_pose);
> vehicle_frame_horizon_map_links =
>     ConvertHorizonMapToVehicleFrame(horizon_map, projection_, lor_pose);
> ...
> // Note(20240725): layer order definition: road net lane num(0-1),
> //                 routing link mask(0,1), road net cos, road net sin
> all_samples.insert(all_samples.end(), map_samples.begin(), map_samples.end());
> all_samples.insert(all_samples.begin() + 1, route_samples.begin(), route_samples.end());
> ...
> // Ad hoc. When pull over set distance to 110
> if (fusion_sd_map.fusion_map_type() == ...FUSION_MAP_TYPE_PULL_OVER) {
>   fusion_sd_map.mutable_guidance()->set_distance_to_next_step(110.0);
> }
> std::vector&lt;float> e2e_action_one_hot(
>     3 * main_action_length + 2 * assistant_action_length, 0.0f);
> ```
> 
> 逻辑说明：① **定位基准用 LOR 替代 GPS**（20240301 注释），GPS-LOR 距离 >60m 时以 LOR 修正，防 GPS 漂移带偏渲染原点；② `ConvertRoutingResponseFromGcj02ToVehicleFrame`/`ConvertHorizonMapToVehicleFrame` 把 **GCJ02（国测局加密坐标系）** 路由/地图链路经 UTM 转到**车体系**；③ `RenderMapInfo`/`RenderRouteInfo` 渲染四层：车道数、路由掩码、车道朝向 cos/sin（层序注释 20240725）；④ 靠边停车（PULL_OVER）特例把引导距离强制 110m；⑤ `e2e_action_one_hot` 为 main/step_main/assistant/step_assistant 四组 one-hot 拼接，不常见动作映射到公共 bit（L905-906 注释）。

> **📘 概念｜DDRouting（端到端导航路由先验）**
> **是什么**：把「导航想去哪」翻译成感知大模型能吃的图——把 SDMap（标准地图）、LockOnRoad（车道级定位）、FusionSdMap（融合地图+引导动作）渲染成 4 层 NN 张量（车道数/路由掩码/朝向 cos/sin），作为 uni_model 的第 14 路输入。它与 RASMap 的区别：DDRouting 是「离线地图+导航意图」的先验输入，RASMap 是模型推理出的「实时可行驶区域」输出——前者喂模型，后者是模型产物；它与 planning 侧参考线的区别：这里是给感知模型的路由暗示，不是规划轨迹参考线。
> **类比与角色映射**：DDRouting 是「考前划重点的助教」——教材（SDMap 路网）、学生当前位置（LockOnRoad）、考试范围提示（FusionSdMap 引导动作）都摊在桌上，助教把「从这到目的地走哪条道」画在 400×240 的答题卡上（四层：第 0 层车道数、第 1 层路由掩码、第 2/3 层车道朝向 cos/sin），覆盖前向 200m、左右各 60m；划重点前先校准桌子位置（LOR 修正 GPS，偏差>60m 以 LOR 为准）；助教缺课（输入缺失）不撕答题卡，把答题卡涂空白（Memset(0)）+贴「本次划重点无效」便签（ROUTING_INPUT_VALID_FLAG=false），考试照常进行。真实数字：图像 400×240；GPS-LOR 修正阈值 60m；缓存超时 2s/融合图 20s。
> **🎯 为什么这样设计**：E2E 模型需要导航意图但不能直接吃文本导航——渲染成与相机/BEV 同构的空间张量最顺；LOR 修正防 GPS 隧道漂移把渲染原点带偏；清零+标志位的降级让模型输入形状恒定，下游无需判空分支。
> **🗂 代码在哪里**：module/ddrouting_preprocess/ddrouting_data_generate.cpp GenerateDataForInference()（L780 起，1074 行最大文件）；投影初始化 calculator TryInitialize()（L133-170）；层序定义注释 20240725。
>
> **30 秒最小例子**：车在路口准备直行。LOR 报出车道级位置（wgs84），投影成 UTM 原点；SDMap 的 routing response 里下一段直行链路被 ConvertRoutingResponseFromGcj02ToVehicleFrame 转进车体系，渲染到第 1 层「路由掩码」——本车道亮、邻道暗；第 2/3 层画出车道朝向的 cos/sin 分量；四层张量经 CopyFrom 逐层拷进 GPU 缓冲，从 UnimodelPreProcessCalculator INFER_IN:14 进入 uni_model——模型「看图」知道导航让它沿本车道直行，推理时给直行车道的权重更高。

Calculator 侧缓存与降级逻辑（calculator L180-215）：`sd_horizon_map` 校验三要素（路由响应、路网、完整性），无效沿用缓存，超过 `kClearCacheIntervalMs=2s` 未更新则清空；`fusion_sd_map` 超时为 10 倍（20s，L277）。

## 5. 输入输出数据结构

**一句话结论**：入＝惯导+三种地图；出＝四层 GPU 张量+有效标志+车体系链路。

| 流 | 方向 | 类型 | 说明 |
|-|-|-|-|
| `GNSS_POSE` | 入 | `SensorsIns` | 组合惯导（llh + 位姿），用于初始化投影与全局位姿 |
| `SD_MAP` | 入 | `SdHorizonMap` | 地平线路由图（routing response + 路网） |
| `LOCK_ON_ROAD` | 入 | `LockOnRoadResult` | 车道级定位（含 `matched_position_wgs84`） |
| `ROUTING_GUIDE_ACTION` | 入 | `GuidanceActionList` | 旧版引导动作，**源码已注释停用** |
| `FUSION_SD_MAP` | 入 | `FusionSdMap` | 融合地图 + `guidance`（main/assistant action） |
| `DDROUTING_MODEL_INPUT` | 出 | `NNInternalDataType` | 4 层 GPU 张量：sdmap_mat / e2e_action_one_hot / e2e_bitmap_one_hot / e2e_distance（L52-57） |
| `ROUTING_INPUT_VALID_FLAG` | 出 | `bool` | 预处理是否成功 |
| `VEHICLE_ROUTING_LINKS` / `VEHICLE_HORIZON_MAP_LINKS` | 出 | `std::vector<sd_map::LinkData>` | 车体系路由链路/地平线链路（供视觉子图） |

side packet：`MODEL_CONFIG`（`NnInternalParameter`，uni_model 的输入节点形状，Open 时按名字匹配 4 层并分配 GPU 缓冲，L100-128）、`CAR_CONFIG_PROTO`（`VehicleConfig`，取 vehicle→imu 外参）。

## 6. 代码证据与关键片段

**一句话结论**：两段补充证据锁死投影初始化与数据搬运细节；非 map_engine 版 calculator 是历史方案。

补充证据一：投影初始化（calculator L133-170，`TryInitialize()`）——仅当 GNSS 类型非 `INVALID/UNCONVERGE_DR` 且带 llh 时，用 `imu_frame_position_llh()`（缺省回退 vehicle 系）设定 `projection_`，并连同 vehicle→imu 平移、400×240 尺寸构造 `DdRoutingPreProcess`；此后不再重复初始化（`Process` L290-292 判 `projection_initialized_`）。

补充证据二：数据搬运（ddrouting_preprocess.cpp L142-147，`DdRoutingPreProcess::GenerateDataForInference()`）——`for (idx...) node_buffer.CopyFrom(input.data(), input.size()*sizeof(float), *compute_stream)` 把 CPU 侧 `GetInferenceData()` 结果逐层拷入预分配 GPU 缓冲，QNX/x86 走同一逻辑（`__QNX__` 仅影响 `dr_infer.h` 头文件引入，L8-10）。

**未验证**：`calculator/ddrouting_pre_process_calculator.cc`（非 map_engine 版本）未在 C01 l2avp 主图中找到引用，属其它图配置/历史方案（grep 结论）。

## 7. FAQ 与自测

**FAQ**：

**Q1：perception_routing 会不会输出可行驶区域？**（新手常见误解）
不会。它是感知侧「导航信息→NN 张量」的预处理；全源码 grep `RASMap|ras_map` 为 0 命中，可行驶区域由 uni_model 消费其输出后自行推理得出（§1）。把它当「感知版路由规划器」是常见误解。

**Q2：为什么用 LOR 而不是 GPS 定位？**
LOR 是车道级定位、更稳；GPS-LOR 偏差 >60m 时以 LOR 修正渲染原点（20240301 更新），防 GPS 隧道/高楼漂移把「划重点」画歪（§4）。

**Q3：ROUTING_GUIDE_ACTION 流为什么接了却没用？**
接线保留但 calculator 源码中该处理块整体被注释（`// BM input, deprecated later`，L226-255），当前生效的引导动作来自 FusionSdMap.guidance()（§1）。

**Q4：输入缺失时模型会挂吗？**
不会。任一输入缺失/匹配失败 → 张量 Memset(0) 清零照常输出 + ROUTING_INPUT_VALID_FLAG=false，模型输入形状恒定，下游无需判空分支（§3.2）。

**自测**：
1. DDRouting 四层张量分别是什么？
    车道数（road net lane num）、路由掩码（routing link mask）、车道朝向 cos、车道朝向 sin（层序注释 20240725）。
2. 渲染覆盖范围多大？
    400×240 图像，前向 200m、左右各 60m（const_value.h L7-21）。
3. sd_horizon_map 缓存什么时候清？
    三要素（路由响应/路网/完整性）校验无效时沿用缓存，超过 kClearCacheIntervalMs=2s 未更新则清空；fusion_sd_map 超时 10 倍=20s。
