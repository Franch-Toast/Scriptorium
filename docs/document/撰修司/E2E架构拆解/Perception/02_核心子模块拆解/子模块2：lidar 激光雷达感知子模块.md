---
title: "子模块2：lidar 激光雷达感知子模块"
date: 2026-09-20
description: "激光雷达感知子模块：点云特征提取、heatmap 峰值解码与地面分割节点被注释的现状。"
categories:
  - 撰修司
tags:
  - Perception
  - E2E
---

> **30 秒导读**：激光雷达检测子模块：点云怎么一步步变成带方向的目标框。
> **本篇回答**：点云特征怎么提取？目标怎么解码出来？传统地面分割为什么被注释掉了？
> **先修阅读**：《00 入门》§3 步骤 3；《Perception 01 输入》。

> **本篇概念速成块**（30 秒，读完再进正文不卡壳）：
> - **lidar 子模块**：点云的「粗加工车间」——主检测同样走 uni_model（激光分支），本仓专精点云工程：补偿→过滤→体素化→解码→静态物→融合（§1.3）。
> - **点云**：数十万带距离/反射率的三维点（完整卡片见 [**Perception/01 §5.2**](../01%20输入数据接入与预处理.md)）。
> - **运动补偿**：雷达扫描要转一圈（期间车在动），按定位位姿把「早扫的点」搬到「该在的位置」——快门从上到下扫完，人已经走了半步，照片要修齐（§3.2）。
> - **体素化**：把散点装进规则小格子（voxel），模型只吃格子特征不直接吃散点（§3.3）。
> - **heatmap 解码**：模型输出的是「哪里可能有目标」的热力图，解码 kernel 找峰值换算成 3D 框（§3.4）。
> - **OCC 静态物**：占用栅格——结合 uni_model 的 BEV 语义头把「哪里有不动的东西」栅格化（§3.5）。
> - **fake points**：车前 21 个固定假点，空点云兜底用（§3.2）。


> 代码根目录：`/sandbox/perception/submodules/lidar`（约 309 个源文件）  
> 分支说明：perception 及其 submodules 位于 `Stable_Master_4.0_new`（当前检出即该分支）；平台层 platform/church 位于 `dev_master`，本文不涉及平台层差异。  
> 本文所有结论均给出代码证据；无法给出证据的推断处标"推断"。

## 1. 子模块定位与职责

**一句话结论**：lidar 与 camera 同构——主检测上交 uni_model 激光分支，本仓专注点云工程链：预处理五件套（补偿/剔本车/ROI/采样/体素化）+ 解码回填 + 静态物 + 融合；传统地面分割已退役（节点被注释）。

**为什么 lidar 与 camera 长得像**：两者是同一套架构思路的两次落地——主检测都上交 uni_model（一个吃图像一个吃点云），子模块仓都专注「把原料整理成模型爱吃的形状」（camera 洗图、lidar 整点云）和「把模型输出翻译成目标」（各自解码）。看懂其中一个，另一个的目录结构与数据流几乎是镜像的。

### 1.1 代码仓库结构

lidar 与 camera 同构（独立 bazel/cmake 仓，以子模块集成进 perception 主仓）：

```
lidar/
├── modules/            # 算法模块（业务核心）
│   ├── detection/      # 主检测链：pre_processor / infer / post_processor（C++/CUDA）
│   ├── occupancy/      # OCC/gridmap 占用栅格（消费 uni_model 的 BEV 头）
│   ├── gridmap/        # 静态目标 gridmap
│   ├── ground_detector/  # 地面检测（CSF/三角面等实现；L2AVP 图中主地面检测节点已注释）
│   ├── roi_filter/     # ROI 过滤（bitmap）
│   ├── fusion/         # LidarObjectFusion 多来源目标融合
│   ├── rain_refine/    # 雨雾点云修正
│   ├── invisible_detector/ # 雷达盲区/不可见目标
│   ├── anomalies/      # 雷达异常检测（GPU RV 网格）
│   ├── motionseg/      # 运动分割（L2AVP 主图未见调用，未验证）
│   ├── segmentation/ semantic_seg/ overhead_occupancy/ ca_detector/ dolphin/ ...
│   └── lidar_modules.hpp
├── onboard/calculators/  # graphpipe 计算节点
├── accel_ops/ cuda_utils/ # CUDA 加速算子
└── cfg/graphs/lidar_sub_graph.cfg  # LidarOccProcessSubgraph 子图定义
```

### 1.2 在 C01 L2AVP 中的调用点（已验证）

主感知子图 `PercepL2AvpSubgraph`（`/sandbox/perception/perception/cfg/graphs/onnx/graph_l2avp.cfg` 第 247\~276 行）中，**lidar 子图以节点 `LidarOccProcessSubgraph` 被显式调用**：

```cfg
node {
  calculator: "LidarOccProcessSubgraph"
  input_stream: "LIDAR_INPUTS:lidar_inputs"
  input_stream: "UNI_MODEL_OUTPUT:uni_model_output"
  ...
  output_stream: "LIDAR_PROCESS_OUTPUT:lidar_process_output"
  output_stream: "LIDAR_BACKBONE_NETWORK_INPUT:lidar_backbone_network_input"
  output_stream: "NN_OUT:fusion_detection_network_output"
  output_stream: "STATIC_OBJECTS:lidar_grid_map_static_objects"
  ...
}
```

子图本体即 `/sandbox/perception/submodules/lidar/cfg/graphs/lidar_sub_graph.cfg`（BUILD.bazel 第 11 行 `register_name = "LidarOccProcessSubgraph"`）。

### 1.3 职责划分（重要结论）

C01 L2AVP 中 lidar 主检测模型同样是 **uni_model 的激光分支**（`unimodel_lidar_preprocess` 产出 voxel 输入）。lidar 子模块职责：

1. **点云预处理**：运动补偿、本车点剔除、ROI 过滤、采样、体素化特征（`filter_pc`/`idx_info`/`cur_frame_mask_within_range`）；
2. **检测后处理**：解码 `heatmap/reg/dim/rot/vel/heading/subtype/attr/door_attr` 等头为 3D 框，并做语义点云回填；
3. **占用栅格/静态物**：消费 uni_model 的 `static_bev_output`/`ground_bev_output`/`cstr_bev_*` 头，结合点云输出静态目标（gridmap/OCC）；
4. **点云级修正与融合**：rain_refine、invisible_detector、`LidarObjectFusion` 把检测目标与静态物/运动概率融合成 `lidar_process_output`；
5. **质量监控**：`LidarAnomaliesCalculator` 检测雷达异常。

**关于"地面分割/聚类"**：传统的 `LidarGroundDetectionCalculator` 节点在 lidar_sub_graph.cfg L62\~71 中**整段被注释**——即 L2AVP 不再走独立地面分割；地面高度信息改由 uni_model 的 `ground_bev_output` 头 + `GroundHeightLevel` 状态（`ParamSingleton::GetLastGroundHeightLevel()`，参与预处理旋转策略）承担。经典 ground_detector 模块仍在仓内，但未挂入 L2AVP 图（未验证其在其它车型配置中的使用）。

## 2. 核心类结构与成员变量

**一句话结论**：三类容器一层节点——Wrapper（主图交接）/ AlgoProcessInput（算法输入，含 GPU 点云）/ Frame（帧级结果），节点全是薄壳，真算法在 modules/detection 的 Pre/Post Processor。

### 2.1 主要类清单

| 类/Calculator | 文件 | 职责 |
|-|-|-|
| `LidarInputsWrapper` | `/sandbox/perception/submodules/base/lidar/lidar_basic_type.h` L19 | 点云+位姿输入容器（主图→lidar 子图） |
| `LidarAlgoProcessInput` | `/sandbox/perception/submodules/base/lidar/lidar_context.h` L21 | lidar 算法输入（含 `cloud_gpu`） |
| `LidarFrame` | `/sandbox/perception/submodules/base/lidar/lidar_frame.h` L21 | 帧级数据（点云、点语义/标志、各类目标） |
| `LidarPointCheckCalculator` | `lidar/onboard/calculators/lidar_point_check_calculator.cc` | 入口：补偿+fake points+打包 |
| `LidarPointEgoCarCalculator` / `LidarRoiFilterCalculator` | 同目录 | 本车点剔除、ROI 过滤 |
| `LidarDetectionPreProcessCalculator` | `lidar/onboard/calculators/lidar_detection_preprocess_calculator.cc` | 调 `DetectorPreProcessor` 产 NN 输入 |
| `DetectorPreProcessor` | `lidar/modules/detection/detector_pre_processor.hpp` L39 | 采样/体素化（CUDA） |
| `LidarDetectionProcessCalculator` | `lidar/onboard/calculators/lidar_detection_process_calculator.cc` | 调 `DetectorPostProcessor` 解码 |
| `DetectorPostProcessor` | `lidar/modules/detection/detector_post_processor.hpp` | BoxesDecode、语义回填、组装目标 |
| `LidarOccupancyCalculator` | `lidar/onboard/calculators/lidar_occupancy_calculator.cc` | OCC/gridmap 静态物 |
| `LidarFusionProcessCalculator` | `lidar/onboard/calculators/lidar_fusion_process_calculator.cc` | `LidarObjectFusion` 融合并打包输出 |
| `ParamSingleton` | `lidar/onboard/calculators/lidar_processor_base.h` L59 | 参数/盲区/地面高度单例 |

### 2.2 关键结构体

**输入容器 `LidarInputsWrapper`**（base/lidar/lidar_basic_type.h L19\~25）：

```cpp
struct LidarInputsWrapper {
  uint64_t lidar_frame_id{};
  PointCloudXYZIBT::Ptr pcd{};                 // PCL 点云(XYZI+Beams+Timestamp)
  uint64_t timestamp_in_microsecond;
  std::shared_ptr<common::Transformation3> tf{};
  common::InternalPoseConstPtr pose_ptr{};
  std::shared_ptr<common::Transformation3> vehicle_to_sensing{};
};
```

**算法输入 `LidarAlgoProcessInput`**（base/lidar/lidar_context.h L21\~58）：

```cpp
struct alignas(16) LidarAlgoProcessInput {
  uint64_t lidar_frame_id;
  double timestamp_in_second;
  uint64_t timestamp_in_microsecond;
  PointCloudXYZIBT::ConstPtr cloud;            // CPU 点云
  Eigen::Affine3d lidar2world_pose;
  deeproute::os::hpc_hal::Buffer<PointXYZIBT> cloud_gpu;  // GPU 点云(HAL Buffer)
  int max_pc_points = 0;
  ...
};
```

## 3. 核心处理流程与函数调用链

**一句话结论**：点云之旅＝搬砖（shm 零拷贝→PCL）→ 整队（补偿/剔本车/ROI）→ 体检（采样/体素化）→ 会诊（uni_model 激光分支）→ 解码（heatmap→3D 框）→ 组队（OCC 静态物+融合）。

**点云整理的名词注解**：「整队」中的运动补偿用了位姿**插值**——在两帧定位之间按时间插出扫描时刻的位姿（插值原理见[**采样与插值**](../../../../正典阁/技术栈/AI/采样与插值.md)）；「体检」中的采样是**降采样**（点太多算不动，按距离比例稀疏化）；体素化把散点装进规则格子，是点云进[**神经网络**](../../../../正典阁/技术栈/AI/神经网络与推理引擎.md)前的标准整形。

### 3.1 从 shm 到 lidar 子图

```mermaid
graph TB
    A[combined_point_cloud_proto
shm pool 12路之一] --> B[FrameSyncCalculator]
    B --> C[PerceptionInputTransformCalculator]
    C --> D[PerceptionInputProcessCalculator
PrepareLidarInputs]
    D --> E[LidarInputsWrapper
ProtoToPCL]
    E --> F[LidarPointCheckCalculator
运动补偿+fake points+SetData]
    F --> G[LidarPointEgoCarCalculator]
    G --> H[LidarRoiFilterCalculator]
    H --> I[LidarDetectionPreProcessCalculator
DetectorPreProcessor H2D+采样]
    I --> J[lidar_backbone_network_input]
    J --> K[unimodel_lidar_preprocess]
    K --> L[uni_model 统一大模型推理]
    L --> M[fusion_detection_network_output
heatmap/reg/dim/rot/vel/...]
    M --> N[LidarDetectionProcessCalculator
DetectorPostProcessor 解码]
    N --> O[LidarDetectionPostProcessCalculator]
    O --> P[LidarRainRefineCalculator]
    P --> Q[LidarFusionPreProcessCalculator]
    Q --> R[LidarOccupancyCalculator
+uni_model OCC 头]
    R --> S[LidarFusionProcessCalculator
LidarObjectFusion]
    S --> T[lidar_process_output
LidarOutputsWrapper → tracker]
```

**图 3-1 · 点云从 shm 到 lidar_process_output 的完整链路**（A→T 自上而下，L 是唯一一次 NN 推理）

**读图提示**：① F/G/H 三连是「整队」——补偿（修齐扫描时差）、剔本车点（抹掉自车回波）、ROI 过滤（只留关注区）；② I→K 是 CPU→GPU 的交接点，体素化在 GPU 上完成；③ R 节点不只吃本链数据，还吃 uni_model 的 BEV 头（static_bev/ground_bev）——静态物与检测目标在这里合流。

**点云进入点（已验证）**：`PerceptionInputProcessCalculator::PrepareLidarInputs()` 把 proto 点云转 PCL：

> 文件路径：/sandbox/perception/perception/calculators/perception_input_process_calculator.cc  
> 函数名：PerceptionInputProcessCalculator::PrepareLidarInputs()  
> 核心逻辑：
> 
> ```cpp
> uint64_t timestamp =
>     input->point_cloud->header().timestamp_sec() * 1'000'000.0;
> ...
> PointCloudXYZIBT cloud;
> // 预留额外空间以容纳下游 lidar_point_check_calculator 插入的 fake points，
> // 避免后续 insert 时触发 vector reallocation（拷贝全部点云，~0.5ms 开销）。
> cloud.reserve(`static_cast<size_t>`(input->point_cloud->width()) *
>                   input->point_cloud->height() +
>               kFakePointsHeadroom);
> deeproute::common::ProtoToPCL(*(input->point_cloud), cloud);
> boost::shared_ptr&lt;PointCloudXYZIBT> cloud_ptr =
>     boost::make_shared&lt;PointCloudXYZIBT>(std::move(cloud));
> ...
> lidar_inputs.pcd = cloud_ptr;
> ```
> 
> 逻辑说明：输入 topic `/sensors/lidar/combined_point_cloud_proto` 属于 `kInShmpoolTopics`（perception_input_transform_calculator.cc L79\~80），即点云经共享内存池零拷贝读取；此处转为 PCL `PointCloudXYZIBT` 并封装 `LidarInputsWrapper`。

### 3.2 点云预处理入口（补偿 + GPU 上传）

> 文件路径：/sandbox/perception/submodules/lidar/lidar/onboard/calculators/lidar_point_check_calculator.cc  
> 函数名：LidarPointCheckCalculator::Process()  
> 核心逻辑：
> 
> ```cpp
> // lidar compensate（按定位位姿插值做运动补偿）
> if (use_lidar_compensation_ && !should_skip_compensation) {
>   localization_pose_.InsertValue(
>       lidar_algo_input.timestamp_in_microsecond, pose_tf);
>   if (!common::CompensateByPoseInterpolator(
>           localization_pose_, *lidar_algo_input.vehicle_to_sensing,
>           lidar_algo_input.pcd.get())) {
>     MLOG(WARN) << "Point cloud compensation failed ... skip this point cloud";
>   }
> }
> //@gaoxiang fake points insert at front, padding in here?
> lidar_algo_input.pcd->insert(lidar_algo_input.pcd->begin(),
>                              fake_pcd_.begin(), fake_pcd_.end());
> process_input_->SetData(lidar_algo_input.lidar_frame_id,
>                         lidar_algo_input.timestamp_in_microsecond,
>                         lidar_algo_input.pcd,
>                         lidar_algo_input.tf->GetAffineTransform());
> ```
> 
> 逻辑说明：输出 `base::LidarAlgoProcessInput*`。fake points 为 21 个车前固定点（Open() 中构造 `PointXYZIBT{x,0,0,0,0,0}`，L106\~110），用于空点云兜底。`SetData`（lidar_context.h L40\~58）在点数超限时按 1.5 倍扩容 `cloud_gpu` HAL Buffer。

### 3.3 检测预处理（H2D 拷贝 + 采样）

> 文件路径：/sandbox/perception/submodules/lidar/lidar/modules/detection/detector_pre_processor.cpp  
> 函数名：DetectorPreProcessor::Process()  
> 核心逻辑：
> 
> ```cpp
> num_point_ = input.pc_num;
> pc_gpu_ = input.cloud_gpu;
> ...
> const bool should_rotate =
>     (ground_height_level == lidar::GroundHeightLevel::kTooHigh) ||
>     (ground_height_level == lidar::GroundHeightLevel::kTooLow);
> if (should_rotate) {
>   // 地面高度异常时，绕 y 轴旋转 ±rotate_angle_ 再上传（坡道自适应）
>   pc_gpu_.CopyFrom(rotate_pc_cpu_buffer_.data(), 0,
>                    sizeof(PointXYZIBT) * n, *cuda_stream_);
> } else {
>   pc_gpu_.CopyFrom(pcd_ptr->points.data(), 0,
>                    sizeof(pcd_ptr->points[0]) * pcd_ptr->points.size(),
>                    *cuda_stream_);                        // CPU→GPU
> }
> if (use_sweeps_) { valid_num_point_ = InputSweepDataProvider(); } // 多帧累积
> else            { valid_num_point_ = InputDataProvider(); }
> ```
> 
> 逻辑说明：随后 `LidarDetectionPreProcessCalculator::Process` 把三个 GPU buffer 组装为 NN 输入节点：`filter_pc{1,N,5}`、`idx_info{1,N,4}`、`cur_frame_mask_within_range{N}`（lidar_detection_preprocess_calculator.cc L114\~136），经 `lidar_backbone_network_input` 流入 `unimodel_lidar_preprocess`（graph_l2avp.cfg L622\~659）。

### 3.4 检测后处理（解码 + 语义回填）

> 文件路径：/sandbox/perception/submodules/lidar/lidar/modules/detection/detector_post_processor.cpp  
> 函数名：DetectorPostProcessor::GetObjects()  
> 核心逻辑：
> 
> ```cpp
> // 1) 语义点回填：把稀疏化采样点的语义结果按 pc_inv_map_ 写回原始点云
> cuda_utils::MapToOriginOffsets(cuda_stream_.`GetStream<cudaStream_t>`(),
>     num_point_, valid_num_point_,
>     output_semantic_.GetPtr(), output_point_offset_.GetPtr(),
>     output_front_.GetPtr(), pc_semantics_pin_.data(),
>     pc_offsets_.GetPtr(), pc_fronts_.GetPtr(), pc_inv_map_.GetPtr());
> ...
> // 2) heatmap 解码为 3D 框（CUDA kernel，含分类分数/盲区/远近阈值过滤）
> cuda_utils::BoxesDecode(
>     cuda_stream_.`GetStream<cudaStream_t>`(), map_size_, output_map_height_,
>     output_heatmap_.GetPtr(), output_subtype_heatmap_.GetPtr(),
>     output_offset_.GetPtr(), output_dim_.GetPtr(), output_rot_.GetPtr(),
>     output_height_.GetPtr(), output_velocity_.GetPtr(), output_head_.GetPtr(),
>     class_score_thresh_.GetPtr(), class_score_range_.GetPtr(),
>     class_score_is_blind_.GetPtr(), ...);
> ```
> 
> 逻辑说明：`LidarDetectionProcessCalculator::Process` 先从 `fusion_detection_network_output` 的 13+ 个节点按序取出 GPU 指针填入 `network_output_`（lidar_detection_process_calculator.cc L148\~194），再调 `DetectorPostProcessor::Process()`；解码后的目标经 `AssembleResultToLidarFrame(...)` 打包目标点云（L203\~206），遮挡属性过滤后输出 `SEMANTED_OBJECTS`。

### 3.5 静态物/OCC 与融合输出

`LidarOccupancyCalculator::Process` 从 uni_model 输出取 `static_bev_pred_`/`static_bev_sem_pred_`/`ground_bev_pred_`/`cstr_bev_longrange_pred_`（lidar_occupancy_calculator.cc L251\~256），调用 `occupancy_->Process(...)`（gridmap 实现，L327\~340）产出 `lidar_grid_map_static_objects`。`LidarFusionProcessCalculator::Process` 最终调 `lidar_fusion_->Process(process_input->cloud, *invisible_objects, *motion_probs, *static_objects, *segmented_objects, *semantic_flags)`（lidar_fusion_process_calculator.cc L248\~250），打包 `LidarOutputsWrapper` 发布 `ALGO:lidar_process_output`。

## 4. 核心算法入口与关键逻辑

**一句话结论**：性能关键点全在 GPU——CUDA 采样/解码/回填一条龙，CPU 只负责调度与融合决策；表里「NMS 说明」一行是本篇少有的推断项（无显式 NMS 调用）。

| 环节 | 入口 | 关键逻辑（证据见第 3/6 章） |
|-|-|-|
| 运动补偿 | `LidarPointCheckCalculator::Process` | `CompensateByPoseInterpolator` 按位姿插值补偿扫描期间自车运动；高优先级道路+特定车型（LP/DE）可跳过（L84\~99, L127\~145） |
| 采样 | `DetectorPreProcessor::InputDataProvider/InputSweepDataProvider` | `PointSampler::PointsSampleGPU` 按 `distance_score_ratio_`/`max_distance_` 降采样，多帧 sweep 支持经 `LiDARCache` 缓存（detector_pre_processor.hpp L124\~132） |
| NN 推理 | 主图 `uni_model`（NNInternalCalculator） | 激光输入 `voxel_inputs/unq_pillar_coords/unq_voxel_coords/voxel_overall_mask/cur_idx_info`（graph_l2avp.cfg L213\~217） |
| 解码 | `DetectorPostProcessor::GetObjects` | CUDA `BoxesDecode`：heatmap→中心偏移/尺寸/朝向/速度，按类别分数阈值+盲区模式过滤 |
| NMS 说明 | — | lidar 侧未见显式 CPU/GPU NMS 调用（与 camera 不同）；目标去重依赖 heatmap 峰值解码 + 类别分数阈值（推断，依据 BoxesDecode 参数表与后处理代码中无 nms 关键字；未验证 kernel 内部实现） |
| 语义回填 | `MapToOriginOffsets` | 稀疏点语义→全量点云 `semantic_flags`，供 gridmap/rain_refine 使用 |
| 输出融合 | `LidarObjectFusion` | 检测目标 + 静态物 + 不可见目标按来源融合；连续 30 帧空目标告警（lidar_fusion_process_calculator.cc L237\~246） |

## 5. 输入输出数据结构

**一句话结论**：一条点云的形态变迁：proto（shm 零拷贝）→ PCL CPU 点云 → GPU HAL Buffer → 13+ 个输出头张量 → LidarOutputsWrapper（目标+语义+运动流+地面参数）。

### 5.1 输入

- Topic：`/sensors/lidar/combined_point_cloud_proto`（多雷达拼合点云，shm pool 读取，见 3.1 节证据）。
- Proto → `PointCloudXYZIBT`（x,y,z,intensity,beam,timestamp）。
- `LidarInputsWrapper` → `LidarAlgoProcessInput`（含 `cloud_gpu`）。
- Side packets：`lidar_config_proto`（标定/安装位姿）、`car_config_proto`、`ground_config_proto`、`lidar_process_param_path`。

### 5.2 中间结构

- `LidarDetectorNetworkInput`：`input_feats{N,5}`、`input_coords{N,4}`、`current_frame_mask{N}`、`valid_num_point`。
- `LidarDecetorPreProcessOutput`：`cloud_gpu`、`pc_inv_map`、`unsample_indice`、`lidar2world_pose` 等（detector_pre_processor.cpp L192\~199）。
- `base::LidarDetectorNetworkOutput`：`heatmap/reg/height/dim/rot/vel/heading/semantic/semantic_score/front/point_offset/subtype/attr/door_attr` 等 GPU 指针（lidar_detection_process_calculator.cc L148\~194 与子图 name_filter 列表一致）。
- `LidarFrame`（base/lidar/lidar_frame.h L21\~66）：`point_flags`、`semantic_flags`、`segmented_objects`、`static_objects`、`invisible_objects`、`motion_probs` 等。

### 5.3 输出

**`LidarOutputsWrapper`**（base/lidar/lidar_basic_type.h L133\~146）：

```cpp
struct LidarOutputsWrapper {
  uint64_t lidar_frame_id;
  uint64_t timestamp_in_microsecond;
  std::shared_ptr<std::vector<base::ObjectPtr>> objects;   // 融合后 3D 目标
  std::shared_ptr<std::vector<base::PointSemanticType>> semantics;  // 点级语义
  std::shared_ptr<std::vector<Eigen::Vector2f>> motion_flows;
  std::shared_ptr<std::vector<Eigen::VectorXf>> ground_plane_params;
  PointCloudXYZIBT::ConstPtr pcd{};
  std::shared_ptr<std::unordered_map<int, base::StatusCode>> status_map;
};
```

打包处：`LidarFusionProcessCalculator::Process`（lidar_fusion_process_calculator.cc L252\~273）。去向：`lidar_process_output` 流入主图 `MultiModalityPreprocessCalculator`（include `lidar/lidar_basic_type.h`，multi_modality_preprocess_calculator.cc L30）与 `PerceptionTrackerProcessCalculator`（LIDAR 输入，perception_tracker_process_calculator.cc L18），最终进入 tracker 模块融合成 `PerceptionObstacles` 输出。

## 6. 代码证据与关键片段

**一句话结论**：证据 A 证明「模型头顺序与拆头配置一一对应」（name_filter 即接口契约），证据 B 证明静态物来源已从「传统聚类」切换为「uni_model BEV 头+点云标志位」。

（第 3 章已给 4 段证据；补充 2 段）

**证据 A：检测后处理计算节点的输入装配（模型头与子图 name_filter 一一对应）**

> 文件路径：/sandbox/perception/submodules/lidar/lidar/onboard/calculators/lidar_detection_process_calculator.cc  
> 函数名：LidarDetectionProcessCalculator::Process()  
> 核心逻辑：
> 
> ```cpp
> network_output_.output_offset = nn_internal_output.nodes.at(0).`GetBuffer<float>`();
> network_output_.output_height = nn_internal_output.nodes.at(1).`GetBuffer<float>`();
> network_output_.output_dim    = nn_internal_output.nodes.at(2).`GetBuffer<float>`();
> network_output_.output_rot    = nn_internal_output.nodes.at(3).`GetBuffer<float>`();
> network_output_.output_velocity = nn_internal_output.nodes.at(4).`GetBuffer<float>`();
> network_output_.output_head   = nn_internal_output.nodes.at(5).`GetBuffer<float>`();
> network_output_.output_heatmap = nn_internal_output.nodes.at(6).`GetBuffer<float>`();
> network_output_.output_semantic = nn_internal_output.nodes.at(7).`GetBuffer<int32_t>`();
> ...
> detector_post_processor_->SetPose(process_input->lidar2world_pose);
> detector_post_processor_->Process(network_output_, detection_preprocess_output);
> AssembleResultToLidarFrame(
>     process_input->cloud, process_input->timestamp_in_second,
>     &segmented_objects_, detection_preprocess_output.objects,
>     pack_object_pointcloud_, min_points_);
> ```
> 
> 逻辑说明：节点顺序与 lidar_sub_graph.cfg L118\~159 的 `uni_model_spliter_fusion_detection_network_output` name_filter 顺序（reg/height/dim/rot/vel/heading/heatmap/point_pred/...）一致；闸机（barrier_gate）头按 `enable_barrier_gate()` 开关挂接（L177\~192）。

**证据 B：OCC 静态物（替代传统地面分割/聚类的静态物来源）**

> 文件路径：/sandbox/perception/submodules/lidar/lidar/onboard/calculators/lidar_occupancy_calculator.cc  
> 函数名：LidarOccupancyCalculator::Process()  
> 核心逻辑：
> 
> ```cpp
> static_bev_pred_      = nn_output.nodes.at(0).`GetBuffer<float>`();
> static_bev_sem_pred_  = nn_output.nodes.at(1).`GetBuffer<float>`();
> ground_bev_pred_      = nn_output.nodes.at(2).`GetBuffer<float>`();
> cstr_bev_longrange_pred_ = nn_output.nodes.at(3).`GetBuffer<float>`();
> ...
> occupancy_->Process(process_input, static_bev_pred_, road_roi_pred_,
>                     cstr_bev_longrange_pred_, others_bev_longrange_pred_,
>                     static_bev_offset_output_, static_bev_sem_pred_, ground_bev_pred_,
>                     *point_flags, *semantic_flags, *segmented_objects,
>                     motion_probs_, &static_objects_,
>                     traffic_sign_noise, false, barrier_gate_in_range, nullptr);
> ```
> 
> 逻辑说明：输入即 lidar_sub_graph.cfg L83\~115 `occupancy_filter` 拆出的 `static_bev_output/static_bev_subtype_output/ground_bev_output/cstr_bev_output_longrange/...`；OCC/gridmap 结合 GPU BEV 语义与点云标志位（`point_flags`/`semantic_flags`）输出静态目标，闸机状态从全局单例 `BarrierGateStatusManager` 读取实现完全并行（L319\~323 注释）。

---

## 7. FAQ 与自测

**Q1（新手误解）：lidar 子模块里是不是跑着一个独立的雷达检测模型？**
C01 上不是。主检测走 uni_model 激光分支（unimodel_lidar_preprocess 产 voxel 输入，§1.3），lidar 仓做预处理/解码/静态物/融合；仓内 detection 模块保留的是这套链路的工程实现（CUDA 采样与解码），不是独立模型。

**Q2：为什么传统的地面分割/聚类被注释掉了？**
lidar_sub_graph.cfg 中 LidarGroundDetectionCalculator 节点整段被注释（§1.3）——地面高度改由 uni_model 的 ground_bev_output 头 + GroundHeightLevel 状态承担：少一个级联环节、少一处失效点，且 NN 地面估计对坡道更鲁棒（配合 §3.3 的旋转自适应）。

**Q3：lidar 侧怎么去重，没看到 NMS？**
本篇推断：去重依赖 heatmap 峰值解码 + 类别分数阈值（§4 表「NMS 说明」行）——与 camera 侧显式 nms2d 不同，激光分支在解码 kernel 内就按峰值取目标（未验证 kernel 内部实现）。

**Q4：fake points 是什么？为什么要插在点云开头？**
21 个车前固定假点（Open() 时构造，§3.2），空点云时保底让 batch/后续算子不因零点崩溃；插在开头是历史实现（代码注释 "insert at front"），预留空间避免 vector 扩容拷贝（§3.1 证据的 reserve 注释）。

**自测**（答案在缩进行里）：
1. 点云进入 uni_model 前的三个 GPU 输入是什么？
    答：filter_pc{1,N,5}、idx_info{1,N,4}、cur_frame_mask_within_range{N}（§3.3 逻辑说明）。
2. 地面高度信息现在从哪里来？坡道异常时怎么处理？
    答：uni_model 的 ground_bev_output 头 + GroundHeightLevel 状态；过高/过低时绕 y 轴旋转 ±rotate_angle_ 再上传（§1.3、§3.3）。
3. lidar_process_output 里都装了什么？去向是谁？
    答：融合后 3D 目标、点级语义、运动流、地面参数（LidarOutputsWrapper，§5.3）；流入 MultiModalityPreprocessCalculator 与 tracker。

### 附：关键文件索引

| 文件 | 作用 |
|-|-|
| `cfg/graphs/lidar_sub_graph.cfg` | LidarOccProcessSubgraph 子图（节点编排） |
| `onboard/calculators/lidar_point_check_calculator.cc` | 点云入口：补偿/fake points |
| `onboard/calculators/lidar_detection_preprocess_calculator.cc` | 检测预处理节点 |
| `modules/detection/detector_pre_processor.{hpp,cpp}` | 采样/体素化（CUDA） |
| `modules/detection/detector_post_processor.{hpp,cpp}` | 解码/语义回填/组装 |
| `onboard/calculators/lidar_occupancy_calculator.cc` | OCC/gridmap 静态物 |
| `onboard/calculators/lidar_fusion_process_calculator.cc` | 融合与输出打包 |
| `onboard/calculators/lidar_rain_refine_calculator.cc` | 雨雾修正 |
| `/sandbox/perception/submodules/base/lidar/lidar_frame.h` | 帧级数据结构 |
| `/sandbox/perception/submodules/base/lidar/lidar_context.h` | 算法输入结构 |

（全文约 5200 字）
